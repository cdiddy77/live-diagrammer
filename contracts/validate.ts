/**
 * Contract check. The fixtures parse, the op stream replays through the
 * reducer with no rejection, and the reducer refuses an op it must refuse.
 *
 *   npm run validate
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  CONTRACT_VERSION,
  CompactGraphState,
  ExtractorOutput,
  NegativeExample,
  OpBatch,
  TranscriptEvent,
  edgeId,
} from "./schema.ts";
import { applyOp, applyOps, emptyState } from "./reducer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, "fixtures", name);

type Check = { name: string; run: () => string };
const checks: Check[] = [];
const check = (name: string, run: () => string) => checks.push({ name, run });

function parseLines<T>(path: string, schema: z.ZodType<T>): T[] {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line, i) => {
      const r = schema.safeParse(JSON.parse(line));
      if (!r.success) throw new Error(`${path}:${i + 1} ${z.prettifyError(r.error)}`);
      return r.data;
    });
}

check("contract version is 0.1.0", () => {
  if (CONTRACT_VERSION !== "0.1.0") throw new Error(`got ${CONTRACT_VERSION}`);
  return CONTRACT_VERSION;
});

const transcript = parseLines(fixture("transcript.jsonl"), TranscriptEvent);
check("transcript fixture parses", () => {
  const channels = new Set(transcript.map((e) => e.channel));
  if (!channels.has("me") || !channels.has("them")) throw new Error("both channels must appear");
  for (let i = 1; i < transcript.length; i++) {
    if (transcript[i].t_start < transcript[i - 1].t_end) throw new Error(`event ${i} overlaps event ${i - 1}`);
  }
  return `${transcript.length} events, channels ${[...channels].join("/")}`;
});

const batches = parseLines(fixture("ops.jsonl"), OpBatch);
check("op batches parse as extractor output", () => {
  for (const b of batches) {
    const r = ExtractorOutput.safeParse({ ops: b.ops });
    if (!r.success) throw new Error(`batch ${b.call_id}: ${z.prettifyError(r.error)}`);
  }
  const noop = batches.filter((b) => b.ops.length === 0).length;
  return `${batches.length} batches, ${noop} no-op`;
});

let state = emptyState();
check("op stream replays with no rejection", () => {
  for (const b of batches) {
    const r = applyOps(state, b.ops);
    state = r.state;
    if (r.rejected.length) {
      const first = r.rejected[0];
      throw new Error(`batch ${b.call_id}: ${first.reason} (${JSON.stringify(first.op)})`);
    }
  }
  const r = CompactGraphState.safeParse(state);
  if (!r.success) throw new Error(z.prettifyError(r.error));
  const active = state.diagrams.find((d) => d.diagram_id === state.active);
  if (!active) throw new Error("no active diagram after replay");
  return `${state.diagrams.length} diagram(s), active ${state.active}, ${active.nodes.length} nodes, ${active.edges.length} edges`;
});

check("replayed board matches the fixture story", () => {
  const active = state.diagrams.find((d) => d.diagram_id === state.active)!;
  const label = (id: string) => active.nodes.find((n) => n.id === id)?.label;
  const has = (from: string, to: string) => active.edges.some((e) => e.from === from && e.to === to);
  if (label("transcriber") !== "OpenAI Realtime") throw new Error("rename did not apply");
  if (has("server", "transcriber")) throw new Error("removed edge still present");
  if (!has("server", "batcher") || !has("batcher", "transcriber")) throw new Error("redirect edges missing");
  return "rename applied, edge redirected through batcher";
});

check("negative example fixture parses", () => {
  const raw = JSON.parse(readFileSync(fixture("negative_example.json"), "utf8"));
  const r = NegativeExample.safeParse(raw);
  if (!r.success) throw new Error(z.prettifyError(r.error));
  return `${r.data.diagram.nodes.length} nodes, ${r.data.transcript.length} events, ${r.data.calls_remaining} calls remaining`;
});

check("reducer rejects an edge to an unknown node", () => {
  const r = applyOp(state, { op: "add_edge", from: "extractor", to: "ghost", label: null });
  if (!r.rejected) throw new Error("edge to unknown node was accepted");
  if (r.state !== state) throw new Error("state changed on a rejected op");
  return r.rejected.reason;
});

check("reducer rejects a duplicate node", () => {
  const r = applyOp(state, { op: "add_node", id: "server", label: "Again" });
  if (!r.rejected) throw new Error("duplicate node was accepted");
  return r.rejected.reason;
});

check("reducer rejects a duplicate edge", () => {
  const r = applyOp(state, { op: "add_edge", from: "server", to: "batcher", label: null });
  if (!r.rejected) throw new Error("duplicate edge was accepted");
  if (!r.rejected.reason.includes(edgeId("server", "batcher"))) throw new Error(`unexpected reason: ${r.rejected.reason}`);
  return r.rejected.reason;
});

check("reducer rejects ops with no active diagram", () => {
  const r = applyOp(emptyState(), { op: "add_node", id: "lonely", label: "Lonely" });
  if (!r.rejected) throw new Error("op applied with no active diagram");
  return r.rejected.reason;
});

let failed = 0;
for (const c of checks) {
  try {
    console.log(`ok    ${c.name}: ${c.run()}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${c.name}: ${(e as Error).message}`);
  }
}
console.log(failed === 0 ? `contracts ${CONTRACT_VERSION}: ${checks.length} checks pass` : `${failed} of ${checks.length} checks failed`);
process.exit(failed === 0 ? 0 : 1);
