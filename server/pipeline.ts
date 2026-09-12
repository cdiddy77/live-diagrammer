// The pipeline. Every source calls `push(event, at_ms)` and nothing else.
// Inside: online batcher -> extractor -> reducer -> append-only log, with
// dismiss -> negative example.
//
// Batches are decided on arrival time in session ms, not on the wall clock,
// so an unpaced replay gives the same batch boundaries as a paced one. The
// only wall-clock part is the silence timer that fires a batch when nothing
// more arrives.
import { z } from "zod";
import {
  DEFAULT_NEGATIVE_EXAMPLE_CALLS,
  ExtractorOutput,
  TranscriptEvent,
  edgeId,
  type CompactDiagram,
  type CompactGraphState,
  type DiagramId,
  type LogEntry,
  type NegativeExample,
  type NodeId,
  type Op,
  type OpBatch,
  type SessionEvent,
} from "../contracts/schema.ts";
import { applyOp, emptyState, type Rejection } from "../contracts/reducer.ts";
import { SYSTEM, buildUser } from "../extractor/prompt.ts";
import { callExtractor, type LlmConfig } from "../extractor/provider.ts";

// ---------------------------------------------------------------------------
// Batcher
// ---------------------------------------------------------------------------

export type BatchCause = "gap" | "max_events" | "max_wait" | "timer" | "flush";

export type Batch = {
  events: TranscriptEvent[];
  /** Index of the first event in the session's sequence of finals. */
  cursor_start: number;
  /** Index after the last event. */
  cursor_end: number;
  /**
   * Session ms at which the batch fired. `max_events` and `max_wait` fire on
   * the arrival that tripped them. The other causes fire one gap after the
   * last activity, which is when the silence timer goes off in a paced run.
   */
  fire_at_ms: number;
  cause: BatchCause;
};

export type BatcherOpts = {
  /** Silence after the last activity that closes a batch. */
  gapMs?: number;
  maxEvents?: number;
  /** Longest speech span in one batch: first t_start to last t_end. */
  maxWaitMs?: number;
  /** Source speed against the wall clock. 1 is real time. 0 disables the timer. */
  rate?: number;
};

export const DEFAULT_BATCHER: Required<BatcherOpts> = { gapMs: 1500, maxEvents: 12, maxWaitMs: 8000, rate: 1 };

/**
 * Groups finals into batches by arrival time. A partial holds the open batch
 * and re-arms the silence timer, but never joins a batch: the extractor sees
 * finals only.
 */
export class OnlineBatcher {
  private held: TranscriptEvent[] = [];
  private heldStart = 0;
  private finals = 0;
  private lastAt = -Infinity;
  private timer: NodeJS.Timeout | null = null;
  private readonly o: Required<BatcherOpts>;

  constructor(private readonly onBatch: (b: Batch) => void, opts: BatcherOpts = {}) {
    this.o = { ...DEFAULT_BATCHER, ...opts };
  }

  /** @param at arrival time in session ms. */
  push(e: TranscriptEvent, at: number): void {
    if (this.held.length && at - this.lastAt >= this.o.gapMs) this.fire("gap");
    this.lastAt = at;
    if (!e.is_final) {
      if (this.held.length) this.arm();
      return;
    }
    if (!this.held.length) this.heldStart = this.finals;
    this.held.push(e);
    this.finals++;
    if (this.held.length >= this.o.maxEvents) this.fire("max_events");
    else if (e.t_end - this.held[0]!.t_start >= this.o.maxWaitMs) this.fire("max_wait");
    else this.arm();
  }

  /** End of stream: fire what is held. */
  flush(): void {
    this.fire("flush");
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.o.rate <= 0) return;
    this.timer = setTimeout(() => this.fire("timer"), this.o.gapMs / this.o.rate);
  }

  private fire(cause: BatchCause): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.held.length) return;
    const events = this.held;
    this.held = [];
    const tripped = cause === "max_events" || cause === "max_wait";
    this.onBatch({
      events,
      cursor_start: this.heldStart,
      cursor_end: this.finals,
      fire_at_ms: tripped ? this.lastAt : this.lastAt + this.o.gapMs,
      cause,
    });
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type Extractor =
  | { kind: "llm"; cfg: LlmConfig }
  /** A fake extractor: the batches are replayed in a cycle, one per call. */
  | { kind: "mock"; batches: Op[][] };

