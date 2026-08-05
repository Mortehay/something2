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

// Places every dungeon reachable via PORTAL links from any world that
// already has a cell, one row deeper per hop, siblings spread across
// columns so branches never collide. Runs AFTER the compass walk (so
// entrance worlds already have their real positions) and BEFORE the
// disconnected-root loop (so a dungeon is never mistaken for an unrelated
// orphan cluster and dumped in list order far from its actual entrance).
// Mutates cellOf/taken in place, matching the imperative style the rest of
// this file already uses for the same reason (one shared occupancy set).
function placePortalClusters(cellOf, taken, portalAdjacency) {
  // Every world that already has a position AND has outgoing portals is a
  // potential cluster root -- iterate a snapshot since cellOf grows as we go.
  const roots = [...cellOf.keys()].filter((id) => portalAdjacency.has(id));
  for (const rootId of roots) {
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift();
      const [col, row] = cellOf.get(id);
      const children = portalAdjacency.get(id) || [];
      let col0 = col - Math.floor((children.length - 1) / 2);
      for (const childId of children) {
        if (cellOf.has(childId)) continue;
        let c = col0;
        while (taken.has(`${c},${row + 1}`)) c += 1;
        cellOf.set(childId, [c, row + 1]);
        taken.add(`${c},${row + 1}`);
        queue.push(childId);
        col0 = c + 1;
      }
    }
  }
}

// A position for EVERY world passed in. Worlds with stored coordinates keep
// them exactly and ANCHOR the walk: their neighbours are seeded by walking
// links breadth-first FROM the stored worlds, one grid cell per compass edge,
// so a single drag never re-routes or relocates any other world's seeded
// position. Whatever that walk can't reach (no stored world anywhere in its
// cluster) starts its own breadth-first walk from its own root — entry world
// first, then list order — dropped into a fresh row beneath whatever has been
// placed so far, so each disconnected cluster keeps its own shape instead of
// being flattened into one row. A cell that is already occupied is skipped
// rather than overwritten — the live topology is spatially contradictory
// (every edge of one world pointing at the same neighbour), so collisions are
// normal, not exceptional.
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
  // Grid cell per world. Stored worlds ANCHOR the walk: their neighbours are
  // measured from where the admin actually dropped them, and the walk passes
  // straight through them. Without that, one world gaining a saved position
  // re-routes the walk for every OTHER world -- so a single drag would relocate
  // the whole diagram and invent direction-mismatch warnings for correct links.
  const cellOf = new Map();
  for (const w of list) {
    if (Number.isFinite(w.graph_x) && Number.isFinite(w.graph_y)) {
      out[w.id] = { x: w.graph_x, y: w.graph_y };
      stored.add(w.id);
      const col = Math.round(w.graph_x / cell);
      const row = Math.round(w.graph_y / cell);
      taken.add(`${col},${row}`);
      cellOf.set(w.id, [col, row]);
    }
  }

  const known = new Set(list.map((w) => w.id));
  const adjacency = new Map();
  const portalAdjacency = new Map();
  for (const l of Array.isArray(links) ? links : []) {
    if (!known.has(l.from_world_id) || !known.has(l.to_world_id)) continue;
    if (l.edge === 'PORTAL') {
      if (!portalAdjacency.has(l.from_world_id)) portalAdjacency.set(l.from_world_id, []);
      portalAdjacency.get(l.from_world_id).push(l.to_world_id);
      continue;
    }
    if (!STEP[l.edge]) continue;
    if (!adjacency.has(l.from_world_id)) adjacency.set(l.from_world_id, []);
    adjacency.get(l.from_world_id).push(l);
  }

  const queue = [...cellOf.keys()];
  const walk = () => {
    while (queue.length > 0) {
      const id = queue.shift();
      const [col, row] = cellOf.get(id);
      for (const l of adjacency.get(id) || []) {
        const target = l.to_world_id;
        if (cellOf.has(target)) continue;
        const [dc, dr] = STEP[l.edge];
        const key = `${col + dc},${row + dr}`;
        if (taken.has(key)) continue;
        cellOf.set(target, [col + dc, row + dr]);
        taken.add(key);
        queue.push(target);
      }
    }
  };
  walk();

  placePortalClusters(cellOf, taken, portalAdjacency);

  // Whatever the stored anchors could not reach starts its own walk, so a cluster
  // with no stored world in it still keeps its own shape instead of being dumped
  // into a flat row. Entry world first, then list order.
  const deepestRow = () => {
    let deepest = -Infinity;
    for (const [, [, row]] of cellOf) deepest = Math.max(deepest, row);
    return deepest;
  };
  const roots = [...list].sort((a, b) => (b.is_entry ? 1 : 0) - (a.is_entry ? 1 : 0));
  let nextRow = cellOf.size > 0 ? deepestRow() + 2 : 0;
  for (const w of roots) {
    if (cellOf.has(w.id)) continue;
    let col = 0;
    while (taken.has(`${col},${nextRow}`)) col += 1;
    cellOf.set(w.id, [col, nextRow]);
    taken.add(`${col},${nextRow}`);
    queue.push(w.id);
    walk();
    placePortalClusters(cellOf, taken, portalAdjacency);
    // If this root's cluster spilled onto lower rows, keep the next root clear.
    const deepest = deepestRow();
    if (deepest >= nextRow + 1) nextRow = deepest + 2;
  }

  for (const [id, [col, row]] of cellOf) {
    // Stored worlds keep the admin's EXACT pixels, not their rounded grid cell.
    if (stored.has(id)) continue;
    out[id] = { x: col * cell, y: row * cell };
  }
  return out;
}
