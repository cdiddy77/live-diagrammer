// Drift = how far a node that existed before a layout step moved during it.
// The done-when for S1: no previously placed node moves more than a few px.
/** `floating`: the node has no edges yet, so it has no structural position. It may be
 *  re-placed once, when its first edge arrives. That move is placement, not drift. */
export type Pos = { x: number; y: number; floating?: boolean };
export type Positions = Record<string, Pos>;

export const DRIFT_LIMIT_PX = 3;

export type Drift = {
  moved: { id: string; dx: number; dy: number; dist: number }[];
  max: number;
  over: number; // nodes past DRIFT_LIMIT_PX
  added: string[];
  removed: string[];
  /** Floating nodes that got their first edge this step and were re-placed. Not counted as drift. */
  anchored: string[];
};

export function drift(prev: Positions, next: Positions): Drift {
  const moved: Drift["moved"] = [];
  const anchored: string[] = [];
  for (const id of Object.keys(prev)) {
    if (!next[id]) continue;
    if (prev[id].floating && !next[id].floating) { anchored.push(id); continue; }
    const dx = next[id].x - prev[id].x;
    const dy = next[id].y - prev[id].y;
    moved.push({ id, dx, dy, dist: Math.hypot(dx, dy) });
  }
  return {
    moved,
    max: moved.reduce((m, r) => Math.max(m, r.dist), 0),
    over: moved.filter((r) => r.dist > DRIFT_LIMIT_PX).length,
    added: Object.keys(next).filter((id) => !prev[id]),
    removed: Object.keys(prev).filter((id) => !next[id]),
    anchored,
  };
}

/** Translate `next` so the existing nodes keep their centroid. A whole-graph shift is a viewport
 *  problem, not a reshuffle, so it is removed before measuring drift. */
export function anchor(prev: Positions, next: Positions): Positions {
  const shared = Object.keys(prev).filter((id) => next[id]);
  if (shared.length === 0) return next;
  let dx = 0, dy = 0;
  for (const id of shared) { dx += next[id].x - prev[id].x; dy += next[id].y - prev[id].y; }
  dx /= shared.length; dy /= shared.length;
  const out: Positions = {};
  for (const [id, p] of Object.entries(next)) out[id] = { ...p, x: p.x - dx, y: p.y - dy };
  return out;
}
