// Audio in, transcript events out.
//
// Input: the capture wire format on a WebSocket. The first message is a text
// hello `{"type":"hello","sample_rate":N,"frame_ms":M}`. Every later message
// is a binary frame: one channel byte (0 = mic, 1 = tab) then pcm16le samples.
//
// Output: one S0 TranscriptEvent per partial and per final, from one OpenAI
// Realtime transcription session per channel. The session model does its own
// turn detection here, by audio energy: a turn ends after `silenceMs` of quiet
// below `thresholdDb`, or after `maxTurnMs` of speech.
//
// Timing. `posMs` is the audio clock: ms of audio sent so far on a channel.
// Every append records (pos, wall), so any audio position maps back to the
// wall-clock instant at which that audio left this process. The latency of a
// final is the wall time of its `completed` event minus the wall time at
// which the last loud frame of the turn was sent.
import WebSocket, { WebSocketServer } from "ws";
import type { Channel, TranscriptEvent } from "../contracts/schema.ts";

export const REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
export const PCM_RATE = 24_000;
export const DEFAULT_CAPTURE_PORT = 8787;
export const DEFAULT_TRANSCRIBE_MODEL = "gpt-live-transcribe";

/** Channel byte in a capture frame. */
const CHANNEL_BY_BYTE: Channel[] = ["me", "them"];

export type TurnOpts = {
  /** A frame with RMS above this is speech. dBFS. */
  thresholdDb: number;
  /** Quiet after speech that ends a turn. */
  silenceMs: number;
  /** A turn that runs this long is committed at once. */
  maxTurnMs: number;
};

export const DEFAULT_TURN: TurnOpts = { thresholdDb: -45, silenceMs: 500, maxTurnMs: 15_000 };

/** Latency numbers on a final event. All in wall ms. */
export type Latency = {
  /** Last loud frame of the turn, as sent, to the final transcript. The headline number. */
  speech_end_ms: number;
  /** Last loud frame to the commit: the silence wait. */
  vad_ms: number;
  /** Commit to the final transcript: API time only. */
  api_ms: number;
  /** Last loud frame to the first partial. Negative when text arrived during the turn. */
  first_delta_ms: number | null;
  /** Length of the turn's audio. */
  audio_ms: number;
};

export type SessionOpts = {
  channel: Channel;
  apiKey: string;
  model?: string;
  /** Transcription delay setting of the model: minimal, low, medium, high, xhigh. */
  delay?: string;
  turn?: Partial<TurnOpts>;
  onEvent: (e: TranscriptEvent, latency: Latency | null) => void;
  onLog?: (msg: string) => void;
};

type Turn = {
  id: string;
  t_start: number | null;
  t_end: number | null;
  text: string;
  committedWall: number | null;
  firstDeltaWall: number | null;
};

type Commit = { startPos: number; endPos: number; wall: number };

/** One Realtime transcription session for one audio channel. */
export class ChannelSession {
  readonly channel: Channel;
  private readonly model: string;
  private readonly delay: string;
  private readonly turn: TurnOpts;
  private readonly onEvent: SessionOpts["onEvent"];
  private readonly onLog: (msg: string) => void;
  private readonly apiKey: string;

  private ws: WebSocket | null = null;
  private ready = false;
  private posMs = 0;
  private sent: { pos: number; wall: number }[] = [];
  private turns = new Map<string, Turn>();
  /** Commits not yet matched to an `input_audio_buffer.committed` event, in order. */
  private commits: Commit[] = [];
  private lastCommitPos = 0;
  private speaking = false;
  private speechStart = 0;
  private lastLoud = 0;

  constructor(opts: SessionOpts) {
    this.channel = opts.channel;
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_TRANSCRIBE_MODEL;
    this.delay = opts.delay ?? "low";
    this.turn = { ...DEFAULT_TURN, ...opts.turn };
    this.onEvent = opts.onEvent;
    this.onLog = opts.onLog ?? (() => {});
  }

