// backend/tests/passive_tree_generator.test.js
//
// The five guards spec §5.5 names, plus two counting guards derived by hand.
//
// Guard 1 is the one that matters. An orphaned cluster renders perfectly, is
// invisible as a defect, and is unallocatable forever — there is no in-game
// symptom short of a player walking the whole tree and finding a wall.
const test = require('node:test');
const assert = require('node:assert');
const { generatePassiveTree } = require('../seeds/generatePassiveTree.js');
const { PASSIVE_TREE_SPEC } = require('../seeds/data/passiveTree.js');
const { ELEMENTS } = require('../src/authority/damage.js');

// The whole vocabulary, hand-written. Deliberately NOT imported from
// passiveTree.js's GRANT_TYPES: a validator that reads the same table the data
// was authored against passes on a table-level typo. The one exception is the
// element list, which is cross-checked against the combat authority below
// precisely because that IS the source of truth for elements.
const STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const POOLS = ['hp', 'mana', 'stamina'];
const ELS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const STATUSES = ['burn', 'chill', 'shock'];
const RULES = ['lifeCostMultiplier', 'treeCharmBonus', 'cooldownFloor', 'regenLifeShare'];

const tree = generatePassiveTree(PASSIVE_TREE_SPEC);

test('the hand-written element list still matches the combat authority', () => {
  assert.deepStrictEqual(ELS, ELEMENTS);
});

