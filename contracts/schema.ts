/**
 * Live Diagrammer — S0 shared contracts.
 *
 * Every spike imports this file. Do not fork it. If you need a change,
 * change it here, bump CONTRACT_VERSION, and tell the other lanes.
 *
 * Source: Notion "Hackathon: Agents, Everywhere (Sep 12)" §5 S0, and
 * "Original Design" §3.1, §3.6, §5.1.
 *
 * Contents:
 *   1. Op schema           — what the extractor emits, what the reducer applies.
 *   2. Transcript event    — what capture / transcription / replay produce.
 *   3. Compact graph JSON  — how the current diagram goes into the prompt.
 *   4. Negative example    — how a dismissed diagram goes into the next N calls.
 *   5. Session log events  — the append-only event envelope (replay input).
 *
 * Conventions:
 *   - All times are integer milliseconds relative to session start (t_ms).
 *   - Ops apply to the ACTIVE diagram. `new_diagram` creates and activates.
 *   - Node IDs are chosen by the extractor and never change. `rename`
 *     changes the label, not the id.
 *   - Edges are identified by (from, to). Their edge id is `${from}->${to}`.
 *   - Fields the extractor emits are `nullable`, never `optional`, so the
 *     generated JSON Schema works with OpenAI strict structured outputs.
 */
import { z } from "zod";

export const CONTRACT_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

/** Node id: snake_case ASCII, 1–32 chars, starts with a letter. Extractor-chosen. */
export const NODE_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** Edge id: `${from}->${to}`. Reducer-derived, never emitted by the extractor. */
export const EDGE_ID_RE = /^[a-z][a-z0-9_]{0,31}->[a-z][a-z0-9_]{0,31}$/;
/** Diagram id: `d` + integer, assigned by the reducer in creation order (d1, d2, ...). */
export const DIAGRAM_ID_RE = /^d[1-9][0-9]*$/;

export const NodeId = z.string().regex(NODE_ID_RE, "node id must match ^[a-z][a-z0-9_]{0,31}$");
export const EdgeId = z.string().regex(EDGE_ID_RE, "edge id must be `from->to`");
export const DiagramId = z.string().regex(DIAGRAM_ID_RE, "diagram id must match ^d[1-9][0-9]*$");

export type NodeId = z.infer<typeof NodeId>;
export type EdgeId = z.infer<typeof EdgeId>;
export type DiagramId = z.infer<typeof DiagramId>;

export const edgeId = (from: NodeId, to: NodeId): EdgeId => `${from}->${to}`;

export const DiagramType = z.enum(["flowchart", "sequence", "mindmap"]);
export type DiagramType = z.infer<typeof DiagramType>;

/** Labels are short, human-readable, and single-line. */
export const Label = z.string().min(1).max(80);

// ---------------------------------------------------------------------------
// 1. Op schema (Original Design §3.1)
// ---------------------------------------------------------------------------

export const AddNodeOp = z.object({
  op: z.literal("add_node"),
  id: NodeId,
  label: Label,
});

export const AddEdgeOp = z.object({
  op: z.literal("add_edge"),
  from: NodeId,
  to: NodeId,
  /** Edge label, or null for an unlabeled edge. */
  label: Label.nullable(),
});

export const RenameOp = z.object({
  op: z.literal("rename"),
  id: NodeId,
  label: Label,
});

/**
 * Remove a node (by node id — its edges go with it) or an edge
 * (by edge id `from->to`). To redirect an edge: remove the old one, add the new one.
 */
export const RemoveOp = z.object({
  op: z.literal("remove"),
  id: z.union([NodeId, EdgeId]),
});

/** Create a new diagram and make it active. The reducer assigns the diagram id. */
export const NewDiagramOp = z.object({
  op: z.literal("new_diagram"),
  type: DiagramType,
  /** Short title, or null. */
  title: Label.nullable(),
});

/** Make an existing diagram active. Subsequent ops in the same batch apply to it. */
export const SwitchActiveOp = z.object({
  op: z.literal("switch_active"),
  diagram_id: DiagramId,
});

export const Op = z.discriminatedUnion("op", [
  AddNodeOp,
  AddEdgeOp,
  RenameOp,
  RemoveOp,
  NewDiagramOp,
  SwitchActiveOp,
]);
export type Op = z.infer<typeof Op>;

/** Exactly what the extractor's tool call returns. An empty `ops` array is the normal answer. */
export const ExtractorOutput = z.object({
  ops: z.array(Op),
});
export type ExtractorOutput = z.infer<typeof ExtractorOutput>;