  private sessionConfig() {
    return {
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: PCM_RATE },
            transcription: { model: this.model, delay: this.delay, languages: ["en"] },
            // The live model rejects every turn_detection value but null.
            turn_detection: null,
            noise_reduction: { type: "near_field" },
          },
        },
      },
    };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const ws = new WebSocket(REALTIME_URL, { headers: { Authorization: `Bearer ${this.apiKey}` } });
      this.ws = ws;
      ws.on("open", () => ws.send(JSON.stringify(this.sessionConfig())));
      ws.on("message", (data) => {
        const ev = JSON.parse(data.toString());
        if (ev.type === "session.updated" && !this.ready) {
          this.ready = true;
          this.onLog(`${this.channel}: session ready in ${Date.now() - t0} ms (${this.model}, delay ${this.delay})`);
          resolve();
          return;
        }
        if (ev.type === "error") {
          this.onLog(`${this.channel}: ERROR ${JSON.stringify(ev.error)}`);
          if (!this.ready) reject(new Error(ev.error?.message ?? "session error"));
          return;
        }
        this.handle(ev, Date.now());
      });
      ws.on("error", (e) => {
        this.onLog(`${this.channel}: socket error ${e.message}`);
        if (!this.ready) reject(e);
      });
      ws.on("close", (code) => this.onLog(`${this.channel}: socket closed ${code}`));
    });
  }

  /** Send one chunk of 24 kHz pcm16le mono. */
  append(pcm: Buffer): void {
    if (!this.ready || !this.ws) return;
    this.posMs += (pcm.length / 2 / PCM_RATE) * 1000;
    this.sent.push({ pos: this.posMs, wall: Date.now() });
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
    this.detect(pcm);
  }

  close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }

  /** Energy turn detection on the frame just sent. */
  private detect(pcm: Buffer): void {
    const n = pcm.length >> 1;
    if (!n) return;
    let sumsq = 0;
    for (let i = 0; i < n; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      sumsq += v * v;
    }
    const db = 20 * Math.log10(Math.sqrt(sumsq / n) + 1e-9);
    if (db > this.turn.thresholdDb) {
      if (!this.speaking) {
        this.speaking = true;
        this.speechStart = Math.max(this.lastCommitPos, this.posMs - 300);
      }
      this.lastLoud = this.posMs;
      if (this.posMs - this.speechStart > this.turn.maxTurnMs) {
        this.commit(this.speechStart, this.posMs);
        this.speaking = true;
        this.speechStart = this.posMs;
      }
    } else if (this.speaking && this.posMs - this.lastLoud >= this.turn.silenceMs) {
      this.commit(this.speechStart, this.lastLoud);
      this.speaking = false;
    }
  }

  private commit(startPos: number, endPos: number): void {
    this.commits.push({ startPos, endPos, wall: Date.now() });
    this.lastCommitPos = this.posMs;
    this.ws?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    // Keep the wall map from growing without bound: drop entries before the oldest open commit.
    const floor = this.commits[0]!.startPos - 1000;
    if (this.sent.length > 4000 && this.sent[0]!.pos < floor) this.sent = this.sent.filter((s) => s.pos >= floor);
  }

  /** Wall-clock instant at which audio position `pos` was sent. */
  private wallAt(pos: number): number {
    const s = this.sent;
    let lo = 0;
    let hi = s.length - 1;
    let ans = s.length ? s[s.length - 1]!.wall : Date.now();
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid]!.pos >= pos) {
        ans = s[mid]!.wall;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }

  private turnFor(id: string): Turn {
    let t = this.turns.get(id);
    if (!t) {
      t = { id, t_start: null, t_end: null, text: "", committedWall: null, firstDeltaWall: null };
      this.turns.set(id, t);
    }
    return t;
  }

  private handle(ev: any, wall: number): void {
    switch (ev.type) {
      case "input_audio_buffer.committed": {
        const t = this.turnFor(ev.item_id);
        const c = this.commits.shift();
        if (c) {
          t.t_start = c.startPos;
          t.t_end = c.endPos;
          t.committedWall = c.wall;
        }
        break;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const t = this.turnFor(ev.item_id);
        if (t.firstDeltaWall === null) t.firstDeltaWall = wall;
        t.text += ev.delta ?? "";
        if (t.text.trim()) this.onEvent(this.toEvent(t, false), null);
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const t = this.turnFor(ev.item_id);
        t.text = ev.transcript ?? t.text;
        let latency: Latency | null = null;
        if (t.t_end !== null) {
          const endWall = this.wallAt(t.t_end);
          latency = {
            speech_end_ms: wall - endWall,
            vad_ms: t.committedWall !== null ? t.committedWall - endWall : 0,
            api_ms: t.committedWall !== null ? wall - t.committedWall : 0,
            first_delta_ms: t.firstDeltaWall !== null ? t.firstDeltaWall - endWall : null,
            audio_ms: t.t_end - (t.t_start ?? t.t_end),
          };
        }
        if (t.text.trim()) this.onEvent(this.toEvent(t, true), latency);
        this.turns.delete(ev.item_id);
        break;
      }
      case "conversation.item.input_audio_transcription.failed": {
        this.onLog(`${this.channel}: transcription failed ${JSON.stringify(ev.error)}`);
        this.turns.delete(ev.item_id);
        break;
      }
      default:
        break;
    }
  }

  private toEvent(t: Turn, isFinal: boolean): TranscriptEvent {
    const openStart = this.speaking ? this.speechStart : this.lastCommitPos;
    const t_start = Math.round(t.t_start ?? openStart);
    const t_end = Math.max(t_start, Math.round(t.t_end ?? this.posMs));
    return { text: t.text.trim(), is_final: isFinal, t_start, t_end, channel: this.channel };
  }
}

// ---------------------------------------------------------------------------
// Sample-rate conversion. The extension sends 24 kHz, so this is normally the
// identity. Other rates in the hello get linear interpolation.
// ---------------------------------------------------------------------------

class Resampler {
  private readonly step: number;
  private prev = 0;
  private frac = 0;
  readonly identity: boolean;