export type CallRecord = {
  call: number;
  batch: Batch;
  /** Every op the extractor emitted, plus any op the pipeline put in front. */
  ops: Op[];
  rejected: Rejection[];
  latency_ms: number;
  /** Wall ms the batch waited because the previous call was still running. */
  queued_ms: number;
  parse_error?: string;
  state: CompactGraphState;
};

export type PipelineOpts = {
  extractor: Extractor;
  batcher?: BatcherOpts;
  /** Also log partial events. Off by default: the log holds finals only. */
  logPartials?: boolean;
  /** Every log entry, in order. An ops entry comes with its call record. */
  onLog?: (entry: LogEntry, call?: CallRecord) => void;
  onCall?: (r: CallRecord) => void;
  /** A call threw outside the extractor. Default: console.error. */
  onError?: (err: Error, batch: Batch) => void;
};

/**
 * What one call added to the board, for the scoped dismiss. A `mark` is a
 * snapshot or a dismiss: a boundary the dismiss scope never crosses.
 */
type CallStroke = {
  kind: "call";
  /** The diagram that was active when the call ended. */
  diagram_id: DiagramId | null;
  /** The call created that diagram. */
  created: boolean;
  accepted: number;
  nodes: NodeId[];
  edges: { from: NodeId; to: NodeId }[];
  events: TranscriptEvent[];
};
type Stroke = CallStroke | { kind: "mark" };

export class Pipeline {
  state: CompactGraphState = emptyState();
  readonly log: LogEntry[] = [];
  readonly calls: CallRecord[] = [];
  /** Calls that threw outside the extractor. The pipeline keeps going. */
  readonly errors: { call: number; message: string }[] = [];

  private readonly seen: TranscriptEvent[] = [];
  private readonly recentOps: Op[][] = [];
  private negatives: NegativeExample[] = [];
  private readonly strokes: Stroke[] = [];
  private seq = 0;
  /** fire_at_ms of the latest ops entry. See sessionNow(). */
  private lastFire = 0;
  private nCalls = 0;
  private nDismiss = 0;
  private pendingDismiss: { user?: string } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private inFlight = false;
  private wall0: number | null = null;
  private clockOrigin = 0;
  private readonly rate: number;
  private readonly batcher: OnlineBatcher;
  private readonly outputSchema = z.toJSONSchema(ExtractorOutput, { target: "draft-2020-12", io: "output" });

  constructor(private readonly opts: PipelineOpts) {
    this.rate = opts.batcher?.rate ?? DEFAULT_BATCHER.rate;
    this.batcher = new OnlineBatcher((b) => this.enqueue(b), opts.batcher);
  }

  /**
   * The entry point. Validates, logs, batches.
   *
   * `at` is the arrival time in session ms. A replay source passes it: t_end,
   * or t_end plus the measured ASR latency. A live source leaves it out and
   * gets a wall clock, scaled by the rate and anchored at the first event.
   */
  push(raw: unknown, at?: number): TranscriptEvent {
    const e = TranscriptEvent.parse(raw);
    if (this.wall0 === null) {
      this.wall0 = Date.now();
      this.clockOrigin = at ?? e.t_end;
    }
    if (at === undefined) at = this.rate > 0 ? this.clockOrigin + (Date.now() - this.wall0) * this.rate : e.t_end;
    if (e.is_final || this.opts.logPartials) this.append(e.t_end, { kind: "transcript", event: e });
    this.batcher.push(e, at);
    return e;
  }

  /**
   * A participant hit dismiss. Applied after the call in flight, if any, so
   * the parked part is what they saw. See applyDismiss for the scope.
   */
  dismiss(user?: string): void {
    if (this.inFlight) {
      this.pendingDismiss = { user };
      return;
    }
    this.applyDismiss(user);
  }

