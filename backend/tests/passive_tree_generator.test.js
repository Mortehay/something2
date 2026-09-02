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
const {
  PASSIVE_TREE_SPEC, RULE_KEYS, TEMPLATES, CLUSTERS,
} = require('../seeds/data/passiveTree.js');
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
// Hand-written, like every other expectation here -- importing RULE_COMBINE
// would make this a tautology. Grew from 4 to 13 across SOMET-514..522; a rule
// authored into a node but missing from this list fails guard 3, which is the
// point.
const RULES = [
  'lifeCostMultiplier', 'treeCharmBonus', 'cooldownFloor', 'regenLifeShare',
  'attackSpeedMult', 'castSpeedMult', 'meleeReachBonus', 'meleeArcBonus',
  'projectileCount', 'projectileSpeedMult', 'pierceBonus',
  'auraLeech', 'auraRadius', 'meleeDamageMult', 'meleeWaveShare',
];

const tree = generatePassiveTree(PASSIVE_TREE_SPEC);

test('the hand-written element list still matches the combat authority', () => {
  assert.deepStrictEqual(ELS, ELEMENTS);
});

// ---- guard 4: node count within 5% of 1800, keystones exactly as specced ----
test('guard 4: 1852 nodes — 1494 minor, 274 notable, 36+12 greater, 30 keystone, 6 start', () => {
  assert.strictEqual(tree.nodes.length, 1852);

  const byKind = {};
  for (const n of tree.nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
  // greater 47 = 36 placed on the ring-3 grid (SOMET-517) + 11 cluster hubs
  // (SOMET-518, plus SOMET-527's Spearpoint and Sweep). notable 272 = 240 grid
  // + 32 cluster satellites.
  assert.deepStrictEqual(byKind,
    { minor: 1494, notable: 274, greater: 48, keystone: 30, start: 6 });

  // The spec's own tolerance, restated as a literal band rather than a formula.
  assert.ok(tree.nodes.length >= 1710 && tree.nodes.length <= 1890,
    `node count ${tree.nodes.length} is outside 1800 +/- 5%`);

  // Per sector, so a bug that loses one whole sector cannot hide inside a
  // total that some other sector's overcount restores.
  // SOMET-518: a sector now also carries its epic clusters, and they are NOT
  // evenly distributed (strength/dexterity/intelligence have two each, the
  // rest one). The expected contribution is counted from the AUTHORED cluster
  // list, which makes this a cross-check that the generator emitted exactly
  // what the spec asked for -- not a tautology, since the two are produced by
  // different code.
  const clusterNodesIn = (sector) => CLUSTERS
    .filter((c) => c.sector === sector)
    .reduce((a, c) => a + 1 + c.satellites.length, 0);
  for (const sector of ['wisdom', 'intelligence', 'dexterity', 'strength', 'constitution', 'charisma']) {
    const inSector = tree.nodes.filter((n) => n.sector === sector);
    // 295 ring nodes + 1 start, plus this sector's cluster nodes.
    assert.strictEqual(inSector.length, 296 + clusterNodesIn(sector), `${sector} node count`);
    assert.strictEqual(inSector.filter((n) => n.kind === 'keystone').length, 5, `${sector} keystones`);
    const satellites = CLUSTERS.filter((c) => c.sector === sector)
      .reduce((a, c) => a + c.satellites.length, 0);
    assert.strictEqual(inSector.filter((n) => n.kind === 'notable').length, 40 + satellites,
      `${sector} notables`);
  }
  assert.strictEqual(tree.nodes.filter((n) => n.sector === 'core').length, 30);
});

test('every key is unique, and 2428 edges are produced', () => {
  const keys = new Set(tree.nodes.map((n) => n.key));
  assert.strictEqual(keys.size, 1852);
  assert.strictEqual(tree.edges.length, 2428);
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
    assert.strictEqual(seen.size, 1852, `reachable-from-${start} count`);
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
      // SOMET-516's second placeholder, same rule: it must never be persisted.
      if (g.stat === '@other') fail('unsubstituted @other placeholder');
    }
  }
  assert.deepStrictEqual(bad.slice(0, 10), []);
  assert.strictEqual(bad.length, 0);
});

