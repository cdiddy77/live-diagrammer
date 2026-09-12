/** state -> Mermaid source. Original Design §8; also the cheapest eyeball check. */
import type { CompactDiagram, CompactGraphState } from "../contracts/schema.ts";

const esc = (s: string) => s.replace(/"/g, "'");

function flowchart(d: CompactDiagram): string {
  const lines = ["flowchart LR"];
  for (const n of d.nodes) lines.push(`  ${n.id}["${esc(n.label)}"]`);
  for (const e of d.edges) {
    lines.push(e.label ? `  ${e.from} -->|${esc(e.label)}| ${e.to}` : `  ${e.from} --> ${e.to}`);
  }
  return lines.join("\n");
}

function sequence(d: CompactDiagram): string {
  const lines = ["sequenceDiagram"];
  for (const n of d.nodes) lines.push(`  participant ${n.id} as ${esc(n.label)}`);
  for (const e of d.edges) lines.push(`  ${e.from}->>${e.to}: ${esc(e.label ?? "")}`);
  return lines.join("\n");
}

/**
 * Mermaid mindmap is indentation-based and has no edge syntax, so the graph is
 * walked as a tree: roots are nodes with no incoming edge, children follow
 * outgoing edges, and a node already emitted is not expanded again (the graph
 * may have cycles or diamonds; a mindmap cannot).
 */
function mindmap(d: CompactDiagram): string {
  const label = new Map(d.nodes.map((n) => [n.id, n.label]));
  const out = new Map<string, string[]>();
  for (const e of d.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const hasIncoming = new Set(d.edges.map((e) => e.to));
  const roots = d.nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id);
  const starts = roots.length ? roots : d.nodes.slice(0, 1).map((n) => n.id);

  const seen = new Set<string>();
  const lines = ["mindmap"];
  const walk = (id: string, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    const text = esc(label.get(id) ?? id);
    lines.push(depth === 0 ? `  root((${text}))` : `${"  ".repeat(depth + 1)}${text}`);
    for (const child of out.get(id) ?? []) walk(child, depth + 1);
  };
  for (const r of starts) walk(r, 0);
  // Anything unreachable still belongs on the page.
  for (const n of d.nodes) if (!seen.has(n.id)) walk(n.id, 1);
  return lines.join("\n");
}

export function diagramToMermaid(d: CompactDiagram): string {
  return d.type === "mindmap" ? mindmap(d) : d.type === "sequence" ? sequence(d) : flowchart(d);
}

export function stateToMermaid(s: CompactGraphState): string {
  return s.diagrams
    .map((d) => `%% ${d.diagram_id}${d.title ? ` — ${d.title}` : ""}${d.diagram_id === s.active ? " (active)" : ""}\n${diagramToMermaid(d)}`)
    .join("\n\n");
}
