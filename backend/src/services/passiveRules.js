// backend/src/services/passiveRules.js
//
// PURE. The graph and budget rules that decide what a character may allocate.
// Kept out of passiveTreeStore.js so every one of them is a unit test rather
// than a database fixture -- the same split progressionStore/playerStats
// already uses.

// edges arrive as [[aId, bId], ...] with aId < bId (the passive_edges CHECK).
// The graph is UNDIRECTED, so both directions go into the map: a walk that
// only followed a_id -> b_id would find half the tree unreachable and would
// look exactly like the orphaned-cluster bug the generator guards against.
function buildAdjacency(edges) {
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const [a, b] of edges || []) { link(a, b); link(b, a); }
  return adj;
}

// Spec §5.4: allocatable iff adjacent to your class's start node, or adjacent
// to a node you have already allocated. The start node itself is GRANTED --
// it costs no point and never enters character_passives -- so it is never
// allocatable, and asking for it is an error rather than a no-op.
function isAllocatable(nodeId, allocatedIds, adjacency, startNodeId) {
  const allocated = allocatedIds instanceof Set ? allocatedIds : new Set(allocatedIds || []);
  if (nodeId === startNodeId) return false;
  if (allocated.has(nodeId)) return false;
  // An isolated node (or an id the graph has never heard of) has no
  // neighbours; `|| []` makes that a refusal rather than a TypeError.
  const neighbours = adjacency.get(nodeId) || [];
  return neighbours.some((n) => n === startNodeId || allocated.has(n));
}

// NOTE: there is deliberately no passivePointsFor() here. The wallet is
// player_progression.passive_points (contract §6.7), granted by T2 and spent
// inside allocateNode's guarded UPDATE. Deriving it from the level would be a
// second, drifting source of truth -- and a wrong one, since T2 also refunds
// pre-epic stat points into that same column.

// passive_nodes rows -> the flat `passives` array composeStats takes. The
// node's label rides on every grant it produces, because the Character tab
// lists modifiers one line each and has to name where each came from.
function flattenGrants(nodes) {
  const out = [];
  for (const n of nodes || []) {
    for (const g of n.grants || []) out.push({ ...g, label: n.label, nodeId: n.id });
  }
  return out;
}

module.exports = { buildAdjacency, isAllocatable, flattenGrants };