// ---- start nodes: contract 6.11's option 3 ----
//
// THIS REPLACES C1's RULE. That test asserted "a start node grants nothing --
// it is free, so it must also be inert". SOMET-471 reverses it under contract
// 6.11, which makes the start node the place a class's MECHANICAL identity is
// granted, so the generator's start-node handling and this test changed
// together.
//
// The replacement asserts the grants are THE INTENDED PER-CLASS ONES, keyed by
// start_class, against hand-written literals. A weaker "a start node grants
// something" -- or a non-empty check, or a count -- would pass for any typo:
// the Druid granting the Cultist's rule, a value of 10 where 0.1 was meant, or
// all six granting the same thing would all satisfy it, and none of those has
// an in-game symptom a player could report.
test('each start node grants exactly its own class identity (contract 6.11)', () => {
  const byClass = {};
  for (const n of tree.nodes.filter((x) => x.kind === 'start')) {
    assert.strictEqual(byClass[n.start_class], undefined,
      `two start nodes claim ${n.start_class}`);
    byClass[n.start_class] = n.grants;
  }
  assert.deepStrictEqual(byClass, {
    // == min_edge (+3 physical), the ring-1 minor used as the yardstick: a
    // start node is free, so it may be worth at most the cheapest bought node.
    Warrior: [{ type: 'damage', element: 'physical', value: 3 }],
    Mage: [{ type: 'damage', element: 'arcane', value: 3 }],
    // Each rule is the smallest step of the rule its own sector's keystones
    // deepen: Fleet 0.32, Clarity 0.2, Blood Pact 0.75, Pack Leader +3.
    Archer: [{ type: 'rule', rule: 'cooldownFloor', value: 0.38 }],
    Monk: [{ type: 'rule', rule: 'regenLifeShare', value: 0.1 }],
    Cultist: [{ type: 'rule', rule: 'lifeCostMultiplier', value: 0.9 }],
    Druid: [{ type: 'rule', rule: 'treeCharmBonus', value: 1 }],
  });
});

test('NO start node grants a raw pool bonus (contract 6.11)', () => {
  // The line that keeps option 1 and option 3 apart. A class's pools come from
  // entity_types.max_hp/max_mana; a start node that also granted hp or mana
  // would pay that class twice for being what it is. Stated separately from
  // the literal above so the RULE survives a future retune of the values --
  // someone editing the six grants will edit the literal, and this is what
  // still refuses `{ type: 'resource', pool: 'hp' }` afterwards.
  const offenders = [];
  for (const n of tree.nodes.filter((x) => x.kind === 'start')) {
    for (const g of n.grants) {
      if (g.type === 'resource') offenders.push(`${n.start_class}: ${JSON.stringify(g)}`);
    }
  }
  assert.deepStrictEqual(offenders, []);
});

test('the six start-node grants are comparable in weight', () => {
  // They are FREE, so no class may open with more of them than another. One
  // grant each -- and, since the two damage grants are the only numeric ones,
  // they must be equal to each other and to min_edge's +3.
  const starts = tree.nodes.filter((x) => x.kind === 'start');
  assert.deepStrictEqual(starts.map((n) => n.grants.length), [1, 1, 1, 1, 1, 1]);
  const damage = starts.flatMap((n) => n.grants.filter((g) => g.type === 'damage'));
  assert.deepStrictEqual(damage.map((g) => g.value), [3, 3]);
});

test('every start-node rule grant names a rule that has a declared consumer', () => {
  // A `rule` grant nobody reads is a node the player cannot tell apart from a
  // working one. RULE_KEYS makes `consumer` mandatory for exactly that reason;
  // this checks the six free nodes actually obey it, since they are the grants
  // every character gets whether or not they ever open the tree.
  for (const n of tree.nodes.filter((x) => x.kind === 'start')) {
    for (const g of n.grants.filter((x) => x.type === 'rule')) {
      const def = RULE_KEYS[g.rule];
      assert.ok(def, `${n.start_class} grants unknown rule ${g.rule}`);
      assert.equal(typeof def.consumer, 'string');
      assert.ok(def.consumer.length > 0, `${g.rule} has no consumer`);
    }
  }
});