  constructor(from: number, to: number) {
    this.step = from / to;
    this.identity = from === to;
  }

  process(buf: Buffer): Buffer {
    if (this.identity) return buf;
    const n = buf.length >> 1;
    const input = new Int16Array(n + 1);
    input[0] = this.prev;
    for (let i = 0; i < n; i++) input[i + 1] = buf.readInt16LE(i * 2);
    const out: number[] = [];
    let pos = this.frac;
    while (pos + 1 <= n) {
      const i = Math.floor(pos);
      const f = pos - i;
      out.push(Math.round(input[i]! * (1 - f) + input[i + 1]! * f));
      pos += this.step;
    }
    this.frac = pos - n;
    this.prev = input[n]!;
    const res = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) res.writeInt16LE(Math.max(-32768, Math.min(32767, out[i]!)), i * 2);
    return res;
  }
}

// ---------------------------------------------------------------------------
// Capture server: the wire format in, events out
// ---------------------------------------------------------------------------

export type CaptureHandlers = {
  onEvent: (e: TranscriptEvent, latency: Latency | null) => void;
  /** The capture socket closed and the last finals have landed. */
  onClose: (stats: CaptureStats) => void;
};

export type CaptureStats = {
  seconds: number;
  frames: Record<Channel, number>;
  finals: Record<Channel, number>;
};

export type CaptureOpts = {
  port?: number;
  apiKey: string;
  model?: string;
  delay?: string;
  turn?: Partial<TurnOpts>;
  /** A capture client connected. Return the handlers for its session. */
  onConnect: (id: string) => CaptureHandlers;
  onLog?: (msg: string) => void;
};

/**
 * Listens for one capture client at a time. A second client ends the first
 * one's session. One session is one connection: the extension stops and starts
 * capture, and every start is a fresh session.
 */
export function startCaptureServer(opts: CaptureOpts): WebSocketServer {
  const port = opts.port ?? DEFAULT_CAPTURE_PORT;
  const log = opts.onLog ?? (() => {});
  const wss = new WebSocketServer({ port });
  let active: WebSocket | null = null;

  wss.on("connection", (ws, req) => {
    const id = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    if (active) {
      log(`[${id}] connected; ending the previous capture`);
      active.terminate();
    }
    active = ws;
    log(`[${id}] capture connected`);
    const handlers = opts.onConnect(id);
    const frames: Record<Channel, number> = { me: 0, them: 0 };
    const finals: Record<Channel, number> = { me: 0, them: 0 };
    let sessions: ChannelSession[] | null = null;
    let resamplers: Resampler[] | null = null;
    let wall0: number | null = null;
    const queue: Buffer[] = [];

    const onEvent = (e: TranscriptEvent, latency: Latency | null) => {
      if (e.is_final) finals[e.channel]++;
      handlers.onEvent(e, latency);
    };

    const handleFrame = (buf: Buffer) => {
      const ch = buf[0]!;
      const channel = CHANNEL_BY_BYTE[ch];
      if (!channel || !sessions || !resamplers) return;
      frames[channel]++;
      sessions[ch]!.append(resamplers[ch]!.process(buf.subarray(1)));
    };

    ws.on("message", async (data, isBinary) => {
      if (!isBinary) {
        let hello: any;
        try { hello = JSON.parse(data.toString()); } catch { return; }
        if (hello?.type !== "hello") return;
        const rate = Number(hello.sample_rate ?? PCM_RATE);
        log(`[${id}] hello: ${rate} Hz, ${hello.frame_ms ?? "?"} ms frames`);
        resamplers = CHANNEL_BY_BYTE.map(() => new Resampler(rate, PCM_RATE));
        sessions = CHANNEL_BY_BYTE.map((channel) =>
          new ChannelSession({
            channel,
            apiKey: opts.apiKey,
            model: opts.model,
            delay: opts.delay,
            turn: opts.turn,
            onEvent,
            onLog: (m) => log(`[${id}] ${m}`),
          }),
        );
        try {
          await Promise.all(sessions.map((s) => s.connect()));
        } catch (e) {
          log(`[${id}] cannot open transcription sessions: ${(e as Error).message}`);
          ws.close();
          return;
        }
        wall0 = Date.now();
        while (queue.length) handleFrame(queue.shift()!);
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!sessions || wall0 === null) { queue.push(buf); return; }
      handleFrame(buf);
    });

    ws.on("close", async () => {
      if (active === ws) active = null;
      if (sessions) {
        // Let the last finals land before the sessions close.
        await new Promise((r) => setTimeout(r, 4000));
        sessions.forEach((s) => s.close());
      }
      const seconds = wall0 ? (Date.now() - wall0) / 1000 : 0;
      log(`[${id}] capture closed after ${seconds.toFixed(0)} s; me ${frames.me} frames / ${finals.me} finals, them ${frames.them} frames / ${finals.them} finals`);
      handlers.onClose({ seconds, frames, finals });
    });
  });

  return wss;
}
