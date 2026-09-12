// The server: transcriber, pipeline, and panel fan-out in one process.
//
//   npm run server                                   # listen for the extension on :8787
//   npm run server -- --events out/take1.transcript.jsonl --rate 1
//   npm run server -- --events FILE --rate 0 --mock  # unpaced, fake extractor, no key
//
//   --events FILE       replay a transcript log (finals with latency, partials) instead of listening
//   --rate R            replay pace: 1 real time, 0 unpaced (default 1)
//   --mock [FILE]       fake extractor: cycle the op batches of FILE, or of contracts/fixtures/ops.jsonl
//   --dismiss-after K   dismiss after call K
//   --start panel|now   replay: start when the first panel connects, or at once (default: panel, or now when rate is 0)
//   --name N            session name for out/N.log.jsonl and out/N.mmd (default: file stem, or live-<stamp>)
//   --out DIR           output directory (default out)
//   --port P            panel WebSocket port (default 8791)
//   --capture-port P    extension WebSocket port (default 8787)
//   --silence-ms N      turn ends after N ms of quiet (default 500)
//   --threshold-db N    speech is above N dBFS (default -45)
//   --max-turn-ms N     forced commit after N ms of speech (default 15000)
//   --delay D           transcription delay: minimal, low, medium, high, xhigh (default low)
//
// The panel's Reset button ends the session, writes its files, and starts a
// fresh one. Live: the capture stays connected, so the extension needs no
// click. Replay: the file plays again from the top as the next take.
//
// Env (.env at the repo root): OPENAI_API_KEY for transcription and, with
// LLM_MODEL, for the extractor. See extractor/provider.ts for LLM_* names.
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { OpBatch, TranscriptEvent, type LogEntry, type Op } from "../contracts/schema.ts";
import { stateToMermaid } from "../extractor/mermaid.ts";
import { configFromEnv } from "../extractor/provider.ts";
import { Pipeline, type CallRecord, type Extractor } from "./pipeline.ts";
import { DEFAULT_PANEL_PORT, type PanelMsg, type ServerMsg, type Wall } from "./protocol.ts";
import { DEFAULT_CAPTURE_PORT, DEFAULT_TURN, startCaptureServer, type Latency } from "./transcriber.ts";

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  /* no .env file; the environment must carry the keys */
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string, def?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : def;
};
const has = (name: string) => argv.includes(`--${name}`);

if (has("help")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}

const panelPort = Number(flag("port", String(DEFAULT_PANEL_PORT)));
const capturePort = Number(flag("capture-port", String(DEFAULT_CAPTURE_PORT)));
const eventsFile = flag("events");
const rate = Number(flag("rate", "1"));
const mock = has("mock") ? flag("mock", "fixture")! : null;
const dismissAfter = Number(flag("dismiss-after", "0"));
const startOn = flag("start", rate > 0 ? "panel" : "now");
const outDir = flag("out", "out")!;
const nameFlag = flag("name");
const delay = flag("delay", "low")!;
const turn = {
  thresholdDb: Number(flag("threshold-db", String(DEFAULT_TURN.thresholdDb))),
  silenceMs: Number(flag("silence-ms", String(DEFAULT_TURN.silenceMs))),
  maxTurnMs: Number(flag("max-turn-ms", String(DEFAULT_TURN.maxTurnMs))),
};

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const pctl = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

function makeExtractor(): Extractor {
  if (mock) {
    const path = mock === "fixture" ? fileURLToPath(new URL("../contracts/fixtures/ops.jsonl", import.meta.url)) : mock;
    const batches: Op[][] = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => OpBatch.parse(JSON.parse(l)).ops);
    console.log(`extractor: mock, ${batches.length} batches from ${mock === "fixture" ? "contracts/fixtures/ops.jsonl" : mock}`);
    return { kind: "mock", batches };
  }
  const cfg = configFromEnv();
  if (!cfg.model) cfg.model = "gpt-4.1-mini";
  if (!cfg.apiKey) {
    console.error("no API key: set OPENAI_API_KEY (or LLM_API_KEY) in .env, or pass --mock");
    process.exit(2);
  }
  console.log(`extractor: ${cfg.model} @ ${cfg.baseUrl}`);
  return { kind: "llm", cfg };
}

