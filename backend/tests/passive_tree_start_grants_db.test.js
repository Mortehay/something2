// SOMET-471 -- the start-node grants have to REACH THE DATABASE.
//
// passive_tree_generator.test.js proves the generator produces the six grants.
// That is not enough, and this file exists because of the specific way it is
// not enough:
//
//   scripts/seed-passive-tree.js preserves an admin's authored columns (kind,
//   label, grants) unless --force. C1 seeded all six start nodes with
//   `grants: []`. So on EVERY database that already has a tree -- the shared
//   dev database, staging, and any developer's -- a normal `make
//   seed-passive-tree` would keep the empty arrays, and the six classes would
//   go on playing identically with a completely green suite.
//
// That is the same shape as the defect SOMET-486 spent eleven months not
// noticing, and this epic has already shipped three items that were inert
// because only the pure function was tested. So the assertion below is
// deliberately made against a database that has been put back into the OLD
// state first, and the reseed under test is NOT forced.

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { seedPassiveTree } = require('../scripts/seed-passive-tree.js');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Hand-written, and duplicated from the generator test on purpose: this file
// asserts what is IN THE DATABASE, and reading the expectation from
// seeds/data/passiveTree.js would pass against a seeder that writes nothing.
const EXPECTED = {
  Warrior: [{ type: 'damage', element: 'physical', value: 3 }],
  Mage: [{ type: 'damage', element: 'arcane', value: 3 }],
  Archer: [{ type: 'rule', rule: 'cooldownFloor', value: 0.38 }],
  Monk: [{ type: 'rule', rule: 'regenLifeShare', value: 0.1 }],
  Cultist: [{ type: 'rule', rule: 'lifeCostMultiplier', value: 0.9 }],
  Druid: [{ type: 'rule', rule: 'treeCharmBonus', value: 1 }],
};

test('start-node grants reach passive_nodes', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const seeded = await pool.query(
    "SELECT count(*)::int AS n FROM passive_nodes WHERE kind = 'start'");
  assert.equal(seeded.rows[0].n, 6,
    'this database needs a seeded passive tree; run scripts/seed-passive-tree.js');

  // SOMET-495. Both subtests below MUTATE THE WHOLE TREE and then repair it.
  // `node --test` runs test FILES as concurrent processes against one database,
  // so while the repair was in flight every peer file that resolves a start-node
  // grant -- passive_tree_routes, charm_live_db, life_cost_live_join_db -- read
  // the emptied array and failed. That is the three-failure full-suite red this
  // ticket found still standing (and twelve failures on a narrower, faster set),
  // and it reproduces on a pristine main: this file passes alone, and takes its
  // neighbours down when run beside them.
  //
  // Fixed by doing the mutate/repair/assert on ONE client inside a transaction
  // and ROLLING BACK. Postgres' MVCC means no other session ever observes the
  // emptied arrays, the assertions still see them (they are in the same
  // transaction), and the tree is byte-identical afterwards either way -- the
  // reseed under test writes exactly what was there before it.
  //
  // The rollback is NOT a substitute for the repair: what is under test is that
  // a non-forced reseed restores the grants, and that is asserted before it.
  const inRollback = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  };

  await t.test('a NON-forced reseed delivers them over the old empty arrays', async () => {
    await inRollback(async (db) => {
      // Put the database back into the pre-471 state: start nodes with no
      // grants, which is what C1 wrote and what every existing database holds.
      await db.query("UPDATE passive_nodes SET grants = '[]'::jsonb WHERE kind = 'start'");

      // Prove the wipe happened. Without this the assertion below could pass
      // simply because the rows already held the right thing.
      const before = await db.query(
        `SELECT count(*)::int AS n FROM passive_nodes
          WHERE kind = 'start' AND grants = '[]'::jsonb`);
      assert.equal(before.rows[0].n, 6, 'the six start nodes must really be emptied first');

      // NOT forced. This is the call `make seed-passive-tree` makes.
      await seedPassiveTree(db, { quiet: true });

      const r = await db.query(
        "SELECT start_class, grants FROM passive_nodes WHERE kind = 'start' ORDER BY start_class");
      assert.deepEqual(
        Object.fromEntries(r.rows.map((x) => [x.start_class, x.grants])),
        EXPECTED);
    });
  });

  await t.test('a non-forced reseed still preserves a hand-tuned ordinary node', async () => {
    // The other half of the carve-out. Making start-node grants structural
    // must not turn every reseed into --force: an admin's retuned minor or
    // notable has to survive, which is the behaviour C1 built the CASE
    // expression for in the first place.
    await inRollback(async (db) => {
      const victim = await db.query(
        "SELECT id, key, grants FROM passive_nodes WHERE kind = 'minor' ORDER BY id LIMIT 1");
      assert.equal(victim.rows.length, 1);
      const tuned = [{ type: 'resource', pool: 'hp', value: 999 }];
      await db.query('UPDATE passive_nodes SET grants = $2::jsonb WHERE id = $1',
        [victim.rows[0].id, JSON.stringify(tuned)]);
      await seedPassiveTree(db, { quiet: true });
      const after = await db.query(
        'SELECT grants FROM passive_nodes WHERE id = $1', [victim.rows[0].id]);
      assert.deepEqual(after.rows[0].grants, tuned,
        'a non-forced reseed must not clobber an admin-tuned node');
      // The explicit restore is gone: the ROLLBACK is the restore, and it
      // cannot be skipped by an assertion throwing first (the old `finally`
      // could still leave the row tuned if the restore query itself failed).
    });
  });

  await t.test('every start node joins to a real, playable entity_types row', async () => {
    // services/passiveTreeStore.js resolves a character's start node with
    // `JOIN passive_nodes p ON p.start_class = e.name`. A start_class that
    // matches no class name returns null there and every caller refuses, so
    // the class simply has no tree -- silently.
    const r = await pool.query(
      `SELECT p.start_class
         FROM passive_nodes p
         LEFT JOIN entity_types e ON e.name = p.start_class AND e.is_playable = true
        WHERE p.kind = 'start' AND e.id IS NULL
        ORDER BY p.start_class`);
    assert.deepEqual(r.rows.map((x) => x.start_class), []);
  });

  await t.test('every playable class has a start node', async () => {
    // The reverse direction. Adding a class to entity_types without a start
    // node gives it a working character-select entry and no passive tree.
    const r = await pool.query(
      `SELECT e.name FROM entity_types e
        WHERE e.is_playable = true
          AND NOT EXISTS (SELECT 1 FROM passive_nodes p WHERE p.start_class = e.name)
        ORDER BY e.name`);
    assert.deepEqual(r.rows.map((x) => x.name), []);
  });

  await t.test('the demoted Ranger has no start node', async () => {
    // Ranger was kept, not renamed into Archer. It must not also hold a tree
    // sector -- Archer holds dexterity, and two classes in one sector would
    // leave the tree's six-way split lying about itself.
    const r = await pool.query(
      "SELECT count(*)::int AS n FROM passive_nodes WHERE start_class = 'Ranger'");
    assert.equal(r.rows[0].n, 0);
  });
});