// ---------------------------------------------------------------------------
// 2. Transcript event (Original Design §3.6 + S2 two-channel attribution)
// ---------------------------------------------------------------------------

/** `me` = local mic, `them` = captured tab audio. Replay fixtures map their speakers onto these. */
export const Channel = z.enum(["me", "them"]);
export type Channel = z.infer<typeof Channel>;

export const TranscriptEvent = z.object({
  text: z.string(),
  /** false = partial hypothesis (may be revised), true = committed utterance. The extractor only sees finals. */
  is_final: z.boolean(),
  /** Session-relative milliseconds. */
  t_start: z.int().nonnegative(),
  t_end: z.int().nonnegative(),
  channel: Channel,
  /** Optional finer attribution (AMI speaker code, display name). Absent on the live path. */
  speaker: z.string().optional(),
}).refine((e) => e.t_end >= e.t_start, { message: "t_end must be >= t_start" });
export type TranscriptEvent = z.infer<typeof TranscriptEvent>;

// ---------------------------------------------------------------------------
// 3. Compact graph JSON for the prompt (Original Design §5.1)
// ---------------------------------------------------------------------------

export const CompactNode = z.object({ id: NodeId, label: Label });
export const CompactEdge = z.object({ from: NodeId, to: NodeId, label: Label.optional() });

export const CompactDiagram = z.object({
  diagram_id: DiagramId,
  type: DiagramType,
  title: Label.optional(),
  nodes: z.array(CompactNode),
  edges: z.array(CompactEdge),
});
export type CompactDiagram = z.infer<typeof CompactDiagram>;

/** Everything live, with the active one flagged. Parked diagrams are not sent. */
export const CompactGraphState = z.object({
  active: DiagramId.nullable(),
  diagrams: z.array(CompactDiagram),
});
export type CompactGraphState = z.infer<typeof CompactGraphState>;

// ---------------------------------------------------------------------------
// 4. Negative example (the dismiss-and-recover shot)
// ---------------------------------------------------------------------------

/**
 * When a participant dismisses, the active diagram is parked and this record
 * is attached to the next `calls_remaining` extractor calls. The prompt
 * builder renders it as "this drawing was rejected for this transcript".
 */
export const NegativeExample = z.object({
  /** The parked diagram as it looked at dismiss time. */
  diagram: CompactDiagram,
  /** Final transcript events the diagram was drawn from (the rolling window at dismiss time). */
  transcript: z.array(TranscriptEvent),
  dismissed_at_ms: z.int().nonnegative(),
  /** Decremented by the pipeline after each call. Drop when it reaches 0. Default 3. */
  calls_remaining: z.int().nonnegative(),
});
export type NegativeExample = z.infer<typeof NegativeExample>;

export const DEFAULT_NEGATIVE_EXAMPLE_CALLS = 3;

// ---------------------------------------------------------------------------
// 5. Session log events (Original Design §3.2 — the log is the source of truth)
// ---------------------------------------------------------------------------

/** One extractor call's result, as appended to the log. */
export const OpBatch = z.object({
  kind: z.literal("ops"),
  call_id: z.string(),
  /** Number of final transcript events consumed so far (the `>>> NEW` marker position). */
  transcript_cursor: z.int().nonnegative(),
  /** Ops the reducer accepted. */
  ops: z.array(Op),
  /** Ops the reducer rejected, with why. Logged as a quality metric. */
  rejected: z.array(z.object({ op: Op, reason: z.string() })),
  /** Extractor wall-clock, ms. */
  latency_ms: z.int().nonnegative(),
});
export type OpBatch = z.infer<typeof OpBatch>;

export const TranscriptLogEvent = z.object({
  kind: z.literal("transcript"),
  event: TranscriptEvent,
});

export const SnapshotEvent = z.object({
  kind: z.literal("snapshot"),
  diagram_id: DiagramId,
  user: z.string().optional(),
});

export const DismissEvent = z.object({
  kind: z.literal("dismiss"),
  diagram_id: DiagramId,
  user: z.string().optional(),
});

export const SessionEvent = z.discriminatedUnion("kind", [
  TranscriptLogEvent,
  OpBatch,
  SnapshotEvent,
  DismissEvent,
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

/** Append-only log line. `state(T) = replay(events where t_ms <= T)`. */
export const LogEntry = z.object({
  seq: z.int().nonnegative(),
  t_ms: z.int().nonnegative(),
  event: SessionEvent,
});
export type LogEntry = z.infer<typeof LogEntry>;