const extractor = makeExtractor();

// ---------------------------------------------------------------------------
// Replay source
// ---------------------------------------------------------------------------

type Timed = { e: TranscriptEvent; at: number };

/**
 * A transcript log: one TranscriptEvent per line, finals with a `latency`
 * object. Arrival is t_end plus the measured ASR latency, so a replay gives
 * the batcher what it saw live. Lines that are not events are skipped.
 */
function loadEvents(path: string): { name: string; events: Timed[]; finals: number; skipped: number } {
  const events: Timed[] = [];
  let finals = 0;
  let skipped = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    const latency = obj.latency;
    delete obj.latency;
    const r = TranscriptEvent.safeParse(obj);
    if (!r.success) {
      skipped++;
      continue;
    }
    const asr = r.data.is_final ? Math.max(0, Number(latency?.speech_end_ms ?? 0)) : 0;
    if (r.data.is_final) finals++;
    events.push({ e: r.data, at: r.data.t_end + asr });
  }
  events.sort((a, b) => a.at - b.at);
  return { name: basename(path).replace(/\.jsonl$/, ""), events, finals, skipped };
}

// ---------------------------------------------------------------------------
// Sessions and fan-out
// ---------------------------------------------------------------------------

type Session = {
  name: string;
  pipeline: Pipeline;
  backlog: LogEntry[];
  wall0: number;
  ended: boolean;
  /** Wall stamps per final, keyed by channel and time. */
  walls: Map<string, { speech_end?: number; final_arrived: number }>;
  transcript?: WriteStream;
  asr: number[];
};

const panels = new Set<WebSocket>();
let current: Session | null = null;
let onFirstPanel: (() => void) | null = null;
const sourceName = eventsFile ? `replay ${basename(eventsFile)}` : `live :${capturePort}`;

const send = (ws: WebSocket, m: ServerMsg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
};
const broadcast = (m: ServerMsg) => {
  for (const ws of panels) send(ws, m);
};
const keyOf = (e: TranscriptEvent) => `${e.channel}|${e.t_start}|${e.t_end}`;

function newSession(name: string, pipelineRate: number): Session {
  const s: Session = {
    name,
    pipeline: null as unknown as Pipeline,
    backlog: [],
    wall0: Date.now(),
    ended: false,
    walls: new Map(),
    asr: [],
  };
  s.pipeline = new Pipeline({
    extractor,
    batcher: { rate: pipelineRate },
    onLog: (entry, call) => {
      if (current !== s) return;
      let wall: Wall | undefined;
      if (call) {
        const last = call.batch.events[call.batch.events.length - 1]!;
        const w = s.walls.get(keyOf(last));
        wall = { sent: Date.now(), ...(w?.speech_end ? { speech_end: w.speech_end } : {}), ...(w ? { final_arrived: w.final_arrived } : {}) };
      }
      s.backlog.push(entry);
      broadcast({ kind: "log", entry, wall });
    },
    onCall: (r: CallRecord) => {
      const active = r.state.diagrams.find((d) => d.diagram_id === r.state.active);
      const last = r.batch.events[r.batch.events.length - 1]!;
      const w = s.walls.get(keyOf(last));
      console.log(
        `call ${String(r.call).padStart(3)}  ${mmss(r.batch.fire_at_ms)}  ${r.batch.cause.padEnd(10)}` +
          ` events ${String(r.batch.cursor_start + 1).padStart(3)}-${String(r.batch.cursor_end).padEnd(3)}` +
          ` ${String(r.ops.length).padStart(2)} ops${r.rejected.length ? ` (${r.rejected.length} rej)` : ""}` +
          ` ${String(r.latency_ms).padStart(5)} ms${r.queued_ms > 50 ? ` (+${r.queued_ms} queued)` : ""}` +
          `  -> ${active ? `${active.nodes.length}n/${active.edges.length}e` : "no diagram"}` +
          `${w?.speech_end ? `  speech end -> logged ${Date.now() - w.speech_end} ms` : ""}` +
          `${r.parse_error ? `  !! ${r.parse_error}` : ""}`,
      );
      if (dismissAfter && r.call === dismissAfter) {
        s.pipeline.dismiss();
        console.log(`      dismiss after call ${r.call}`);
      }
    },
  });
  current = s;
  broadcast({ kind: "hello", source: sourceName, rate: pipelineRate, backlog: [] });
  return s;
}

