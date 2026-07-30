// Pure layout maths for the World Map tab. Kept out of the component because
// vitest here runs with environment: "node" — Cytoscape cannot be mounted in a
// test, so anything worth asserting has to live in a plain function.
// (Same reasoning as biomeForm.js and liveWarning.js.)

export const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };

// Grid step per compass edge, in SCREEN convention: y grows downward, so South
// is +y. Getting this backwards silently mirrors the whole diagram.
const STEP = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

// The compass edge implied by dragging from one node to another. Dominant axis
// wins; a perfect diagonal resolves horizontally (arbitrary but fixed, so the
// inference is never ambiguous to the user).
export function compassFromDelta(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'E' : 'W';
  return dy >= 0 ? 'S' : 'N';
}

// A position for EVERY world passed in. Worlds with stored coordinates keep
// them; the rest are seeded by walking links breadth-first from the entry
// world, one grid cell per compass edge. A cell that is already occupied is
// skipped rather than overwritten — the live topology is spatially
// contradictory (every edge of one world pointing at the same neighbour), so
// collisions are normal, not exceptional. Whatever the walk cannot place drops
// into a row beneath it.
//
// Callers must NOT persist these. They are a display fallback; graph_x/graph_y
// stay null until an admin actually drags something.
export function seedPositions(worlds, links, { cell = 220 } = {}) {
  const list = Array.isArray(worlds) ? worlds : [];
  const out = {};
  const stored = new Set();
  // Occupied grid cells, seeded from positions the admin already chose so the
  // walk below cannot place a neighbour on top of one of them.
  const taken = new Set();
  for (const w of list) {
    if (Number.isFinite(w.graph_x) && Number.isFinite(w.graph_y)) {
      out[w.id] = { x: w.graph_x, y: w.graph_y };
      stored.add(w.id);
      taken.add(`${Math.round(w.graph_x / cell)},${Math.round(w.graph_y / cell)}`);
    }
  }

  const known = new Set(list.map((w) => w.id));
  const adjacency = new Map();
  for (const l of Array.isArray(links) ? links : []) {
    if (!known.has(l.from_world_id) || !known.has(l.to_world_id)) continue;
    if (!STEP[l.edge]) continue;
    if (!adjacency.has(l.from_world_id)) adjacency.set(l.from_world_id, []);
    adjacency.get(l.from_world_id).push(l);
  }

  const cellOf = new Map();
  const start = list.find((w) => w.is_entry && !stored.has(w.id))
    || list.find((w) => !stored.has(w.id));
  const queue = [];
  if (start) {
    let col = 0;
    while (taken.has(`${col},0`)) col += 1;
    cellOf.set(start.id, [col, 0]);
    taken.add(`${col},0`);
    queue.push(start.id);
  }
  while (queue.length > 0) {
    const id = queue.shift();
    const [col, row] = cellOf.get(id);
    for (const l of adjacency.get(id) || []) {
      const target = l.to_world_id;
      if (cellOf.has(target) || stored.has(target)) continue;
      const [dc, dr] = STEP[l.edge];
      const key = `${col + dc},${row + dr}`;
      if (taken.has(key)) continue;
      cellOf.set(target, [col + dc, row + dr]);
      taken.add(key);
      queue.push(target);
    }
  }
  for (const [id, [col, row]] of cellOf) out[id] = { x: col * cell, y: row * cell };

  // The spare row sits below everything already placed -- stored cells included,
  // which is why maxRow reads `taken` rather than just the walk's own cells.
  let maxRow = 0;
  for (const key of taken) maxRow = Math.max(maxRow, Number(key.split(',')[1]));
  let spare = 0;
  for (const w of list) {
    if (out[w.id]) continue;
    while (taken.has(`${spare},${maxRow + 2}`)) spare += 1;
    out[w.id] = { x: spare * cell, y: (maxRow + 2) * cell };
    taken.add(`${spare},${maxRow + 2}`);
    spare += 1;
  }
  return out;
}
