// backend/tests/passive_rules.test.js
//
// The pure graph and budget rules behind allocation. Every expectation is a
// hand-written literal: the point budget in particular is the number a player
// can overspend if it is wrong, so it must not be derived from the same
// expression the code evaluates.
const test = require('node:test');
const assert = require('node:assert');
const {
  buildAdjacency, isAllocatable, flattenGrants,
} = require('../src/services/passiveRules.js');
const {
  RULE_COMBINE, POOL_KEYS, ELEMENT_KEYS, STATUS_KEYS,
} = require('../src/services/statComposition.js');
const {
  RULE_KEYS, RESOURCE_POOLS, STATUSES,
} = require('../seeds/data/passiveTree.js');
const { ELEMENTS } = require('../src/authority/damage.js');
const { STATUS_EFFECTS } = require('../src/authority/effects.js');

//   10 (start) -- 11 -- 12
//                  |
//                 13     14 (unconnected to anything allocated)
const EDGES = [[10, 11], [11, 12], [11, 13], [13, 14]];

test('adjacency is undirected — an edge stored one way is walkable both ways', () => {
  const adj = buildAdjacency(EDGES);
  assert.deepStrictEqual([...adj.get(10)], [11]);
  assert.deepStrictEqual([...adj.get(11)].sort((a, b) => a - b), [10, 12, 13]);
  assert.deepStrictEqual([...adj.get(14)], [13]);
});

test('the start node is always allocatable-adjacent, even with nothing allocated', () => {
  const adj = buildAdjacency(EDGES);
  assert.strictEqual(isAllocatable(11, [], adj, 10), true);
  assert.strictEqual(isAllocatable(12, [], adj, 10), false);
  assert.strictEqual(isAllocatable(13, [], adj, 10), false);
});

test('a node one edge from an allocated node becomes allocatable', () => {
  const adj = buildAdjacency(EDGES);
  assert.strictEqual(isAllocatable(12, [11], adj, 10), true);
  assert.strictEqual(isAllocatable(13, [11], adj, 10), true);
  assert.strictEqual(isAllocatable(14, [11], adj, 10), false);
  assert.strictEqual(isAllocatable(14, [11, 13], adj, 10), true);
});

test('the start node itself is never allocatable — it is granted, not bought', () => {
  const adj = buildAdjacency(EDGES);
  assert.strictEqual(isAllocatable(10, [], adj, 10), false);
  assert.strictEqual(isAllocatable(10, [11], adj, 10), false);
});

test('an already-allocated node is not allocatable again', () => {
  const adj = buildAdjacency(EDGES);
  assert.strictEqual(isAllocatable(11, [11], adj, 10), false);
});

test('a character with no start node can allocate nothing at all', () => {
  const adj = buildAdjacency(EDGES);
  assert.strictEqual(isAllocatable(11, [], adj, null), false);
  assert.strictEqual(isAllocatable(12, [11], adj, null), true); // adjacency still applies
});

test('a node with no edges at all is never allocatable', () => {
  // Not in the plan. `adjacency.get(id)` is undefined for an isolated node;
  // a missing `|| []` would throw rather than refuse, turning a 400 into a 500.
  const adj = buildAdjacency(EDGES);
  assert.strictEqual(isAllocatable(99, [11, 12, 13], adj, 10), false);
});

test('a Set of allocated ids works as well as an array', () => {
  // Not in the plan, but allocateNode is free to hand either shape in and a
  // Set that silently behaved like an empty list would refuse every legal
  // second allocation.
  const adj = buildAdjacency(EDGES);
  assert.strictEqual(isAllocatable(12, new Set([11]), adj, 10), true);
  assert.strictEqual(isAllocatable(11, new Set([11]), adj, 10), false);
});

test('flattenGrants tags every grant with its node label and drops empty ones', () => {
  const flat = flattenGrants([
    { id: 1, label: 'Great Sinew', grants: [{ type: 'stat', stat: 'strength', value: 8 }] },
    { id: 2, label: 'Warrior', grants: [] },
    {
      id: 3,
      label: 'Cryomancy',
      grants: [
        { type: 'damage', element: 'ice', value: 35 },
        { type: 'status', status: 'chill', value: 1 },
      ],
    },
  ]);
  assert.deepStrictEqual(flat, [
    { type: 'stat', stat: 'strength', value: 8, label: 'Great Sinew', nodeId: 1 },
    { type: 'damage', element: 'ice', value: 35, label: 'Cryomancy', nodeId: 3 },
    { type: 'status', status: 'chill', value: 1, label: 'Cryomancy', nodeId: 3 },
  ]);
});

test('the runtime rule table and the seed rule table have not drifted apart', () => {
  // Two files declare the same four rules for two different reasons (see the
  // comment on RULE_COMBINE). Neither is generated from the other, so this is
  // the only thing that stops one being edited alone.
  const seedModes = Object.fromEntries(
    Object.entries(RULE_KEYS).map(([k, v]) => [k, v.combine]),
  );
  assert.deepStrictEqual(seedModes, RULE_COMBINE);
});

// SOMET-495. The same treatment for the OTHER four grant kinds' key lists.
// statComposition.js re-declares each one rather than importing it (it is a
// PURE module and must not require the seed data or the authority), so these
// three assertions are the only thing that stops a fifth element or a fourth
// status being added on one side alone -- which would silently make every grant
// of the new kind compose to nothing, i.e. this ticket's own defect again.
test('the runtime pool/element/status key lists have not drifted from their owners', () => {
  assert.deepStrictEqual(POOL_KEYS, RESOURCE_POOLS,
    'statComposition POOL_KEYS vs the seed generator RESOURCE_POOLS');
  assert.deepStrictEqual(ELEMENT_KEYS, ELEMENTS,
    'statComposition ELEMENT_KEYS vs damage.js ELEMENTS — the elements the '
    + 'combat code actually mitigates');
  assert.deepStrictEqual(STATUS_KEYS, STATUSES,
    'statComposition STATUS_KEYS vs the seed generator STATUSES');
  // ...and the runtime status list must name effects that actually exist. A
  // status key with no spec is silently skipped by applyHitStatuses, so the
  // node would render, allocate, and do nothing.
  for (const s of STATUS_KEYS) {
    assert.ok(STATUS_EFFECTS[s], `no effect spec for the authored status "${s}"`);
  }
});
