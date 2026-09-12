// Three layout strategies behind one function. Pure and DOM-free, so the same
// code runs in the browser (App.tsx) and in Node (measure.ts).
//
//   incremental  our own placer: new nodes go next to their neighbors, old nodes never move
//   elk-layered  ELK layered algorithm in interactive mode, seeded with the incremental placement
//   elk-stress   ELK stress algorithm with existing nodes marked fixed
//
// Positions are top-left corners, the convention React Flow uses.
import type ELKType from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import type { CompactDiagram } from "../../contracts/schema.ts";
import { anchor, type Pos, type Positions } from "./drift.ts";

export type Strategy = "incremental" | "elk-layered" | "elk-stress";
export const STRATEGIES: Strategy[] = ["incremental", "elk-layered", "elk-stress"];

export const NODE_H = 40;
export const ROW_PITCH = 110;
export const COL_PITCH = 230;

export function nodeSize(label: string): { width: number; height: number } {
  return { width: Math.min(220, Math.max(110, 8 * label.length + 28)), height: NODE_H };
}

// Loaded on first use. S5 imports `incremental` from this file and must not pay
// for the 1.4 MB ELK bundle it never runs.
let elkInstance: InstanceType<typeof ELKType> | null = null;
async function elkLoad() {
  if (!elkInstance) { const { default: ELK } = await import("elkjs/lib/elk.bundled.js"); elkInstance = new ELK(); }
  return elkInstance;
}

export async function layout(strategy: Strategy, d: CompactDiagram, prev: Positions): Promise<Positions> {
  const seed = incremental(d, prev);
  if (strategy === "incremental") return seed;
  const raw = await runElk(strategy, d, prev, seed);
  return anchor(prev, raw);
}

// ---------------------------------------------------------------------------
// incremental
// ---------------------------------------------------------------------------

/** Place new nodes relative to placed neighbors. Existing positions are copied unchanged,
 *  except a floating node (no edges so far) that gets its first edge: it is placed again. */
export function incremental(d: CompactDiagram, prev: Positions): Positions {
  const out: Positions = {};
  const hasEdge = (id: string) => d.edges.some((e) => e.from === id || e.to === id);
  for (const n of d.nodes) {
    const p = prev[n.id];
    if (!p) continue;
    if (p.floating && hasEdge(n.id)) continue; // re-place below
    out[n.id] = p;
  }

  const center = (id: string): Pos => {
    const w = nodeSize(d.nodes.find((n) => n.id === id)!.label).width;
    return { x: out[id].x + w / 2, y: out[id].y + NODE_H / 2 };
  };
  const rowOf = (id: string) => Math.round(center(id).y / ROW_PITCH);

  for (const n of d.nodes) {
    if (out[n.id]) continue;
    const sources = d.edges.filter((e) => e.to === n.id && out[e.from]).map((e) => e.from);
    const targets = d.edges.filter((e) => e.from === n.id && out[e.to]).map((e) => e.to);
    let row: number;
    let cx: number;
    if (!sources.length && !targets.length && hasEdge(n.id) && prev[n.id]) {
      // Re-placed floating node whose neighbors are not placed yet: it stays where it
      // was and stops floating. The neighbors are then placed relative to it.
      out[n.id] = { x: prev[n.id].x, y: prev[n.id].y };
      continue;
    }
    if (sources.length) {
      row = Math.max(...sources.map(rowOf)) + 1;
      cx = sources.reduce((s, id) => s + center(id).x, 0) / sources.length;
    } else if (targets.length) {
      row = Math.min(...targets.map(rowOf)) - 1;
      cx = targets.reduce((s, id) => s + center(id).x, 0) / targets.length;
    } else {
      // Unconnected: a new row under everything, on the center column. The node is
      // floating and moves next to its neighbors when its first edge arrives.
      const rows = Object.keys(out).map(rowOf);
      row = rows.length ? Math.max(...rows) + 1 : 0;
      cx = 0;
    }
    cx = freeSlot(cx, row, Object.keys(out).filter((id) => rowOf(id) === row).map((id) => center(id).x));
    const { width } = nodeSize(n.label);
    out[n.id] = { x: cx - width / 2, y: row * ROW_PITCH - NODE_H / 2 };
    if (!hasEdge(n.id)) out[n.id].floating = true;
  }
  return out;
}

/** Nearest x to `want` that is at least COL_PITCH from every taken center on the row. */
function freeSlot(want: number, _row: number, taken: number[]): number {
  const ok = (x: number) => taken.every((t) => Math.abs(t - x) >= COL_PITCH - 1);
  if (ok(want)) return want;
  for (let k = 1; k < 50; k++) {
    if (ok(want + k * COL_PITCH)) return want + k * COL_PITCH;
    if (ok(want - k * COL_PITCH)) return want - k * COL_PITCH;
  }
  return want;
}

// ---------------------------------------------------------------------------
// ELK
// ---------------------------------------------------------------------------

async function runElk(strategy: Strategy, d: CompactDiagram, prev: Positions, seed: Positions): Promise<Positions> {
  const layoutOptions: Record<string, string> =
    strategy === "elk-layered"
      ? {
          "elk.algorithm": "layered",
          "elk.direction": "DOWN",
          "elk.interactive": "true",
          "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
          "elk.layered.layering.strategy": "INTERACTIVE",
          "elk.layered.crossingMinimization.strategy": "INTERACTIVE",
          "elk.layered.nodePlacement.strategy": "INTERACTIVE",
          "elk.spacing.nodeNode": "60",
          "elk.layered.spacing.nodeNodeBetweenLayers": String(ROW_PITCH - NODE_H),
        }
      : {
          "elk.algorithm": "stress",
          "elk.interactive": "true",
          "elk.stress.desiredEdgeLength": String(ROW_PITCH),
          "elk.spacing.nodeNode": "60",
        };

  const graph: ElkNode = {
    id: "root",
    layoutOptions,
    children: d.nodes.map((n) => {
      const p = prev[n.id] ?? seed[n.id];
      const node: ElkNode = { id: n.id, ...nodeSize(n.label), x: p.x, y: p.y };
      if (strategy === "elk-stress" && prev[n.id]) node.layoutOptions = { "elk.stress.fixed": "true" };
      return node;
    }),
    edges: d.edges.map((e) => ({ id: `${e.from}->${e.to}`, sources: [e.from], targets: [e.to] })),
  };
  const res = await (await elkLoad()).layout(graph);
  const out: Positions = {};
  for (const c of res.children ?? []) out[c.id] = { x: c.x ?? 0, y: c.y ?? 0, ...(seed[c.id]?.floating ? { floating: true } : {}) };
  return out;
}
