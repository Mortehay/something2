// backend/tests/p5_skeletons.test.js
const test = require('node:test');
const assert = require('node:assert');
const { SKELETONS } = require('../scripts/dungeon/skeletons');

const EDGE_DELTA = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

function assertValidEmbedding(skeleton, name) {
  const byKey = new Map(skeleton.rooms.map((r) => [r.key, r]));
  for (const l of skeleton.links) {
    const from = byKey.get(l.from), to = byKey.get(l.to);
    assert.ok(from, `${name}: link references unknown room "${l.from}"`);
    assert.ok(to, `${name}: link references unknown room "${l.to}"`);
    const [dx, dy] = EDGE_DELTA[l.edge];
    assert.deepEqual(to.grid, [from.grid[0] + dx, from.grid[1] + dy],
      `${name}: link ${l.from}-${l.edge}->${l.to} does not match EDGE_DELTA`);
  }
  // no two rooms share a grid cell
  const seen = new Set();
  for (const r of skeleton.rooms) {
    const cell = r.grid.join(',');
    assert.ok(!seen.has(cell), `${name}: two rooms share grid cell ${cell}`);
    seen.add(cell);
  }
  // exactly one room per compass edge per source (UNIQUE(from_world_id, edge))
  const usedEdges = new Set();
  for (const l of skeleton.links) {
    const slot = `${l.from}:${l.edge}`;
    assert.ok(!usedEdges.has(slot), `${name}: room "${l.from}" has two links on edge ${l.edge}`);
    usedEdges.add(slot);
  }
}

test('all three skeletons are valid grid embeddings with no duplicate cells or edges', () => {
  for (const name of ['spine', 'hub', 'loop']) {
    assertValidEmbedding(SKELETONS[name], name);
  }
});

test('every skeleton names a real entry room and a real exit room', () => {
  for (const name of ['spine', 'hub', 'loop']) {
    const s = SKELETONS[name];
    const keys = new Set(s.rooms.map((r) => r.key));
    assert.ok(keys.has(s.entryRoleKey), `${name}: entryRoleKey "${s.entryRoleKey}" is not a real room`);
    assert.ok(keys.has(s.exitRoleKey), `${name}: exitRoleKey "${s.exitRoleKey}" is not a real room`);
  }
});

test('hub skeleton has a hub with at most 4 compass links (UNIQUE from_world_id,edge)', () => {
  const s = SKELETONS.hub;
  const hubOutLinks = s.links.filter((l) => l.from === s.entryRoleKey).length;
  assert.ok(hubOutLinks <= 4);
});

test('loop skeleton contains an actual cycle in its undirected link graph', () => {
  const s = SKELETONS.loop;
  const adjacency = new Map(s.rooms.map((r) => [r.key, []]));
  for (const l of s.links) {
    adjacency.get(l.from).push(l.to);
    adjacency.get(l.to).push(l.from);
  }
  // DFS cycle detection
  const visited = new Set();
  function hasCycle(node, parent) {
    visited.add(node);
    for (const next of adjacency.get(node)) {
      if (!visited.has(next)) { if (hasCycle(next, node)) return true; }
      else if (next !== parent) return true;
    }
    return false;
  }
  assert.ok(hasCycle(s.entryRoleKey, null), 'loop skeleton has no cycle');
});