  /**
   * A participant hit snapshot. The log gets a SnapshotEvent and nothing else.
   * A viewer rebuilds the frozen copy from the log. The snapshot also bounds
   * the next dismiss. Returns the diagram id, or null when nothing is active.
   */
  snapshot(user?: string): DiagramId | null {
    const active = this.activeDiagram();
    if (!active) return null;
    this.append(this.sessionNow(), { kind: "snapshot", diagram_id: active.diagram_id, ...(user ? { user } : {}) });
    this.strokes.push({ kind: "mark" });
    return active.diagram_id;
  }

  /** End of stream. Fires the held batch and waits for every call to finish. */
  async close(): Promise<void> {
    this.batcher.flush();
    await this.queue;
  }

  private activeDiagram(): CompactDiagram | undefined {
    return this.state.diagrams.find((d) => d.diagram_id === this.state.active);
  }

  /**
   * The session clock for things that happen between events. Paced or live:
   * wall ms since the first event, scaled. Unpaced: the fire time of the last
   * call, because the whole transcript may already be in.
   */
  private sessionNow(): number {
    if (this.rate <= 0 || this.wall0 === null) return this.lastFire;
    return Math.max(this.lastFire, this.clockOrigin + (Date.now() - this.wall0) * this.rate);
  }

  private append(t_ms: number, event: SessionEvent, call?: CallRecord): void {
    const entry: LogEntry = { seq: this.seq++, t_ms: Math.max(0, Math.round(t_ms)), event };
    if (event.kind === "ops") this.lastFire = Math.max(this.lastFire, entry.t_ms);
    this.log.push(entry);
    this.opts.onLog?.(entry, call);
  }

  /**
   * The additions to `diagramId` from the newest run of drawing calls. Walk
   * back from the last call, over trailing no-op calls, then collect calls
   * until a no-op call, a snapshot, a dismiss, or the call that created the
   * diagram. A no-op call after the drawing does not move the boundary: the
   * "Right." that ends a tangent is still the tangent.
   */
  private recentDrawing(diagramId: DiagramId) {
    const nodes = new Set<NodeId>();
    const edges = new Set<string>();
    const events: TranscriptEvent[] = [];
    let created = false;
    let calls = 0;
    let i = this.strokes.length - 1;
    while (i >= 0) {
      const s = this.strokes[i]!;
      if (s.kind !== "call" || s.accepted > 0) break;
      i--;
    }
    for (; i >= 0; i--) {
      const s = this.strokes[i]!;
      if (s.kind !== "call" || s.accepted === 0 || s.diagram_id !== diagramId) break;
      // An earlier call joins the scope while most of its edges stay inside
      // the scope. A call whose edges mostly wire into the older board is
      // where the tangent began, so that call and everything before it stay.
      // One stray edge into the old board does not split a tangent.
      if (calls > 0) {
        const inside = (id: NodeId) => nodes.has(id) || s.nodes.includes(id);
        let within = 0;
        let outward = 0;
        for (const e of s.edges) (inside(e.from) && inside(e.to) ? within++ : outward++);
        if (outward > within) break;
      }
      calls++;
      for (const n of s.nodes) nodes.add(n);
      for (const e of s.edges) edges.add(edgeId(e.from, e.to));
      events.unshift(...s.events);
      if (s.created) {
        created = true;
        break;
      }
    }
    return { nodes, edges, events, created, calls };
  }

