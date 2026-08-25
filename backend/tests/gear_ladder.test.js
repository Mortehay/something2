const test = require('node:test');
const assert = require('node:assert');
const { generateGearLadder } = require('../seeds/generateGearLadder.js');
const { GEAR_TIERS, GEAR_FAMILIES } = require('../seeds/data/gearLadder.js');

const SPEC = { tiers: GEAR_TIERS, families: GEAR_FAMILIES };

test('the ladder is 15 families x 10 tiers = 150 rows with unique names', () => {
  const rows = generateGearLadder(SPEC);
  assert.strictEqual(rows.length, 150);
  assert.strictEqual(new Set(rows.map((r) => r.name)).size, 150);
});

test('every one of the eight paper-doll slots is covered', () => {
  const rows = generateGearLadder(SPEC);
  const bySlot = {};
  for (const r of rows) bySlot[r.slot] = (bySlot[r.slot] || 0) + 1;
  // Hand-written: 3 main_hand families, 2 each for off_hand/head/chest/hands/feet,
  // 1 each for ring1/ring2, times 10 tiers.
  assert.deepStrictEqual(bySlot, {
    main_hand: 30, off_hand: 20, head: 20, chest: 20, hands: 20, feet: 20, ring1: 10, ring2: 10,
  });
});

test('the ten req_level rungs are exactly the specced ladder', () => {
  const rows = generateGearLadder(SPEC);
  const levels = [...new Set(rows.map((r) => r.req_level))].sort((a, b) => a - b);
  assert.deepStrictEqual(levels, [1, 10, 25, 40, 55, 70, 90, 110, 130, 150]);
});

test('tier 1 demands nothing beyond level 1 so a fresh character can wear it', () => {
  const rows = generateGearLadder(SPEC).filter((r) => r.tier === 1);
  assert.strictEqual(rows.length, 15);
  for (const r of rows) {
    assert.strictEqual(r.req_level, 1, r.name);
    for (const s of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
      assert.strictEqual(r[`req_${s}`], 0, `${r.name}.req_${s}`);
    }
  }
});

test('named rows carry hand-checked numbers', () => {
  const rows = generateGearLadder(SPEC);
  const byName = new Map(rows.map((r) => [r.name, r]));

  // crude-blade: family damage 6 x tier-1 power 1.0
  const crude = byName.get('crude-blade');
  assert.strictEqual(crude.category, 'weapon');
  assert.strictEqual(crude.kind, 'melee');
  assert.strictEqual(crude.slot, 'main_hand');
  assert.strictEqual(crude.damage, 6);
  assert.strictEqual(crude.reach, 80);
  assert.strictEqual(crude.arc_width, 1.2);
  assert.strictEqual(crude.defense, null);
  assert.strictEqual(crude.value, 10);

  // mythic-plate: family defense 3.0 x tier-10 power 14.5 = 43.5, req 116 STR
  const mythic = byName.get('mythic-plate');
  assert.strictEqual(mythic.category, 'armor');
  assert.strictEqual(mythic.slot, 'chest');
  assert.strictEqual(mythic.defense, 43.5);
  assert.strictEqual(mythic.req_level, 150);
  assert.strictEqual(mythic.req_strength, 116);
  assert.strictEqual(mythic.req_dexterity, 0);
  assert.strictEqual(mythic.item_level, 150);
  assert.strictEqual(mythic.tier, 10);
  assert.strictEqual(mythic.kind, null);

  // steel-wand: projectile, family damage 5 x tier-3 power 2.4 = 12
  const wand = byName.get('steel-wand');
  assert.strictEqual(wand.kind, 'projectile');
  assert.strictEqual(wand.damage, 12);
  assert.strictEqual(wand.range, 420);
  assert.strictEqual(wand.projectile_speed, 520);
  assert.strictEqual(wand.projectile_radius, 6);
  assert.strictEqual(wand.req_intelligence, 16);
  assert.strictEqual(wand.two_handed, false);

  // iron-spear is the two-handed family
  assert.strictEqual(byName.get('iron-spear').two_handed, true);
  assert.strictEqual(byName.get('iron-blade').two_handed, false);
});

test('every weapon row satisfies item_types_weapon_fields_check by construction', () => {
  for (const r of generateGearLadder(SPEC)) {
    if (r.category !== 'weapon') continue;
    assert.ok(r.kind === 'melee' || r.kind === 'projectile', r.name);
    if (r.kind === 'melee') {
      assert.ok(r.reach != null && r.arc_width != null, r.name);
    } else {
      assert.ok(r.range != null && r.projectile_speed != null && r.projectile_radius != null, r.name);
    }
  }
});

test('every armor row satisfies item_types_armor_fields_check by construction', () => {
  for (const r of generateGearLadder(SPEC)) {
    if (r.category !== 'armor') continue;
    assert.ok(r.slot != null, r.name);
    assert.ok(typeof r.defense === 'number' && r.defense > 0, r.name);
    assert.strictEqual(r.kind, null, r.name);
  }
});

