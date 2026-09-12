/**
 * Reference reducer for the op schema. Pure: (state, op) -> (state, rejection?).
 *
 * This is the smallest correct interpretation of the contract. S1 (layout)
 * and S6 (replay) may copy or import it. If their behavior diverges from
 * this file, this file wins.
 */
import {
  type CompactDiagram,
  type CompactGraphState,
  type DiagramId,
  type Op,
  EDGE_ID_RE,
  edgeId,
} from "./schema.js";

export type Rejection = { op: Op; reason: string };
export type ApplyResult = { state: CompactGraphState; rejected?: Rejection };

export const emptyState = (): CompactGraphState => ({ active: null, diagrams: [] });

const nextDiagramId = (state: CompactGraphState): DiagramId => `d${state.diagrams.length + 1}`;

const activeDiagram = (state: CompactGraphState): CompactDiagram | undefined =>
  state.diagrams.find((d) => d.diagram_id === state.active);

const replaceDiagram = (state: CompactGraphState, d: CompactDiagram): CompactGraphState => ({
  ...state,
  diagrams: state.diagrams.map((x) => (x.diagram_id === d.diagram_id ? d : x)),
});

export function applyOp(state: CompactGraphState, op: Op): ApplyResult {
  const reject = (reason: string): ApplyResult => ({ state, rejected: { op, reason } });

  if (op.op === "new_diagram") {
    const d: CompactDiagram = {
      diagram_id: nextDiagramId(state),
      type: op.type,
      ...(op.title ? { title: op.title } : {}),
      nodes: [],
      edges: [],
    };
    return { state: { active: d.diagram_id, diagrams: [...state.diagrams, d] } };
  }

  if (op.op === "switch_active") {
    if (!state.diagrams.some((d) => d.diagram_id === op.diagram_id)) {
      return reject(`unknown diagram ${op.diagram_id}`);
    }
    return { state: { ...state, active: op.diagram_id } };
  }

  const d = activeDiagram(state);
  if (!d) return reject("no active diagram");
  const hasNode = (id: string) => d.nodes.some((n) => n.id === id);
  const hasEdge = (from: string, to: string) => d.edges.some((e) => e.from === from && e.to === to);

  switch (op.op) {
    case "add_node": {
      if (hasNode(op.id)) return reject(`node ${op.id} already exists`);
      return { state: replaceDiagram(state, { ...d, nodes: [...d.nodes, { id: op.id, label: op.label }] }) };
    }
    case "add_edge": {
      if (!hasNode(op.from)) return reject(`unknown node ${op.from}`);
      if (!hasNode(op.to)) return reject(`unknown node ${op.to}`);
      if (hasEdge(op.from, op.to)) return reject(`edge ${edgeId(op.from, op.to)} already exists`);
      const edge = { from: op.from, to: op.to, ...(op.label ? { label: op.label } : {}) };
      return { state: replaceDiagram(state, { ...d, edges: [...d.edges, edge] }) };
    }
    case "rename": {
      if (!hasNode(op.id)) return reject(`unknown node ${op.id}`);
      return {
        state: replaceDiagram(state, {
          ...d,
          nodes: d.nodes.map((n) => (n.id === op.id ? { ...n, label: op.label } : n)),
        }),
      };
    }
    case "remove": {
      if (EDGE_ID_RE.test(op.id)) {
        const [from, to] = op.id.split("->");
        if (!hasEdge(from, to)) return reject(`unknown edge ${op.id}`);
        return {
          state: replaceDiagram(state, {
            ...d,
            edges: d.edges.filter((e) => !(e.from === from && e.to === to)),
          }),
        };
      }
      if (!hasNode(op.id)) return reject(`unknown node ${op.id}`);
      return {
        state: replaceDiagram(state, {
          ...d,
          nodes: d.nodes.filter((n) => n.id !== op.id),
          edges: d.edges.filter((e) => e.from !== op.id && e.to !== op.id),
        }),
      };
    }
  }
}

/** Apply a batch in order. Rejected ops are skipped; the rest still apply. */
export function applyOps(state: CompactGraphState, ops: Op[]): { state: CompactGraphState; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  for (const op of ops) {
    const r = applyOp(state, op);
    state = r.state;
    if (r.rejected) rejected.push(r.rejected);
  }
  return { state, rejected };
}