function finish(s: Session, wallMs: number): void {
  s.ended = true;
  const p = s.pipeline;
  const calls = p.calls;
  const lat = calls.map((c) => c.latency_ms).filter((x) => x > 0);
  const noop = calls.filter((c) => c.ops.length === 0).length;
  const rejected = calls.reduce((a, c) => a + c.rejected.length, 0);
  const queued = calls.filter((c) => c.queued_ms > 50);
  const causes = new Map<string, number>();
  for (const c of calls) causes.set(c.batch.cause, (causes.get(c.batch.cause) ?? 0) + 1);
  const active = p.state.diagrams.find((d) => d.diagram_id === p.state.active);
  const finals = p.log.filter((l) => l.event.kind === "transcript").length;

  console.log(`\n${s.name}: ${(wallMs / 1000).toFixed(1)} s wall`);
  console.log(`  transcript events  ${finals}`);
  console.log(`  calls              ${calls.length}  fired by ${[...causes].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`  no-op calls        ${noop}`);
  console.log(`  ops rejected       ${rejected}`);
  if (p.errors.length) console.log(`  pipeline errors    ${p.errors.length}: ${p.errors.map((e) => `c${e.call} ${e.message}`).join("; ")}`);
  console.log(`  extractor p50/p90  ${pctl(lat, 50)} / ${pctl(lat, 90)} ms`);
  console.log(`  calls that queued  ${queued.length}${queued.length ? ` (max ${Math.max(...queued.map((c) => c.queued_ms))} ms)` : ""}`);
  if (s.asr.length) console.log(`  ASR p50/p90        ${pctl(s.asr, 50)} / ${pctl(s.asr, 90)} ms speech end to final, n=${s.asr.length}`);
  console.log(`  diagrams           ${p.state.diagrams.length}, active ${active ? `${active.diagram_id} ${active.nodes.length}n/${active.edges.length}e` : "none"}`);
  for (const d of p.state.diagrams) console.log(`    ${d.diagram_id}${d.title ? ` "${d.title}"` : ""}: ${d.nodes.map((n) => n.label).join(", ") || "(empty)"}`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/${s.name}.log.jsonl`, p.log.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(`${outDir}/${s.name}.mmd`, stateToMermaid(p.state) + "\n");
  s.transcript?.end();
  console.log(`  wrote ${outDir}/${s.name}.log.jsonl (${p.log.length} entries), ${outDir}/${s.name}.mmd${s.transcript ? `, ${outDir}/${s.name}.transcript.jsonl` : ""}`);
  if (current === s) broadcast({ kind: "end", reason: "source finished" });
}

const wss = new WebSocketServer({ port: panelPort });
wss.on("connection", (ws, req) => {
  panels.add(ws);
  console.log(`panel connected from ${req.socket.remoteAddress} (${panels.size} open)`);
  send(ws, { kind: "hello", source: sourceName, rate: eventsFile ? rate : 1, backlog: current?.backlog ?? [] });
  if (current?.ended) send(ws, { kind: "end", reason: "source finished" });
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let m: PanelMsg;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.kind === "reset") {
      console.log("      reset from panel");
      void reset();
      return;
    }
    if (!current || current.ended) return;
    if (m.kind === "dismiss") {
      console.log("      dismiss from panel");
      current.pipeline.dismiss("panel");
    } else if (m.kind === "snapshot") {
      const id = current.pipeline.snapshot("panel");
      console.log(`      snapshot from panel${id ? ` (${id})` : " (nothing active)"}`);
    }
  });
  ws.on("close", () => panels.delete(ws));
  if (onFirstPanel) {
    const f = onFirstPanel;
    onFirstPanel = null;
    f();
  }
});
console.log(`panels: ws://localhost:${panelPort}`);
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