  /**
   * Park what was drawn since the last snapshot or the last no-op call. The
   * rest of the board stays active. Parking the whole board on every dismiss
   * left the model rewiring old ids, the reducer rejecting every op, and no
   * recovery in ten runs of ten.
   *
   * The parked part goes into the log as ordinary ops: remove it from the
   * active diagram, draw it on a fresh diagram, switch back. Then a
   * DismissEvent parks that fresh diagram. So the log replays through the
   * reducer unchanged, and a viewer finds the parked diagram under the id the
   * DismissEvent names. When the scope covers the whole board, only the
   * DismissEvent is logged and nothing stays active.
   */
  private applyDismiss(user?: string): void {
    this.pendingDismiss = null;
    const active = this.activeDiagram();
    if (!active) return;
    const at = this.sessionNow();
    const scope = this.recentDrawing(active.diagram_id);
    const parkedNodes = active.nodes.filter((n) => scope.nodes.has(n.id));
    const nodeIds = new Set(parkedNodes.map((n) => n.id));
    const parkedEdges = active.edges.filter(
      (e) => nodeIds.has(e.from) || nodeIds.has(e.to) || scope.edges.has(edgeId(e.from, e.to)),
    );
    const whole =
      scope.created ||
      (parkedNodes.length === 0 && parkedEdges.length === 0) ||
      parkedNodes.length === active.nodes.length;
    const transcript = scope.events.length ? scope.events : this.seen.slice(-10);
    const userField = user ? { user } : {};

    if (whole) {
      this.negatives.push({ diagram: active, transcript, dismissed_at_ms: at, calls_remaining: DEFAULT_NEGATIVE_EXAMPLE_CALLS });
      this.append(at, { kind: "dismiss", diagram_id: active.diagram_id, ...userField });
      this.strokes.push({ kind: "mark" });
      this.state = { active: null, diagrams: this.state.diagrams.filter((d) => d.diagram_id !== active.diagram_id) };
      return;
    }

    const loose = parkedEdges.filter((e) => !nodeIds.has(e.from) && !nodeIds.has(e.to));
    const inner = parkedEdges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
    const ops: Op[] = [
      ...loose.map((e): Op => ({ op: "remove", id: edgeId(e.from, e.to) })),
      ...parkedNodes.map((n): Op => ({ op: "remove", id: n.id })),
      { op: "new_diagram", type: active.type, title: null },
      ...parkedNodes.map((n): Op => ({ op: "add_node", id: n.id, label: n.label })),
      ...inner.map((e): Op => ({ op: "add_edge", from: e.from, to: e.to, label: e.label ?? null })),
      { op: "switch_active", diagram_id: active.diagram_id },
    ];
    let state = this.state;
    let parkedId: DiagramId | null = null;
    for (const op of ops) {
      const r = applyOp(state, op);
      if (r.rejected) throw new Error(`dismiss: park op rejected: ${r.rejected.reason}`);
      state = r.state;
      if (op.op === "new_diagram") parkedId = state.active;
    }
    if (!parkedId) throw new Error("dismiss: no parked diagram id");
    const parked = state.diagrams.find((d) => d.diagram_id === parkedId)!;
    const entry: OpBatch = {
      kind: "ops",
      call_id: `dismiss${++this.nDismiss}`,
      transcript_cursor: this.seen.length,
      ops,
      rejected: [],
      latency_ms: 0,
    };
    this.append(at, entry);
    this.append(at, { kind: "dismiss", diagram_id: parkedId, ...userField });
    this.negatives.push({ diagram: parked, transcript, dismissed_at_ms: at, calls_remaining: DEFAULT_NEGATIVE_EXAMPLE_CALLS });
    this.strokes.push({ kind: "mark" });
    this.state = { active: active.diagram_id, diagrams: state.diagrams.filter((d) => d.diagram_id !== parkedId) };
  }

  /**
   * Serial call queue. A throw anywhere in a call must not break the chain:
   * that would skip every later call and leave `inFlight` stuck.
   */
  private enqueue(batch: Batch): void {
    const queuedAt = Date.now();
    this.queue = this.queue.then(() => this.runCall(batch, Date.now() - queuedAt));
  }

  private async runCall(batch: Batch, queued_ms: number): Promise<void> {
    this.inFlight = true;
    const call = ++this.nCalls;
    try {
      await this.runCallBody(call, batch, queued_ms);
    } catch (err) {
      this.report(call, err, batch);
    } finally {
      this.inFlight = false;
      if (this.pendingDismiss) {
        const { user } = this.pendingDismiss;
        try {
          this.applyDismiss(user);
        } catch (err) {
          this.report(call, err, batch);
        }
      }
    }
  }

