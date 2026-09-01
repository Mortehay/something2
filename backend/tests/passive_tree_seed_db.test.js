// backend/tests/passive_tree_seed_db.test.js
//
// The seeder against a real database. Two properties matter and neither can be
// tested against a stub: that a SECOND run is a no-op on the counts (so a
// reseed cannot orphan anyone's character_passives), and that a second run
// keeps an admin's edited label/grants unless --force is passed.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { seedPassiveTree } = require('../scripts/seed-passive-tree.js');
const {
  withAdvisoryLock, PASSIVE_TREE_LOCK_KEY, PASSIVE_TREE_LOCK_WAIT_MS,
} = require('./helpers/advisoryLock.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to mutate a real database (this test writes passive_nodes)'
  : false;

test('passive tree seeder', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(async () => { await pool.end(); });

  // SOMET-477: this file force-reseeds the tree, which rewrites the label,
  // kind and grants of every node. passive_tree_start_grants_db.test.js and
  // passive_nodes_admin_routes.test.js write and then assert on those same
  // columns in parallel processes, so all three hold this one key while they
  // do it.
  await withAdvisoryLock(pool, PASSIVE_TREE_LOCK_KEY, async () => {
    await seedPassiveTree(pool, { force: true, quiet: true });

    await t.test('inserts exactly the generated graph', async () => {
      const n = await pool.query('SELECT count(*)::int AS c FROM passive_nodes');
      assert.strictEqual(n.rows[0].c, 1843);
      const e = await pool.query('SELECT count(*)::int AS c FROM passive_edges');
      assert.strictEqual(e.rows[0].c, 2419);
      const k = await pool.query("SELECT count(*)::int AS c FROM passive_nodes WHERE kind = 'keystone'");
      assert.strictEqual(k.rows[0].c, 30);
      const s = await pool.query('SELECT count(*)::int AS c FROM passive_nodes WHERE start_class IS NOT NULL');
      assert.strictEqual(s.rows[0].c, 6);
    });

    await t.test('stores every edge with a_id < b_id and both endpoints real', async () => {
      const bad = await pool.query('SELECT count(*)::int AS c FROM passive_edges WHERE a_id >= b_id');
      assert.strictEqual(bad.rows[0].c, 0);
    });

    await t.test('a second run changes no counts and reuses the same ids', async () => {
      const before = await pool.query('SELECT id FROM passive_nodes WHERE key = $1', ['start-strength']);
      await seedPassiveTree(pool, { quiet: true });
      const n = await pool.query('SELECT count(*)::int AS c FROM passive_nodes');
      assert.strictEqual(n.rows[0].c, 1843);
      const e = await pool.query('SELECT count(*)::int AS c FROM passive_edges');
      assert.strictEqual(e.rows[0].c, 2419);
      const after = await pool.query('SELECT id FROM passive_nodes WHERE key = $1', ['start-strength']);
      // Same id, so a character_passives row pointing at it survives a reseed.
      assert.strictEqual(after.rows[0].id, before.rows[0].id);
    });

    await t.test('a plain reseed keeps an admin edit; --force overwrites it', async () => {
      const key = 'strength-r1-0-0';
      await pool.query(
        `UPDATE passive_nodes SET label = 'ADMIN EDIT', grants = $2::jsonb WHERE key = $1`,
        [key, JSON.stringify([{ type: 'stat', stat: 'strength', value: 99 }])],
      );

      await seedPassiveTree(pool, { quiet: true });
      const kept = await pool.query('SELECT label, grants FROM passive_nodes WHERE key = $1', [key]);
      assert.strictEqual(kept.rows[0].label, 'ADMIN EDIT');
      assert.deepStrictEqual(kept.rows[0].grants, [{ type: 'stat', stat: 'strength', value: 99 }]);

      await seedPassiveTree(pool, { force: true, quiet: true });
      const forced = await pool.query('SELECT label, grants FROM passive_nodes WHERE key = $1', [key]);
      assert.notStrictEqual(forced.rows[0].label, 'ADMIN EDIT');
      assert.strictEqual(Array.isArray(forced.rows[0].grants), true);
    });

    await t.test('the six start nodes name the six classes', async () => {
      const r = await pool.query('SELECT start_class FROM passive_nodes WHERE start_class IS NOT NULL ORDER BY start_class');
      assert.deepStrictEqual(r.rows.map((x) => x.start_class),
        ['Archer', 'Cultist', 'Druid', 'Mage', 'Monk', 'Warrior']);
    });
  }, { waitMs: PASSIVE_TREE_LOCK_WAIT_MS });
});