// ---- guard 4: node count within 5% of 1800, keystones exactly as specced ----
test('guard 4: 1806 nodes — 1530 minor, 240 notable, 30 keystone, 6 start', () => {
  assert.strictEqual(tree.nodes.length, 1806);

  const byKind = {};
  for (const n of tree.nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
  assert.deepStrictEqual(byKind, { minor: 1530, notable: 240, keystone: 30, start: 6 });

  // The spec's own tolerance, restated as a literal band rather than a formula.
  assert.ok(tree.nodes.length >= 1710 && tree.nodes.length <= 1890,
    `node count ${tree.nodes.length} is outside 1800 +/- 5%`);

  // Per sector, so a bug that loses one whole sector cannot hide inside a
  // total that some other sector's overcount restores.
  for (const sector of ['wisdom', 'intelligence', 'dexterity', 'strength', 'constitution', 'charisma']) {
    const inSector = tree.nodes.filter((n) => n.sector === sector);
    assert.strictEqual(inSector.length, 296, `${sector} node count`); // 295 ring nodes + 1 start
    assert.strictEqual(inSector.filter((n) => n.kind === 'keystone').length, 5, `${sector} keystones`);
    assert.strictEqual(inSector.filter((n) => n.kind === 'notable').length, 40, `${sector} notables`);
  }
  assert.strictEqual(tree.nodes.filter((n) => n.sector === 'core').length, 30);
});

test('every key is unique, and 2142 edges are produced', () => {
  assert.strictEqual(new Set(tree.nodes.map((n) => n.key)).size, 1806);
  assert.strictEqual(tree.edges.length, 2142);
});

test('the six start nodes are the only nodes carrying a start_class', () => {
  const starts = tree.nodes.filter((n) => n.start_class !== null);
  assert.strictEqual(starts.length, 6);
  assert.deepStrictEqual(starts.map((n) => n.kind), ['start', 'start', 'start', 'start', 'start', 'start']);
  assert.deepStrictEqual(starts.map((n) => n.start_class).sort(),
    ['Archer', 'Cultist', 'Druid', 'Mage', 'Monk', 'Warrior']);
});

// ---- guard 2: no degree-0 node, no duplicate edge, no self-edge ----
test('guard 2: no self-edge, no duplicate edge, no isolated node', () => {
  const selfEdges = tree.edges.filter(([a, b]) => a === b);
  assert.deepStrictEqual(selfEdges, []);

  const seen = new Set();
  const dupes = [];
  for (const [a, b] of tree.edges) {
    // Ordering is part of the contract, so check it here rather than
    // normalising it away and then declaring there are no duplicates.
    assert.ok(a < b, `edge [${a}, ${b}] is not stored with keyA < keyB`);
    const id = `${a}|${b}`;
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepStrictEqual(dupes, []);

  const degree = new Map(tree.nodes.map((n) => [n.key, 0]));
  for (const [a, b] of tree.edges) {
    assert.ok(degree.has(a), `edge endpoint ${a} is not a node`);
    assert.ok(degree.has(b), `edge endpoint ${b} is not a node`);
    degree.set(a, degree.get(a) + 1);
    degree.set(b, degree.get(b) + 1);
  }
  const isolated = [...degree].filter(([, d]) => d === 0).map(([k]) => k);
  assert.deepStrictEqual(isolated, []);
});

// ---- guard 1: reachable from EVERY start ----
test('guard 1: every node is reachable from every one of the six start nodes', () => {
  const adj = new Map(tree.nodes.map((n) => [n.key, []]));
  for (const [a, b] of tree.edges) { adj.get(a).push(b); adj.get(b).push(a); }

  const starts = tree.nodes.filter((n) => n.kind === 'start').map((n) => n.key);
  assert.strictEqual(starts.length, 6);

  for (const start of starts) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.pop();
      for (const next of adj.get(cur)) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    // Name the orphans, not just the count: a bare count tells the next
    // person the tree is broken but not which cluster fell off.
    const unreachable = tree.nodes.map((n) => n.key).filter((k) => !seen.has(k));
    assert.deepStrictEqual(unreachable.slice(0, 10), [],
      `${unreachable.length} node(s) unreachable from ${start}`);
    assert.strictEqual(seen.size, 1806, `reachable-from-${start} count`);
  }
});

// ---- guard 3: every grants payload validates ----
test('guard 3: every grant validates against the known grant vocabulary', () => {
  const bad = [];
  for (const n of tree.nodes) {
    assert.ok(Array.isArray(n.grants), `${n.key} grants is not an array`);
    for (const g of n.grants) {
      const fail = (why) => bad.push(`${n.key}: ${why} (${JSON.stringify(g)})`);
      if (g.type !== 'rule' && !Number.isFinite(g.value)) fail('value is not finite');
      switch (g.type) {
        case 'stat': if (!STATS.includes(g.stat)) fail('unknown stat'); break;
        case 'resource': if (!POOLS.includes(g.pool)) fail('unknown resource pool'); break;
        case 'damage': if (!ELS.includes(g.element)) fail('unknown damage element'); break;
        case 'resist': if (!ELS.includes(g.element)) fail('unknown resist element'); break;
        case 'status': if (!STATUSES.includes(g.status)) fail('unknown status'); break;
        case 'rule':
          if (!RULES.includes(g.rule)) fail('unknown rule key');
          if (!Number.isFinite(g.value)) fail('rule value is not finite');
          break;
        default: fail('unknown grant type');
      }
      // '@sector' must be substituted by the generator, never persisted.
      if (g.stat === '@sector') fail('unsubstituted @sector placeholder');
    }
  }
  assert.deepStrictEqual(bad.slice(0, 10), []);
  assert.strictEqual(bad.length, 0);
});

test('a start node grants nothing — it is free, so it must also be inert', () => {
  for (const n of tree.nodes.filter((x) => x.kind === 'start')) {
    assert.deepStrictEqual(n.grants, []);
  }
});

// ---- guard 5: determinism ----
test('guard 5: two consecutive runs produce identical output', () => {
  const a = generatePassiveTree(PASSIVE_TREE_SPEC);
  const b = generatePassiveTree(PASSIVE_TREE_SPEC);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));

  // JSON.stringify serialises -0 as 0, so a sign-of-zero difference would slip
  // straight through the comparison above. -0 is a real hazard here because
  // every coordinate goes through Math.round, and Math.round(-0.4) is -0.
  for (let i = 0; i < a.nodes.length; i += 1) {
    assert.ok(Object.is(a.nodes[i].x, b.nodes[i].x), `node ${i} x differs by sign of zero`);
    assert.ok(Object.is(a.nodes[i].y, b.nodes[i].y), `node ${i} y differs by sign of zero`);
    assert.ok(!Object.is(a.nodes[i].x, -0), `node ${a.nodes[i].key} x is -0`);
    assert.ok(!Object.is(a.nodes[i].y, -0), `node ${a.nodes[i].key} y is -0`);
  }
});

test('coordinates are rounded to 2dp and stay inside the specced radius', () => {
  for (const n of tree.nodes) {
    assert.strictEqual(Math.round(n.x * 100) / 100, n.x, `${n.key} x is not 2dp`);
    assert.strictEqual(Math.round(n.y * 100) / 100, n.y, `${n.key} y is not 2dp`);
    // Outer ring is baseRadius 700 + 2 * rowStep 70 = 840; nothing may exceed it.
    assert.ok(Math.hypot(n.x, n.y) <= 840.01, `${n.key} is outside the outer ring`);
  }
});