test('start_class values match the classes entity_types can actually roll', () => {
  // start_class is resolved by services/passiveTreeStore.js as a JOIN on
  // entity_types.name. A misspelling here is a class whose tree is silently
  // unreachable -- startNodeIdFor returns null and every caller refuses.
  // six_classes_db.test.js pins the other side of this join.
  const starts = tree.nodes.filter((x) => x.kind === 'start');
  assert.deepStrictEqual(starts.map((n) => n.start_class).sort(),
    ['Archer', 'Cultist', 'Druid', 'Mage', 'Monk', 'Warrior']);
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
    // Outer ring is baseRadius 700 + 2 * rowStep 70 = 840. SOMET-518's epic
    // clusters sit deliberately OUTSIDE that, at clusterRadius 960 with
    // satellites 62px around their hub, so the outermost thing in the tree is
    // at 1022. Hand-computed, not read from LAYOUT: deriving the bound from
    // the same constants the generator uses would assert nothing.
    assert.ok(Math.hypot(n.x, n.y) <= 1022.01, `${n.key} is outside the cluster ring`);
  }
});

// ===========================================================================
// SOMET-515 / SOMET-516: the stat spread.
//
// Before these tickets every connective minor granted `@sector`, so the
// constitution sector contained ZERO intelligence nodes -- while a Cultist
// casts with spellMult, which derivePlayerStats derives from INTELLIGENCE.
// Building a caster meant leaving your own sector on the very first node.
//
// These are the tests that keep the ratio real. Without them "70/30" is a
// comment, and the next balance pass drifts it without anyone noticing.
// ===========================================================================

function statGrantsBySector() {
  const { nodes } = generatePassiveTree(PASSIVE_TREE_SPEC);
  const per = new Map();
  for (const n of nodes) {
    // Ring 0 is the core and the start nodes: no sector stat, no stat grants.
    if (n.ring === 0) continue;
    for (const g of n.grants) {
      if (g.type !== 'stat') continue;
      if (!per.has(n.sector)) per.set(n.sector, { own: 0, off: new Map() });
      const rec = per.get(n.sector);
      if (g.stat === n.sector) rec.own += 1;
      else rec.off.set(g.stat, (rec.off.get(g.stat) || 0) + 1);
    }
  }
  return per;
}

test('every sector grants its own stat about 70% of the time', () => {
  const per = statGrantsBySector();
  assert.equal(per.size, 6, 'all six sectors must grant stats');
  for (const [sector, rec] of per) {
    const off = [...rec.off.values()].reduce((a, b) => a + b, 0);
    const share = rec.own / (rec.own + off);
    assert.ok(share >= 0.67 && share <= 0.73,
      `${sector} own-stat share is ${(share * 100).toFixed(1)}%, expected 70% +-3`);
  }
});

// "Evenly across the other five" is a claim, and this is what checks it. A
// hash-based off-stat pick would clump and pass the ratio test above while
// leaving one stat nearly absent from a sector.
test('off-stat grants are spread evenly over the other five stats', () => {
  const per = statGrantsBySector();
  for (const [sector, rec] of per) {
    assert.equal(rec.off.size, 5, `${sector} must offer all five other stats`);
    assert.ok(!rec.off.has(sector), `${sector} must not count its own stat as off-stat`);
    const counts = [...rec.off.values()];
    const lo = Math.min(...counts);
    const hi = Math.max(...counts);
    assert.ok(hi - lo <= Math.max(4, hi * 0.35),
      `${sector} off-stat spread is uneven: ${JSON.stringify([...rec.off])}`);
  }
});