  private report(call: number, err: unknown, batch: Batch): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.errors.push({ call, message: e.message });
    if (this.opts.onError) this.opts.onError(e, batch);
    else console.error(`call ${call} threw (pipeline continues): ${e.stack ?? e.message}`);
  }

  private async runCallBody(call: number, batch: Batch, queued_ms: number): Promise<void> {
    const newFrom = this.seen.length;
    this.seen.push(...batch.events);

    const user = buildUser({
      state: this.state,
      seen: this.seen,
      newFrom,
      recentOps: this.recentOps,
      negatives: this.negatives,
    });

    let ops: Op[] = [];
    let latency_ms = 0;
    let parse_error: string | undefined;
    if (this.opts.extractor.kind === "mock") {
      const b = this.opts.extractor.batches;
      ops = b.length ? b[(call - 1) % b.length]! : [];
    } else {
      // A network failure (undici's "fetch failed", a reset, a timeout) gets
      // up to two more attempts after a pause. An HTTP error from the
      // endpoint does not: the same request would get the same answer.
      const t0 = Date.now();
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await callExtractor(SYSTEM, user, this.outputSchema, this.opts.extractor.cfg);
          ops = res.ops;
          latency_ms = Date.now() - t0;
          parse_error = res.parse_error;
          break;
        } catch (err) {
          const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
          const message = cause ? `${(err as Error).message}: ${cause.code ?? cause.message}` : (err as Error).message;
          const network = /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket/i.test(message);
          if (network && attempt < 3) {
            // The blips seen live last a second or two, so the second pause is longer.
            await new Promise((r) => setTimeout(r, attempt === 1 ? 500 : 1500));
            continue;
          }
          latency_ms = Date.now() - t0;
          parse_error = attempt > 1 ? `${message} (after retry)` : message;
          break;
        }
      }
    }

    // Recovery after a whole-board dismiss: nothing is active and the model
    // adds a node without a new_diagram op. Open the fresh diagram here, same
    // type as the parked one, and log that op like any other.
    if (
      !this.state.active &&
      ops.some((o) => o.op === "add_node") &&
      !ops.some((o) => o.op === "new_diagram" || o.op === "switch_active")
    ) {
      const parked = this.negatives[this.negatives.length - 1]?.diagram;
      ops = [{ op: "new_diagram", type: parked?.type ?? "flowchart", title: null }, ...ops];
    }

    const stroke: CallStroke = {
      kind: "call",
      diagram_id: this.state.active,
      created: false,
      accepted: 0,
      nodes: [],
      edges: [],
      events: batch.events,
    };
    const rejected: Rejection[] = [];
    const accepted: Op[] = [];
    let state = this.state;
    for (const op of ops) {
      const r = applyOp(state, op);
      if (r.rejected) {
        rejected.push(r.rejected);
        continue;
      }
      state = r.state;
      accepted.push(op);
      if (op.op === "new_diagram" || (op.op === "switch_active" && op.diagram_id !== stroke.diagram_id)) {
        stroke.created = op.op === "new_diagram";
        stroke.nodes = [];
        stroke.edges = [];
      } else if (op.op === "add_node") stroke.nodes.push(op.id);
      else if (op.op === "add_edge") stroke.edges.push({ from: op.from, to: op.to });
      stroke.diagram_id = state.active;
    }
    stroke.accepted = accepted.length;
    this.state = state;

    const entry: OpBatch = {
      kind: "ops",
      call_id: `c${call}`,
      transcript_cursor: batch.cursor_end,
      ops: accepted,
      rejected,
      latency_ms,
    };
    const rec: CallRecord = { call, batch, ops, rejected, latency_ms, queued_ms, parse_error, state };
    this.append(batch.fire_at_ms, entry, rec);
    this.strokes.push(stroke);
    this.recentOps.push(ops);
    this.negatives = this.negatives
      .map((n) => ({ ...n, calls_remaining: n.calls_remaining - 1 }))
      .filter((n) => n.calls_remaining > 0);
    this.calls.push(rec);
    this.opts.onCall?.(rec);
  }
}
