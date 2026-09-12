/**
 * Case emitter for the report card. Brought in from the S4 spike (cases.ts);
 * import paths and the reference directory are the only changes.
 *
 *
 * One case per human-annotated topic segment: the transcript the agent heard,
 * the diagram it had produced by the end of that segment, and the human labels
 * for the same stretch. Writes JSONL that gonogo's Case.from_jsonl reads
 * directly — `input` and `expected` are required, `id` is optional, and every
 * other key lands in `metadata`, so a report can be sliced by meeting, topic,
 * run, or any of the structural counts below.
 *
 *   npx tsx eval/cases.ts --log <session.log.jsonl> \
 *                    --meeting ES2014b --from 05:39 --run v4 > cases.jsonl
 *
 * Segment boundaries come from reference.md, which is the AMI annotators' work,
 * not ours. That is the whole point: the judge is scored against human labels
 * that existed before we had an opinion.
 */
import { readFileSync } from "node:fs";
import {
  LogEntry,
  type CompactGraphState,
  type Op,
  type TranscriptEvent,
} from "../contracts/schema.ts";
import { applyOps, emptyState } from "../contracts/reducer.ts";
import { readReference, segmentTimeline, type Topic } from "./reference.ts";

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : d;
};

const logPath = flag("log");
const meeting = flag("meeting", "ES2014b")!;
const fromStr = flag("from", "00:00")!;
const runLabel = flag("run", "unlabelled")!;
if (!logPath) { console.error("usage: cases.ts --log <session.log.jsonl> --meeting <id> --from MM:SS [--run label]"); process.exit(2); }

const toMs = (t: string) => {
  const p = t.split(":").map(Number);
  return (p.length === 3 ? p[0]! * 3600 + p[1]! * 60 + p[2]! : p[0]! * 60 + p[1]!) * 1000;
};
const offset = toMs(fromStr);
const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

const entries = readFileSync(logPath, "utf8").trim().split(/\n/).map((l, i) => {
  const r = LogEntry.safeParse(JSON.parse(l));
  if (!r.success) throw new Error(`${logPath}:${i + 1} is not a valid LogEntry`);
  return r.data;
});

/** Log times are window-relative; the topic timeline is meeting-absolute. */
const abs = (t_ms: number) => t_ms + offset;

/** Finals only. An S6 log run with --log-partials carries revisions of the same
 *  turn, which would read as stutter in a judge prompt. */
const transcripts = entries.flatMap((e) =>
  e.event.kind === "transcript" && e.event.event.is_final
    ? [{ t: abs(e.t_ms), ev: e.event.event as TranscriptEvent }]
    : [],
);
const opBatches = entries.flatMap((e) =>
  e.event.kind === "ops"
    ? [{ t: abs(e.t_ms), ops: e.event.ops as Op[], rejected: e.event.rejected, latency: e.event.latency_ms }]
    : [],
);

/**
 * Replay to a point in time. Handles dismiss the same way S6's `stateAt` does —
 * park the diagram and clear active — because S0 still has no parked state and
 * two implementations agreeing is the closest thing to a contract we have.
 * Uses `continue`, not `break`: t_ms is not monotonic once partials are logged.
 */
const stateAt = (tAbs: number): CompactGraphState => {
  let s = emptyState();
  for (const e of entries) {
    if (abs(e.t_ms) >= tAbs) continue;
    const ev = e.event;
    if (ev.kind === "ops") s = applyOps(s, ev.ops).state;
    else if (ev.kind === "dismiss") {
      s = { active: null, diagrams: s.diagrams.filter((d) => d.diagram_id !== ev.diagram_id) };
    }
  }
  return s;
};

const activeOf = (s: CompactGraphState) => s.diagrams.find((d) => d.diagram_id === s.active);

function structural(s: CompactGraphState) {
  const d = activeOf(s);
  if (!d) return { nodes: 0, edges: 0, orphans: 0, duplicate_labels: 0 };
  const touched = new Set(d.edges.flatMap((e) => [e.from, e.to]));
  const byLabel = new Map<string, number>();
  for (const n of d.nodes) byLabel.set(n.label, (byLabel.get(n.label) ?? 0) + 1);
  return {
    nodes: d.nodes.length,
    edges: d.edges.length,
    orphans: d.nodes.filter((n) => !touched.has(n.id)).length,
    duplicate_labels: [...byLabel.values()].filter((c) => c > 1).length,
  };
}

const line = (e: TranscriptEvent, t: number) =>
  `[${mmss(t)}] ${e.speaker ?? e.channel}(${e.channel}): ${e.text}`;

const ref = readReference(meeting);
const windowStart = transcripts.length ? transcripts[0]!.t : offset;
const windowEnd = transcripts.length ? transcripts[transcripts.length - 1]!.t : offset;

const segments: Topic[] = ref.annotated
  ? segmentTimeline(ref).filter((t) => t.t_end > windowStart && t.t_start < windowEnd)
  : [{ t_start: windowStart, t_end: windowEnd + 1, label: "(unannotated window)", path: [], depth: 0 }];