// The point of the whole exercise, stated as a number rather than a feeling:
// a Cultist must be able to build real INT inside the constitution sector.
// Measured in POINTS, not nodes: a node is worth 2, 3, 4, 8, 12 or 16, so a
// node count says nothing about whether a build is reachable. 34 points on a
// base stat of 5 is roughly a sevenfold increase, entirely inside the
// Cultist's own sector -- which is the whole point of the 70/30 change.
test('a Cultist can reach substantial INT without leaving their own sector', () => {
  const { nodes } = generatePassiveTree(PASSIVE_TREE_SPEC);
  let points = 0;
  for (const n of nodes) {
    if (n.ring === 0 || n.sector !== 'constitution') continue;
    for (const g of n.grants) {
      if (g.type === 'stat' && g.stat === 'intelligence') points += g.value;
    }
  }
  assert.ok(points >= 30,
    `the constitution sector offers only ${points} points of INT; a Cultist casts with INT`);
});

// The same must hold in the other direction and for every pairing -- a Monk
// who wants to melee needs STR at home just as much. Asserting all thirty
// sector/off-stat pairs is what stops one lucky sector standing in for the
// rest.
test('every sector offers a usable amount of every other stat', () => {
  const { nodes } = generatePassiveTree(PASSIVE_TREE_SPEC);
  const points = new Map();
  for (const n of nodes) {
    if (n.ring === 0) continue;
    for (const g of n.grants) {
      if (g.type !== 'stat' || g.stat === n.sector) continue;
      const key = `${n.sector}->${g.stat}`;
      points.set(key, (points.get(key) || 0) + g.value);
    }
  }
  assert.equal(points.size, 30, 'six sectors x five off-stats');
  for (const [pair, total] of points) {
    assert.ok(total >= 30, `${pair} offers only ${total} points`);
  }
});

// Determinism is contractual: no Math.random(), no Date.now(). The round-robin
// cursor is state, so this is the test that proves the state does not leak
// between runs.
test('the tree is byte-identical across runs after the spread change', () => {
  const a = generatePassiveTree(PASSIVE_TREE_SPEC);
  const b = generatePassiveTree(PASSIVE_TREE_SPEC);
  assert.deepStrictEqual(a, b);
});

// A core node has no sector, so `@other` there has no meaning. The generator
// deliberately does not fall back -- a fallback would make the mistake
// invisible -- so the spec must never put one on a core template.
test('no core template asks for an off-stat', () => {
  const core = TEMPLATES.filter((t) => t.sectors !== '*' && t.sectors.includes('core'));
  for (const t of core) {
    for (const g of t.grants) {
      assert.notEqual(g.stat, '@other', `core template ${t.key} cannot resolve @other`);
    }
  }
});

// Weights are what make the ratio authored rather than accidental. A weight of
// 0 or a negative would silently drop a template from every pool.
test('every template weight is a positive integer when present', () => {
  for (const t of TEMPLATES) {
    if (t.weight === undefined) continue;
    assert.ok(Number.isInteger(t.weight) && t.weight > 0,
      `template ${t.key} has weight ${t.weight}`);
  }
});

// ===========================================================================
// SOMET-518: epic clusters.
//
// A hub plus 2 or 4 satellites. The satellites' edge topology IS the feature:
// each has exactly one neighbour, its own hub, so isAllocatable's walk cannot
// reach an increaser until the epic it increases has been bought. Structural,
// not a rule anyone has to remember to enforce.
// ===========================================================================

const { buildAdjacency, isAllocatable } = require('../src/services/passiveRules.js');

function clusterTree() { return generatePassiveTree(PASSIVE_TREE_SPEC); }

test('every authored cluster produces a hub and all of its satellites', () => {
  const { nodes } = clusterTree();
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  for (const c of CLUSTERS) {
    const hub = byKey.get(`${c.key}-hub`);
    assert.ok(hub, `${c.key} has no hub node`);
    assert.equal(hub.label, c.hubLabel);
    assert.equal(hub.sector, c.sector, 'a cluster must sit in its own class sector');
    c.satellites.forEach((sat, i) => {
      const s = byKey.get(`${c.key}-sat${i}`);
      assert.ok(s, `${c.key} satellite ${i} missing`);
      assert.equal(s.label, sat.label);
    });
  }
});

