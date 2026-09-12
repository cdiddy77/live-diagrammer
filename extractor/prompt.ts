/**
 * The S4 extractor prompt. Shape is Original Design §5:
 *
 *   system (cached)  role + whiteboard framing + op schema + "empty is normal"
 *   user (per call)  1. current graph as compact JSON
 *                    2. rolling transcript window with a >>> NEW marker
 *                    3. the last N op batches already emitted
 *                    4. rejected-drawing examples after a dismiss
 *
 * §5 item 4 in the full design is snapshot few-shot (positive). The hackathon
 * page §4 cuts snapshot learning, so the slot carries negative examples only.
 *
 * The system block is byte-identical every call and the graph changes slowly,
 * so both go first: only the transcript tail is uncached tokens.
 */
import type {
  CompactGraphState,
  NegativeExample,
  Op,
  TranscriptEvent,
} from "../contracts/schema.ts";

export const SYSTEM = `You are drawing on a whiteboard while several people talk.

You keep a diagram of the ideas under discussion. You are not transcribing,
summarizing, or taking minutes. Most of what people say does not change the
drawing. An empty list of operations is the normal answer.

You emit OPERATIONS against a graph that we hold. Never Mermaid, never a full
redraw.

  {"op":"add_node","id":"<snake_case>","label":"<short label>"}
  {"op":"add_edge","from":"<node id>","to":"<node id>","label":"<label or null>"}
  {"op":"rename","id":"<node id>","label":"<new label>"}
  {"op":"remove","id":"<node id, or edge id written from->to>"}
  {"op":"new_diagram","type":"flowchart|sequence|mindmap","title":"<title or null>"}
  {"op":"switch_active","diagram_id":"<d1, d2, ...>"}

Before every add_node, read the node list in CURRENT DIAGRAM. If any node there
already refers to the same real-world thing — even under different wording, even
if your id would be different — do not add it. Rename it if the wording has
improved, otherwise emit nothing for it. Two ids for one thing is the most common
way this board goes wrong: the duplicate never gets edges, and a human has to
notice it and delete it.

Diagram type:
- flowchart is the default. Components, steps, data flow, cause and effect,
  options. Use it unless one of the others is clearly a better fit.
- sequence only when the discussion is about ordered messages between actors
  over time.
- mindmap only when the discussion is a hierarchy radiating from one central
  topic, where the branches do not connect to each other.

Rules:
- Node ids match ^[a-z][a-z0-9_]{0,31}$. You choose them, and they NEVER change.
  To change what a node says, use rename. The id stays the same forever.
- Only reference node ids that already exist in CURRENT DIAGRAM, or that you add
  earlier in this same batch. Operations naming an unknown id are discarded.
- One edge per (from, to) pair. To redirect an edge, remove "old_from->old_to"
  and then add the new one.
- Operations apply to the active diagram. new_diagram creates one and activates it.
- Labels are 1-80 characters, single line. One to four words reads best.

What belongs on the board:
- The structure being described: components, steps, actors, causes, options.
- Draw something when it is asserted as part of the design, not when it is merely
  mentioned in passing.
- When someone corrects or refines an idea, rename or rewire the existing node.
  Do not add a near-duplicate alongside it.
- Self-correction mid-sentence is a rename, never a second node. "a battery
  supply, uh no, a power supply" means rename the node you just added. Before
  you add anything, read CURRENT DIAGRAM and ask whether a node there already
  means this. If one does, rename it.
- An edge means a relationship someone actually asserted: A powers B, A sends to
  B, A is part of B, A causes B. Never draw an edge because two things were
  mentioned near each other, and never chain nodes together to make the picture
  look connected. A wrong edge is worse than a missing one.
- Add a node together with the edge that connects it. If you cannot yet say how
  it connects, wait for the utterance that tells you, then add both at once.
  Adding it later costs nothing; a guessed edge has to be spotted and removed,
  and a node left floating makes the board look broken.

What does not belong on the board:
- Greetings, scheduling, small talk, jokes, tangents, and meta-talk about the
  meeting itself ("can everyone hear me", "let's move on", "who's presenting").
- The meeting's own process: agenda items, milestones, deadlines, what to skip,
  who is writing which section, how the document is organised. Draw what the
  project IS, not how the meeting about it is run. If a whole stretch is only
  process, the right answer is no operations at all.
- Anything you are unsure about. Leaving it off costs nothing; a wrong node has
  to be noticed and removed by a human.

Return an empty list when:
- they are elaborating, justifying, or repeating something already on the board
  without changing its structure;
- they are asking questions, agreeing, hedging, or thinking out loud;
- the only new information is a detail that belongs inside a label you already have;
- you would be guessing at what connects to what.

An empty list is a success, not a failure. Across a normal meeting most calls
return nothing. A node that a human then has to notice and delete is the worst
outcome available to you. Drawing nothing is always recoverable on the next
utterance.

Act ONLY on transcript that appears after the >>> NEW marker. Everything above
the marker is context you have already drawn. Re-read it to resolve references
("that", "the second one", "the chip we talked about"), never to redraw it.`;

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const line = (e: TranscriptEvent) =>
  `[${mmss(e.t_start)}] ${e.speaker ?? e.channel}(${e.channel}): ${e.text}`;

