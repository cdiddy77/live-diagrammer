/**
 * Read eval/ref/<meeting>/reference.md: the human topic timeline, plus the abstract and
 * decisions. These are the corpus annotators' labels (CC BY 4.0), which is what
 * lets a judge score against a human reference instead of against itself.
 *
 * Not every meeting has them. EN2002b ships a transcript only.
 */
import { readFileSync } from "node:fs";

export type Topic = {
  /** ms from meeting start. */
  t_start: number;
  t_end: number;
  label: string;
  /** Outer topics first, e.g. ["industrial designer presentation", "components..."]. */
  path: string[];
  depth: number;
};

export type Reference = {
  meeting: string;
  topics: Topic[];
  abstract: string[];
  decisions: string[];
  /** False when the meeting ships a transcript with no human annotations. */
  annotated: boolean;
};

const toMs = (mmss: string) => {
  const [m, s] = mmss.split(":").map(Number);
  return (m! * 60 + s!) * 1000;
};

function bullets(md: string, heading: string): string[] {
  const re = new RegExp(`^## ${heading}\s*$`, "m");
  const m = re.exec(md);
  if (!m) return [];
  const rest = md.slice(m.index + m[0].length);
  const end = rest.search(/^## /m);
  return (end === -1 ? rest : rest.slice(0, end))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

export function readReference(meeting: string, dir = "./ref"): Reference {
  const md = readFileSync(new URL(`${dir}/${meeting}/reference.md`, import.meta.url), "utf8");
  const annotated = !/No summary or topic annotations exist/i.test(md);

  const lineRe = /^(\s*)- \[(\d{1,2}:\d{2})\]\s+(.*)$/;
  const raw: { indent: number; t: number; label: string }[] = [];
  let inTimeline = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^## Topic timeline/i.test(line)) { inTimeline = true; continue; }
    if (inTimeline && /^## /.test(line)) break;
    if (!inTimeline) continue;
    const m = lineRe.exec(line);
    if (m) raw.push({ indent: m[1]!.length, t: toMs(m[2]!), label: m[3]!.trim() });
  }

  // Stack walk: a deeper indent is a child of the last shallower entry.
  // A topic runs until the next entry at the same or shallower indent.
  const stack: { indent: number; label: string }[] = [];
  const topics: Topic[] = raw.map((r, i) => {
    while (stack.length && stack[stack.length - 1]!.indent >= r.indent) stack.pop();
    const path = [...stack.map((x) => x.label), r.label];
    stack.push({ indent: r.indent, label: r.label });
    let t_end = raw[raw.length - 1]!.t + 60_000;
    for (let j = i + 1; j < raw.length; j++) {
      if (raw[j]!.indent <= r.indent) { t_end = raw[j]!.t; break; }
    }
    return { t_start: r.t, t_end, label: r.label, path, depth: r.indent / 2 };
  });

  return { meeting, topics, abstract: bullets(md, "Abstract"), decisions: bullets(md, "Decisions"), annotated };
}

/**
 * Segment the timeline losslessly: cut at every boundary, and label each slice
 * with the deepest topic covering it. Taking leaves alone would drop the gap
 * between a parent topic's start and its first child.
 */
export function segmentTimeline(ref: Reference): Topic[] {
  const bounds = [...new Set(ref.topics.flatMap((t) => [t.t_start, t.t_end]))].sort((a, b) => a - b);
  const out: Topic[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i]!, hi = bounds[i + 1]!;
    if (hi <= lo) continue;
    const covering = ref.topics.filter((t) => t.t_start <= lo && t.t_end >= hi);
    if (!covering.length) continue;
    const deepest = covering.reduce((a, b) => (b.depth > a.depth ? b : a));
    out.push({ ...deepest, t_start: lo, t_end: hi });
  }
  return out;
}