test('two runs produce identical output', () => {
  assert.deepStrictEqual(generateGearLadder(SPEC), generateGearLadder(SPEC));
});

// ---------------------------------------------------------------------------
// ACCEPTANCE CRITERION 2: every rung is REACHABLE.
//
// Not asserted against a hand-computed ceiling, because a hand-computed
// ceiling assumes the tree hands out +2 per point wherever you like. It does
// not: a node is allocatable only when it is adjacent to one you already hold
// (spec 5.4), so getting to the stat nodes costs points too. This walks the
// REAL generated tree from the REAL class start node and greedily buys the
// cheapest path to more of the stat, which yields an UPPER BOUND on the true
// cost. An upper bound is the right shape here -- if the greedy allocator can
// afford the requirement, a player certainly can.
// ---------------------------------------------------------------------------

const { generatePassiveTree } = require('../seeds/generatePassiveTree.js');
const { PASSIVE_TREE_SPEC } = require('../seeds/data/passiveTree.js');

const TREE = generatePassiveTree(PASSIVE_TREE_SPEC);

function statGain(node, stat) {
  let n = 0;
  for (const g of node.grants || []) {
    if (g.type === 'stat' && g.stat === stat) n += g.value;
  }
  return n;
}

// Cheapest number of points to raise `stat` from base 5 to at least `target`,
// starting from `startKey`. Repeatedly BFSes the frontier for the node with
// the best gain-per-point and buys the whole path to it.
function pointsToReach(stat, target, startKey) {
  const byKey = new Map(TREE.nodes.map((n) => [n.key, n]));
  const adj = new Map(TREE.nodes.map((n) => [n.key, []]));
  for (const [a, b] of TREE.edges) { adj.get(a).push(b); adj.get(b).push(a); }

  const owned = new Set([startKey]);
  let total = 5 + statGain(byKey.get(startKey), stat);
  let spent = 0;

  while (total < target) {
    // BFS from the owned frontier, recording the path cost to every node.
    const prev = new Map();
    const dist = new Map();
    const queue = [];
    for (const k of owned) { dist.set(k, 0); queue.push(k); }
    for (let i = 0; i < queue.length; i += 1) {
      const k = queue[i];
      for (const nb of adj.get(k)) {
        if (dist.has(nb)) continue;
        dist.set(nb, dist.get(k) + 1);
        prev.set(nb, k);
        queue.push(nb);
      }
    }
    let best = null;
    let bestRatio = 0;
    for (const [k, d] of dist) {
      if (owned.has(k)) continue;
      const g = statGain(byKey.get(k), stat);
      if (g <= 0) continue;
      // Gain is capped at what is still NEEDED. Without the cap the walk buys
      // a +30 ring-3 notable twenty steps away (ratio 1.5) in preference to a
      // +2 minor two steps away (ratio 1.0) when the shortfall is 3 -- which
      // measures the tree's endgame, not the rung being checked.
      const ratio = Math.min(g, target - total) / d;
      if (ratio > bestRatio) { bestRatio = ratio; best = k; }
    }
    if (best === null) return Infinity;  // no more of this stat anywhere
    // Buy the whole path to `best`.
    let cur = best;
    const path = [];
    while (!owned.has(cur)) { path.push(cur); cur = prev.get(cur); }
    for (const k of path) {
      owned.add(k);
      total += statGain(byKey.get(k), stat);
      spent += 1;
    }
  }
  return spent;
}

// The nine rungs above tier 1, and the stat each family gates on. Hand-written
// from gearLadder.js's authored tables rather than derived from them: if
// someone lowers stat_req to make this pass, that is the change this test is
// here to notice.
const RUNGS = [
  { level: 10, stat_req: 8 },
  { level: 25, stat_req: 16 },
  { level: 40, stat_req: 26 },
  { level: 55, stat_req: 36 },
  { level: 70, stat_req: 48 },
  { level: 90, stat_req: 62 },
  { level: 110, stat_req: 78 },
  { level: 130, stat_req: 96 },
  { level: 150, stat_req: 116 },
];

test('the authored stat_req per rung matches what the reachability check assumes', () => {
  const seen = GEAR_TIERS.filter((t) => t.tier > 1).map((t) => ({ level: t.req_level, stat_req: t.stat_req }));
  assert.deepStrictEqual(seen, RUNGS);
});

test('every rung is affordable in-sector with the points that level grants', () => {
  // passive_points_per_level is 1 (gameSettings DEFAULTS) and points are
  // granted per level GAINED, so a character at level L has L-1 of them.
  for (const stat of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
    const startKey = `start-${stat}`;
    for (const rung of RUNGS) {
      const cost = pointsToReach(stat, rung.stat_req, startKey);
      assert.ok(
        cost <= rung.level - 1,
        `${stat} ${rung.stat_req} at level ${rung.level}: costs ${cost}, only ${rung.level - 1} points available`,
      );
    }
  }
});
