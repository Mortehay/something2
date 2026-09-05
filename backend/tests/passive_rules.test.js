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

// ===========================================================================
// SOMET-514: THE SOURCE GATE.
//
// The single most important test in the passive-tree epic, and the one whose
// absence let two rules ship dead through two releases.
//
// `cooldownFloor` and `regenLifeShare` were declared in RULE_KEYS with a
// mandatory `consumer:` field naming a real file, mirrored into RULE_COMBINE,
// folded by composeStats, carried on the composed row, and rendered as
// itemised modifiers on the Character tab. Every test passed. And nothing in
// backend/src/ ever READ either of them -- so the Archer and the Monk each
// began the game with a start node that granted literally nothing, and
// ks_dex_fleet and ks_wis_clarity were inert keystones.
//
// The `consumer:` field was supposed to prevent exactly this. It could not:
// it is a STRING, and a string cannot be wrong in a way a test notices. This
// gate reads SOURCE TEXT instead, which is the only thing that can tell a
// wired rule from a documented one.
//
// If you are adding a rule and this test fails: that is the test working. Do
// not add the key to an ignore list -- write the consumer.
// ===========================================================================

const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');
// The declaring module is excluded because it is where RULE_COMBINE lives:
// counting it would mean every rule trivially "has a consumer" -- the exact
// self-satisfying shape this gate exists to reject.
const DECLARING_FILE = path.join(SRC_DIR, 'services', 'statComposition.js');

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('every rule in the vocabulary is READ by production code, not merely declared', () => {
  const files = jsFilesUnder(SRC_DIR).filter((f) => f !== DECLARING_FILE);
  assert.ok(files.length > 20, 'the file walk found suspiciously few sources');

  const sources = files.map((f) => ({ file: f, text: fs.readFileSync(f, 'utf8') }));

  for (const rule of Object.keys(RULE_COMBINE)) {
    // A bare substring match would count the rule's own name appearing inside
    // a comment. Requiring a property ACCESS -- `.cooldownFloor` or
    // `['cooldownFloor']` or `{ cooldownFloor }` -- is what makes this a test
    // of wiring rather than of documentation.
    const access = new RegExp(
      `(\\.\\s*${rule}\\b)|(\\[\\s*['"\`]${rule}['"\`]\\s*\\])|(\\{[^}]*\\b${rule}\\b[^}]*\\}\\s*=)`,
    );
    const readers = sources.filter((s) => access.test(stripComments(s.text)));
    assert.ok(
      readers.length > 0,
      `rule "${rule}" is declared in RULE_COMBINE but no file under backend/src/ reads it.\n`
      + '        A rule nothing reads is a node the player cannot tell apart from a working one.\n'
      + '        Write the consumer -- do not exempt the key.',
    );
  }
});

// Comments are stripped before matching so a rule "consumed" only by the
// sentence that PROMISES to consume it still fails. That promise is precisely
// what RULE_KEYS' `consumer:` field already contained for both dead rules.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Pins the two repairs SOMET-514 made, by name and by file. A future edit that
// re-inlines the C.MIN_COOLDOWN_MULT constant, or drops the regen rider, fails
// here with a message that says what was lost -- the generic gate above would
// only say "no consumer".
test('the two rules SOMET-514 repaired are read where the repair put them', () => {
  const playerStats = fs.readFileSync(path.join(SRC_DIR, 'services', 'playerStats.js'), 'utf8');
  const world = fs.readFileSync(path.join(SRC_DIR, 'authority', 'world.js'), 'utf8');
  assert.match(stripComments(playerStats), /\.cooldownFloor\b/,
    'playerStats.js must floor cooldownMult with the rule, not with the bare constant');
  assert.match(stripComments(world), /\.regenLifeShare\b/,
    "world.js's mana-regen tick must apply the regenLifeShare rider");
});