let emitted = 0;
for (const seg of segments) {
  const lo = Math.max(seg.t_start, windowStart);
  const hi = Math.min(seg.t_end, windowEnd + 1);
  const evs = transcripts.filter((x) => x.t >= lo && x.t < hi);
  if (evs.length === 0) continue;

  const batches = opBatches.filter((b) => b.t >= lo && b.t < hi);
  const before = stateAt(lo);
  const after = stateAt(hi);
  const beforeD = activeOf(before);
  const afterD = activeOf(after);

  const latencies = batches.map((b) => b.latency).sort((a, b) => a - b);
  const rejects = batches.flatMap((b) => b.rejected);

  const row = {
    id: `${meeting}#${mmss(lo)}-${mmss(hi)}#${runLabel}`,
    input: {
      meeting,
      segment_start: mmss(lo),
      segment_end: mmss(hi),
      transcript: evs.map((x) => line(x.ev, x.t)).join("\n"),
      diagram_before: beforeD ? { nodes: beforeD.nodes, edges: beforeD.edges } : { nodes: [], edges: [] },
    },
    expected: {
      /**
       * AMI annotates topic *labels* per segment, and abstract/decisions at the
       * meeting level. There is no per-segment human summary, so the judge gets
       * the segment's topic path plus meeting-level human content as context.
       */
      topic: seg.label,
      topic_path: seg.path,
      meeting_abstract: ref.abstract,
      meeting_decisions: ref.decisions,
      human_annotated: ref.annotated,
    },
    // everything below lands in Case.metadata
    run: runLabel,
    diagram_after: afterD ? { nodes: afterD.nodes, edges: afterD.edges } : { nodes: [], edges: [] },
    ops: batches.flatMap((b) => b.ops),
    calls: batches.length,
    noop_calls: batches.filter((b) => b.ops.length === 0).length,
    rejected_unknown_id: rejects.filter((r) => /unknown/.test(r.reason)).length,
    rejected_duplicate: rejects.filter((r) => /already exists/.test(r.reason)).length,
    structural: structural(after),
    latency_p50_ms: latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null,
    is_topic_boundary: Math.abs(lo - seg.t_start) < 1000,
  };
  console.log(JSON.stringify(row));
  emitted++;
}

/**
 * One extra case per dismiss: the board as it stood the instant before it was
 * parked. A dismiss inside a segment makes that segment's normal case read the
 * post-dismiss (empty) state, so the board that was wrong enough to dismiss -
 * the one the judge most needs to score - would otherwise vanish at the boundary.
 * Seen on DEMO01: the "submission tangent" segment showed 0 nodes.
 */
let dismissed = 0;
for (const e of entries) {
  if (e.event.kind !== "dismiss") continue;
  const td = abs(e.t_ms);
  const seg = segments.find((s) => s.t_start <= td && td < s.t_end) ?? segments[segments.length - 1];
  if (!seg) continue;
  const lo = Math.max(seg.t_start, windowStart);
  const evs = transcripts.filter((x) => x.t >= lo && x.t < td);
  const batches = opBatches.filter((b) => b.t >= lo && b.t < td);
  const state = stateAt(td); // strictly before the dismiss entry
  const d = activeOf(state);
  const latencies = batches.map((b) => b.latency).sort((a, b) => a - b);
  const rejects = batches.flatMap((b) => b.rejected);
  console.log(JSON.stringify({
    id: `${meeting}#${mmss(lo)}-${mmss(td)}#${runLabel}#dismissed`,
    input: {
      meeting, segment_start: mmss(lo), segment_end: mmss(td),
      transcript: evs.map((x) => line(x.ev, x.t)).join("\n"),
      diagram_before: (() => { const b = activeOf(stateAt(lo)); return b ? { nodes: b.nodes, edges: b.edges } : { nodes: [], edges: [] }; })(),
    },
    expected: {
      topic: seg.label, topic_path: seg.path,
      meeting_abstract: ref.abstract, meeting_decisions: ref.decisions,
      human_annotated: ref.annotated,
    },
    run: runLabel,
    dismissed: true,
    diagram_after: d ? { nodes: d.nodes, edges: d.edges } : { nodes: [], edges: [] },
    ops: batches.flatMap((b) => b.ops),
    calls: batches.length,
    noop_calls: batches.filter((b) => b.ops.length === 0).length,
    rejected_unknown_id: rejects.filter((r) => /unknown/.test(r.reason)).length,
    rejected_duplicate: rejects.filter((r) => /already exists/.test(r.reason)).length,
    structural: structural(state),
    latency_p50_ms: latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null,
    is_topic_boundary: false,
  }));
  dismissed++;
}

console.error(
  `${meeting} ${fromStr}: ${emitted} case(s)${dismissed ? ` + ${dismissed} at dismiss` : ""} from ${segments.length} segment(s), ` +
    `${ref.annotated ? "human-annotated" : "NO human annotations"}, run=${runLabel}`,
);
