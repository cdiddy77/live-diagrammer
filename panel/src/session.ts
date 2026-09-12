// The fold from the append-only log to what the panel shows. The same fold
// runs live, one entry at a time, and for the scrubber over a prefix of the
// log from zero. The picture at time T is the picture people saw at T,
// positions included, because the placer is deterministic.
import { applyOps } from "../../contracts/reducer.ts";
import { emptyState } from "../../contracts/reducer.ts";
import type { CompactDiagram, CompactGraphState, LogEntry, TranscriptEvent } from "../../contracts/schema.ts";
import { incremental } from "./layout.ts";
import { drift, type Drift, type Positions } from "./drift.ts";

/** A diagram frozen at one log entry: a snapshot, or a parked drawing. */
export type Frozen = { seq: number; t_ms: number; diagram: CompactDiagram; pos: Positions };

export type View = {
  state: CompactGraphState;
  /** Node positions per diagram id. A parked diagram keeps its positions. */
  pos: Record<string, Positions>;
  snapshots: Frozen[];
  parked: Frozen[];
  /** Drift of the last ops entry that changed the active diagram. */
  last: Drift | null;
  /** The last final utterance heard. */
  heard: TranscriptEvent | null;
  calls: number;
  noops: number;
  accepted: number;
  rejected: number;
};

export const emptyView = (): View => ({
  state: emptyState(),
  pos: {},
  snapshots: [],
  parked: [],
  last: null,
  heard: null,
  calls: 0,
  noops: 0,
  accepted: 0,
  rejected: 0,
});

export const activeDiagram = (s: CompactGraphState): CompactDiagram | undefined =>
  s.diagrams.find((d) => d.diagram_id === s.active);

const findDiagram = (s: CompactGraphState, id: string) => s.diagrams.find((d) => d.diagram_id === id);

export function step(v: View, entry: LogEntry): View {
  const ev = entry.event;

  if (ev.kind === "transcript") {
    return ev.event.is_final ? { ...v, heard: ev.event } : v;
  }

  if (ev.kind === "ops") {
    // The log holds only the ops the reducer accepted, so they apply cleanly.
    const r = applyOps(v.state, ev.ops);
    // One layout per changed diagram. The reducer keeps the object identity of
    // a diagram it did not touch, so a reference compare finds the changes.
    // A scoped dismiss touches two diagrams in one entry: the parked part gets
    // its own positions here, so a peek at it shows a placed drawing.
    let pos = v.pos;
    let last = v.last;
    for (const d of r.state.diagrams) {
      if (findDiagram(v.state, d.diagram_id) === d) continue;
      const prev = v.pos[d.diagram_id] ?? {};
      const next = incremental(d, prev);
      pos = { ...pos, [d.diagram_id]: next };
      if (d.diagram_id === r.state.active) last = drift(prev, next);
    }
    // A scoped dismiss logs its moves as an ops entry named dismissN. It is
    // housekeeping, not an extractor call, so the counters skip it.
    const call = !ev.call_id.startsWith("dismiss");
    return {
      ...v,
      state: r.state,
      pos,
      last,
      calls: v.calls + (call ? 1 : 0),
      noops: v.noops + (call && ev.ops.length === 0 ? 1 : 0),
      accepted: v.accepted + (call ? ev.ops.length : 0),
      rejected: v.rejected + ev.rejected.length,
    };
  }

  if (ev.kind === "dismiss") {
    const d = findDiagram(v.state, ev.diagram_id);
    if (!d) return v;
    // A whole-board dismiss names the active diagram and leaves nothing
    // active. A scoped dismiss names the parked part; the board stays active.
    return {
      ...v,
      state: {
        active: v.state.active === ev.diagram_id ? null : v.state.active,
        diagrams: v.state.diagrams.filter((x) => x.diagram_id !== ev.diagram_id),
      },
      parked: [...v.parked, { seq: entry.seq, t_ms: entry.t_ms, diagram: d, pos: v.pos[d.diagram_id] ?? {} }],
      last: null,
    };
  }

  if (ev.kind === "snapshot") {
    const d = findDiagram(v.state, ev.diagram_id);
    if (!d) return v;
    return {
      ...v,
      snapshots: [
        ...v.snapshots,
        { seq: entry.seq, t_ms: entry.t_ms, diagram: structuredClone(d), pos: { ...(v.pos[d.diagram_id] ?? {}) } },
      ],
    };
  }

  return v;
}

export const fold = (entries: LogEntry[]): View => entries.reduce(step, emptyView());

/** Shape checks on one diagram, for the structural badge. */
export type Structure = { orphans: number; duplicates: number };

export function structure(d: CompactDiagram | undefined): Structure {
  if (!d) return { orphans: 0, duplicates: 0 };
  const linked = new Set<string>();
  for (const e of d.edges) {
    linked.add(e.from);
    linked.add(e.to);
  }
  const orphans = d.nodes.filter((n) => !linked.has(n.id)).length;
  const seen = new Map<string, number>();
  for (const n of d.nodes) {
    const key = n.label.trim().toLowerCase().replace(/\s+/g, " ");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const count of seen.values()) if (count > 1) duplicates += count - 1;
  return { orphans, duplicates };
}
