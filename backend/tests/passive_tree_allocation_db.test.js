// backend/tests/passive_tree_allocation_db.test.js
//
// Allocation and respec against a real database. The properties here are all
// transactional or FK-shaped and none of them can be seen against a stub:
// that a node two edges away is refused, that the budget cannot be overspent
// by two concurrent requests, that a respec charges gold and clears every
// allocation, and that a failed payment leaves the allocations intact.
//
// Requires the scratch DB from this plan's header (migrated + seeded).
// seedPassiveTree() is called below rather than assumed, so the file is
// self-sufficient on a freshly-migrated database.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const {
  loadTree, startNodeIdFor, loadAllocatedIds, allocateNode, respecPassives, passiveBundle,
} = require('../src/services/passiveTreeStore.js');
const { loadProgression } = require('../src/services/progressionStore.js');
const { seedPassiveTree } = require('../scripts/seed-passive-tree.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to mutate a real database (this test writes characters)'
  : false;

test('passive allocation', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 8 });
  const made = { users: [] };
  t.after(async () => {
    // client.release() does NOT roll back -- an explicit delete is the only
    // cleanup that actually happens. characters and player_progression both
    // cascade from users.
    if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
    await pool.end();
  });

  await seedPassiveTree(pool, { quiet: true });

  const warriorType = await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'");
  const mageType = await pool.query("SELECT id FROM entity_types WHERE name = 'Mage'");
  const rangerType = await pool.query("SELECT id FROM entity_types WHERE name = 'Ranger'");

  let n = 0;
  // `points` is written EXPLICITLY on every fixture rather than derived from
  // `level`. T2 owns the grant rule; a test that reproduced it here would pass
  // whether or not the two agreed.
  //
  // The six stat columns are deliberately left at their default of 5:
  // progression_migration.test.js asserts every character in the database
  // still carries the base-5 class snapshot (contract §6.1), and a fixture
  // with a raised column turns that unrelated file red.
  async function makeCharacter(entityTypeId, { level = 50, gold = 100000, points = 49 } = {}) {
    n += 1;
    const tag = `passalloc-${process.pid}-${Date.now()}-${n}`;
    const u = await pool.query(
      'INSERT INTO users (username, password_hash, role, gold) VALUES ($1, $2, $3, $4) RETURNING id',
      [tag, 'x', 'player', gold],
    );
    made.users.push(u.rows[0].id);
    const c = await pool.query(
      'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3) RETURNING id',
      [u.rows[0].id, tag, entityTypeId],
    );
    await pool.query(
      'INSERT INTO player_progression (character_id, level, passive_points) VALUES ($1, $2, $3)',
      [c.rows[0].id, level, points],
    );
    return { userId: u.rows[0].id, characterId: c.rows[0].id };
  }

  const tree = await loadTree(pool);
  const byKey = new Map(tree.nodes.map((x) => [x.key, x]));
  const startStr = byKey.get('start-strength').id;
  const adjacent = byKey.get('strength-r1-0-8').id;      // the start's ring-1 entry
  const twoAway = byKey.get('strength-r1-0-9').id;       // one further along the row
  const otherSector = byKey.get('wisdom-r1-0-8').id;

  await t.test('resolves a start node from the character class, not from main_stat', async () => {
    const w = await makeCharacter(warriorType.rows[0].id);
    assert.strictEqual(await startNodeIdFor(pool, w.characterId), startStr);
    const m = await makeCharacter(mageType.rows[0].id);
    assert.strictEqual(await startNodeIdFor(pool, m.characterId),
      byKey.get('start-intelligence').id);
  });

  await t.test('a class with no start node resolves to null, not to a default', async () => {
    const r = await makeCharacter(rangerType.rows[0].id);
    assert.strictEqual(await startNodeIdFor(pool, r.characterId), null);
    const res = await allocateNode(pool, r.characterId, adjacent);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'class has no passive start node');
  });

  await t.test('allocates a node adjacent to the start, and refuses one two edges out', async () => {
    const w = await makeCharacter(warriorType.rows[0].id);
    const far = await allocateNode(pool, w.characterId, twoAway);
    assert.strictEqual(far.ok, false);
    assert.strictEqual(far.reason, 'node is not reachable yet');

    const near = await allocateNode(pool, w.characterId, adjacent);
    assert.strictEqual(near.ok, true);
    assert.deepStrictEqual(near.allocatedNodeIds, [adjacent]);

    const now = await allocateNode(pool, w.characterId, twoAway);
    assert.strictEqual(now.ok, true);
    assert.deepStrictEqual(await loadAllocatedIds(pool, w.characterId), [adjacent, twoAway].sort((a, b) => a - b));
  });

  await t.test('another sector is unreachable until the core has been crossed', async () => {
    const w = await makeCharacter(warriorType.rows[0].id);
    const res = await allocateNode(pool, w.characterId, otherSector);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'node is not reachable yet');
  });

  await t.test('the start node itself cannot be allocated', async () => {
    const w = await makeCharacter(warriorType.rows[0].id);
    const res = await allocateNode(pool, w.characterId, startStr);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'start node is granted, not allocated');
  });

  await t.test('an unknown node id is refused rather than inserted', async () => {
    const w = await makeCharacter(warriorType.rows[0].id);
    const res = await allocateNode(pool, w.characterId, 99999999);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'unknown node');
    const bad = await allocateNode(pool, w.characterId, 'not-a-number');
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, 'invalid node');
    // Nothing was spent by either refusal.
    const r = await pool.query('SELECT passive_points FROM player_progression WHERE character_id = $1', [w.characterId]);
    assert.strictEqual(Number(r.rows[0].passive_points), 49);
  });

  await t.test('the same node cannot be allocated twice', async () => {
    const w = await makeCharacter(warriorType.rows[0].id);
    assert.strictEqual((await allocateNode(pool, w.characterId, adjacent)).ok, true);
    const again = await allocateNode(pool, w.characterId, adjacent);
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, 'already allocated');
  });

  await t.test('a character with an empty wallet cannot allocate', async () => {
    const w = await makeCharacter(warriorType.rows[0].id, { level: 1, points: 0 });
    const res = await allocateNode(pool, w.characterId, adjacent);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'no passive points');
    assert.deepStrictEqual(await loadAllocatedIds(pool, w.characterId), []);
  });

  await t.test('an allocation spends exactly one point from the column', async () => {
    const w = await makeCharacter(warriorType.rows[0].id, { points: 3 });
    const res = await allocateNode(pool, w.characterId, adjacent);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.passivePoints, 2);
    const r = await pool.query('SELECT passive_points FROM player_progression WHERE character_id = $1', [w.characterId]);
    assert.strictEqual(Number(r.rows[0].passive_points), 2);
  });

  await t.test('the wallet cannot be overspent by concurrent requests', async () => {
    // Exactly one point in the column. Fire two allocations of two different,
    // both legal, nodes at once; exactly one must win. Without the guard in
    // the UPDATE's WHERE clause both read "1 available" and both insert.
    const w = await makeCharacter(warriorType.rows[0].id, { points: 2 });
    const a = byKey.get('strength-r1-0-7').id;
    const b = byKey.get('strength-r1-0-9').id;
    await allocateNode(pool, w.characterId, adjacent); // 2 -> 1, and opens a and b
    const results = await Promise.all([
      allocateNode(pool, w.characterId, a),
      allocateNode(pool, w.characterId, b),
    ]);
    assert.strictEqual(results.filter((r) => r.ok).length, 1);
    assert.strictEqual((await loadAllocatedIds(pool, w.characterId)).length, 2);
    const r = await pool.query('SELECT passive_points FROM player_progression WHERE character_id = $1', [w.characterId]);
    assert.strictEqual(Number(r.rows[0].passive_points), 0);
  });

  await t.test('respec clears every allocation, refunds the points and charges base x level', async () => {
    const w = await makeCharacter(warriorType.rows[0].id, { level: 40, gold: 5000, points: 10 });
    await allocateNode(pool, w.characterId, adjacent);
    await allocateNode(pool, w.characterId, twoAway);

    const res = await respecPassives(pool, w.userId, w.characterId);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.cost, 2000);   // respec_base_gold 50 x level 40
    assert.strictEqual(res.gold, 3000);
    assert.strictEqual(res.refunded, 2);
    assert.strictEqual(res.passivePoints, 10);  // 10 - 2 spent + 2 refunded
    assert.deepStrictEqual(res.allocatedNodeIds, []);
    assert.deepStrictEqual(await loadAllocatedIds(pool, w.characterId), []);
  });

  await t.test('respec refunds what was SPENT, not what the level would grant', async () => {
    // A character carrying refunded pre-epic stat points (contract §6.7) has a
    // wallet that is not a function of level. A level-derived refund would
    // either destroy those points or mint them twice.
    const w = await makeCharacter(warriorType.rows[0].id, { level: 3, gold: 5000, points: 40 });
    await allocateNode(pool, w.characterId, adjacent);
    const res = await respecPassives(pool, w.userId, w.characterId);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.passivePoints, 40);
  });

  await t.test('a respec that cannot be paid for changes nothing at all', async () => {
    const w = await makeCharacter(warriorType.rows[0].id, { level: 40, gold: 10, points: 5 });
    await allocateNode(pool, w.characterId, adjacent);

    const res = await respecPassives(pool, w.userId, w.characterId);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'not enough gold');
    assert.strictEqual(res.cost, 2000);
    assert.deepStrictEqual(await loadAllocatedIds(pool, w.characterId), [adjacent]);
    const g = await pool.query('SELECT gold FROM users WHERE id = $1', [w.userId]);
    assert.strictEqual(Number(g.rows[0].gold), 10);
    const p = await pool.query('SELECT passive_points FROM player_progression WHERE character_id = $1', [w.characterId]);
    assert.strictEqual(Number(p.rows[0].passive_points), 4);  // still spent, not refunded
  });

  await t.test('the bundle itemises the allocated grants', async () => {
    const w = await makeCharacter(warriorType.rows[0].id, { level: 10, points: 9 });
    await allocateNode(pool, w.characterId, adjacent);
    const bundle = await passiveBundle(pool, w.characterId);

    assert.deepStrictEqual(bundle.allocatedNodeIds, [adjacent]);
    assert.strictEqual(bundle.passives.length >= 1, true);
    assert.strictEqual(typeof bundle.passives[0].label, 'string');
    // The wallet is NOT the bundle's job -- it lives on the progression row.
    assert.strictEqual('passivePoints' in bundle, false);
  });

  await t.test('the composed row carries effective totals, the wallet and the breakdown', async () => {
    // Contract §6.2: `effective` is what clients render. The six top-level keys
    // carry the same numbers so derivePlayerStats keeps working unchanged.
    const w = await makeCharacter(warriorType.rows[0].id, { level: 10, points: 9 });
    await allocateNode(pool, w.characterId, adjacent);   // strength-r1-0-8, a minor
    const row = await loadProgression(pool, w.characterId);

    assert.strictEqual(row.passivePoints, 8);
    assert.deepStrictEqual(row.allocatedNodeIds, [adjacent]);
    assert.strictEqual(row.effective.strength, row.strength);
    assert.strictEqual(row.sources.strength.base, 5);
    assert.strictEqual(row.sources.strength.gear, 0);
    assert.strictEqual(row.modifiers.length >= 1, true);
    assert.strictEqual(row.rules.lifeCostMultiplier, 1);
    assert.strictEqual(row.rules.treeCharmBonus, 0);
  });

  // Not in the plan. The composed row is only useful if a stat-granting node
  // actually MOVES the effective total and the derived numbers that read it.
  // Every assertion above allocates strength-r1-0-8, which grants `damage`,
  // not `stat` -- so all of them would still pass if the tree contribution
  // were dropped on the floor. This is the one that would not.
  await t.test('a stat-granting node moves both effective and derived numbers', async () => {
    const { derivePlayerStats } = require('../src/services/playerStats.js');
    // Find a strength-sector node adjacent to a node adjacent to the start,
    // whose grants include a strength stat. Walked from the real seeded tree
    // rather than hard-coded, because the generator owns which minor gets
    // which grant -- but the EXPECTED numbers below are hand-written.
    const adj = new Map();
    for (const [a, b] of tree.edges) {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b);
      adj.get(b).push(a);
    }
    const statGrant = (node) => (node.grants || []).find((g) => g.type === 'stat' && g.stat === 'strength');
    const byId = new Map(tree.nodes.map((x) => [x.id, x]));
    // Breadth-first from the start node, collecting the shortest path to the
    // first node that grants strength.
    const prev = new Map([[startStr, null]]);
    const queue = [startStr];
    let target = null;
    while (queue.length && !target) {
      const cur = queue.shift();
      for (const nb of adj.get(cur) || []) {
        if (prev.has(nb)) continue;
        prev.set(nb, cur);
        if (statGrant(byId.get(nb))) { target = nb; break; }
        queue.push(nb);
      }
    }
    assert.ok(target, 'the seeded tree has no reachable node granting strength');
    const path = [];
    for (let cur = target; cur !== startStr; cur = prev.get(cur)) path.unshift(cur);

    const w = await makeCharacter(warriorType.rows[0].id, { level: 10, points: 40 });
    const beforeRow = await loadProgression(pool, w.characterId);
    const beforeStats = derivePlayerStats(beforeRow);
    assert.strictEqual(beforeRow.effective.strength, 5, 'a fresh character bases at 5');

    for (const id of path) {
      const r = await allocateNode(pool, w.characterId, id);
      assert.strictEqual(r.ok, true, `allocating ${id} on the path failed: ${r.reason}`);
    }

    const afterRow = await loadProgression(pool, w.characterId);
    const granted = statGrant(byId.get(target)).value;
    assert.strictEqual(afterRow.effective.strength, 5 + granted);
    assert.strictEqual(afterRow.strength, 5 + granted,
      'the top-level key must carry the composed total, or derivePlayerStats ignores the tree');
    assert.deepStrictEqual(afterRow.sources.strength, { base: 5, tree: granted, gear: 0 });
    // meleeMult reads strength; if the composed total never reached
    // derivePlayerStats this would be unchanged.
    const afterStats = derivePlayerStats(afterRow);
    assert.notStrictEqual(afterStats.meleeMult, beforeStats.meleeMult);
  });
});