// A reset from a panel. Replay: the file plays again as the next take, and a
// take still in progress stops at its next event. Live: the running session
// ends and a fresh one takes over the same capture connection.
let resetReplay: (() => Promise<void>) | null = null;
let resetLive: (() => Promise<void>) | null = null;
async function reset(): Promise<void> {
  if (resetReplay) await resetReplay();
  else if (resetLive) await resetLive();
  else console.log("      reset: no capture connected, nothing to reset");
}

async function replay(path: string): Promise<void> {
  const src = loadEvents(path);
  const base = nameFlag ?? src.name;
  let generation = 0;
  let take = 0;

  const run = async (): Promise<void> => {
    const gen = ++generation;
    const name = ++take === 1 ? base : `${base}-take${take}`;
    console.log(
      `${src.name}: ${src.events.length} events (${src.finals} final)${src.skipped ? `, ${src.skipped} other lines skipped` : ""}, ` +
        `rate ${rate > 0 ? `${rate}x` : "unpaced"}; ${take > 1 ? `take ${take}` : startOn === "panel" && panels.size === 0 ? "waiting for a panel" : "starting now"}`,
    );
    if (take === 1 && startOn === "panel" && panels.size === 0) await new Promise<void>((r) => { onFirstPanel = r; });
    const s = newSession(name, rate);
    const wall0 = Date.now();
    let stopped = false;
    for (const { e, at } of src.events) {
      if (rate > 0) {
        const wait = wall0 + at / rate - Date.now();
        if (wait > 0) await sleep(wait);
      }
      if (gen !== generation) {
        stopped = true;
        break;
      }
      // At rate 1 the speech ended when the wall clock said t_end. At other
      // rates the number still measures this run, not a real call.
      if (e.is_final) s.walls.set(keyOf(e), { final_arrived: Date.now(), ...(rate > 0 ? { speech_end: wall0 + e.t_end / rate } : {}) });
      s.pipeline.push(e, at);
    }
    await s.pipeline.close();
    if (stopped) console.log(`      ${name} stopped by a reset`);
    finish(s, Date.now() - wall0);
    if (!stopped) console.log("panels stay served; Ctrl-C to stop");
  };

  resetReplay = async () => {
    void run();
  };
  await run();
}

function listen(): void {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set; put it in .env");
    process.exit(2);
  }
  startCaptureServer({
    port: capturePort,
    apiKey,
    delay,
    turn,
    onLog: (m) => console.log(m),
    onConnect: () => {
      const open = (): Session => {
        const s = newSession(nameFlag ? `${nameFlag}-${stamp()}` : `live-${stamp()}`, 1);
        s.transcript = createWriteStream(`${outDir}/${s.name}.transcript.jsonl`);
        console.log(`session ${s.name} started`);
        return s;
      };
      const end = async (s: Session): Promise<void> => {
        await s.pipeline.close();
        finish(s, Date.now() - s.wall0);
        s.transcript?.end();
      };
      let s = open();
      resetLive = async () => {
        const old = s;
        s = open();
        console.log(`      reset: ${old.name} ended, ${s.name} started on the same capture`);
        await end(old);
      };
      return {
        onEvent: (e: TranscriptEvent, latency: Latency | null) => {
          s.transcript?.write(JSON.stringify(latency ? { ...e, latency } : e) + "\n");
          if (e.is_final) {
            const now = Date.now();
            s.walls.set(keyOf(e), { final_arrived: now, ...(latency ? { speech_end: now - latency.speech_end_ms } : {}) });
            if (latency) s.asr.push(latency.speech_end_ms);
            console.log(`${e.channel.padEnd(4)} ${mmss(e.t_start)}-${mmss(e.t_end)} [${latency ? `${latency.speech_end_ms} ms` : "n/a"}] ${e.text}`);
          }
          s.pipeline.push(e);
        },
        onClose: async () => {
          resetLive = null;
          await end(s);
          console.log("waiting for the next capture");
        },
      };
    },
  });
  console.log(`capture: ws://localhost:${capturePort}  (silence ${turn.silenceMs} ms, threshold ${turn.thresholdDb} dBFS, max turn ${turn.maxTurnMs} ms, delay ${delay})`);
}

if (eventsFile) await replay(eventsFile);
else listen();