export type PromptInput = {
  state: CompactGraphState;
  /** Every final event up to and including this batch, in order. */
  seen: TranscriptEvent[];
  /** Index into `seen` where this batch's new events start. */
  newFrom: number;
  /** Op batches already emitted, oldest first. Only the last few are rendered. */
  recentOps: Op[][];
  negatives: NegativeExample[];
  /** Rolling window length. Original Design §5 says 30-60s; §10 leaves it open. */
  windowMs?: number;
  /** How many prior op batches to show. */
  recentOpBatches?: number;
};

export function buildUser(i: PromptInput): string {
  const windowMs = i.windowMs ?? 45_000;
  const recentN = i.recentOpBatches ?? 3;

  const last = i.seen[i.seen.length - 1];
  const cutoff = last ? last.t_end - windowMs : 0;
  // Always keep the new events, however long the batch ran.
  const firstShown = Math.min(
    i.newFrom,
    Math.max(0, i.seen.findIndex((e) => e.t_end >= cutoff)),
  );
  const shown = i.seen.slice(firstShown < 0 ? i.newFrom : firstShown);
  const markerAt = i.newFrom - (firstShown < 0 ? i.newFrom : firstShown);

  const transcript = shown
    .flatMap((e, idx) => (idx === markerAt ? [">>> NEW", line(e)] : [line(e)]))
    .join("\n");

  const parts: string[] = [];

  parts.push(`## CURRENT DIAGRAM\n${JSON.stringify(i.state, null, 2)}`);

  if (i.recentOps.length) {
    const recent = i.recentOps.slice(-recentN);
    parts.push(
      `## OPERATIONS YOU ALREADY EMITTED (most recent last)\nDo not repeat or undo these.\n${
        recent.map((ops) => JSON.stringify(ops)).join("\n")
      }`,
    );
  }

  for (const n of i.negatives) {
    parts.push(
      `## A DRAWING THAT WAS REJECTED\nA participant dismissed this diagram. It was drawn from the transcript below.\n` +
        `Do not draw it again, and do not draw anything of the same kind.\n\n` +
        `Rejected diagram:\n${JSON.stringify({ nodes: n.diagram.nodes, edges: n.diagram.edges })}\n\n` +
        `Drawn from:\n${n.transcript.map(line).join("\n")}`,
    );
  }

  parts.push(
    `## TRANSCRIPT\nEverything above >>> NEW is already drawn. Act only on what follows it.\n\n${transcript}`,
  );

  return parts.join("\n\n");
}