// THE TEST THE TICKET WAS WRITTEN AROUND.
test('a satellite is adjacent to exactly its own hub and nothing else', () => {
  const { edges } = clusterTree();
  const adj = buildAdjacency(edges);
  for (const c of CLUSTERS) {
    c.satellites.forEach((_, i) => {
      const key = `${c.key}-sat${i}`;
      const neighbours = adj.get(key) || [];
      assert.deepStrictEqual(neighbours, [`${c.key}-hub`],
        `${key} must have exactly one neighbour, its own hub`);
    });
  }
});

// The same fact stated through the real allocation rule rather than through
// the edge list -- if isAllocatable ever stopped consulting adjacency, the
// topology test above would still pass while the gate was gone.
test('a satellite is not allocatable until its hub is', () => {
  const { edges } = clusterTree();
  const adj = buildAdjacency(edges);
  const c = CLUSTERS[0];
  const hub = `${c.key}-hub`;
  const sat = `${c.key}-sat0`;
  // Pretend the whole tree except this cluster is allocated: still no.
  const everythingElse = new Set([...adj.keys()].filter((k) => k !== hub && k !== sat));
  assert.equal(isAllocatable(sat, everythingElse, adj, 'start-strength'), false,
    'a satellite must be unreachable while its hub is unallocated');
  assert.equal(isAllocatable(sat, new Set([hub]), adj, 'start-strength'), true,
    'and reachable once the hub is taken');
});

// A hub that nothing links to would be an unreachable island: the cluster
// would exist in the database and be unbuyable.
test('every hub is reachable from the rest of the graph', () => {
  const { edges } = clusterTree();
  const adj = buildAdjacency(edges);
  for (const c of CLUSTERS) {
    const key = `${c.key}-hub`;
    const neighbours = adj.get(key) || [];
    const outside = neighbours.filter((n) => !n.startsWith(`${c.key}-`));
    assert.ok(outside.length >= 1, `${key} has no edge to the rest of the tree`);
  }
});

// Every cluster grant must name a rule the runtime actually reads. A typo here
// is a node that looks epic and does nothing -- the exact failure SOMET-514
// spent a ticket undoing.
test('every cluster grants a rule that exists in the vocabulary', () => {
  for (const c of CLUSTERS) {
    for (const g of [...c.hubGrants, ...c.satellites.flatMap((s) => s.grants)]) {
      assert.equal(g.type, 'rule', `${c.key} grants a non-rule`);
      assert.ok(RULE_KEYS[g.rule], `${c.key} grants unknown rule "${g.rule}"`);
    }
  }
});

// Clusters replaced ks_wis_clarity and ks_cha_beast_bond. Shipping both would
// pay the Monk and the Druid twice for one idea.
// Narrowly: the two keystones the clusters REPLACED must be gone, by key. It
// is fine and intended for other keystones to grant a smaller step of the same
// rule -- ks_cha_pack_leader's +3 charm sits deliberately between the Druid
// start node's +1 and the Beast Bond cluster's +5. What must not happen is
// shipping the replaced keystone AND its cluster, which would pay the class
// twice for one idea.
test('the two keystones the clusters replaced are gone', () => {
  const { nodes } = clusterTree();
  const labels = new Set(nodes.map((n) => n.label));
  const keys = new Set(nodes.map((n) => n.key));
  for (const gone of ['ks_wis_clarity', 'ks_cha_beast_bond']) {
    assert.ok(!keys.has(gone), `${gone} was replaced by a cluster and must not be generated`);
  }
  // And each replaced idea now exists exactly once, as the cluster hub.
  for (const label of ['Clarity', 'Beast Bond']) {
    const count = nodes.filter((n) => n.label === label).length;
    assert.equal(count, 1, `"${label}" must exist exactly once, as the cluster hub`);
  }
  // Keystone labels carry their description ("Transcendence — +35 WIS ..."),
  // so this matches the name, not the whole string.
  const named = (name) => [...labels].some((l) => l.startsWith(name));
  assert.ok(named('Transcendence'), 'the wisdom keystone slot must be refilled');
  assert.ok(named('Menagerie'), 'the charisma keystone slot must be refilled');
});
