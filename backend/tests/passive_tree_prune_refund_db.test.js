// backend/tests/passive_tree_prune_refund_db.test.js
//
// SOMET-745. A forced reseed prunes nodes the generator no longer produces. A
// point spent on one must come back to its character, exactly once, in the same
// transaction that removes the allocation.
//
// RUNS IN ITS OWN SCHEMA. These tests commit nodes the generator does not make
// and force-reseed repeatedly. Doing that in the shared tables made
// passive_tree_routes count 2323 nodes instead of 2322, and other files read the
// tree without any lock. A private copy of the four tables the seeder writes
// cannot be seen by a peer, and a peer's respec cannot wipe these allocations.
// LIKE copies keys, checks and defaults but not foreign keys: the ones the prune
// depends on are added below, and character_id deliberately has none, because
// adding one would take a lock on the shared characters table.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { seedPassiveTree } = require('../scripts/seed-passive-tree.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to mutate a real database (this test prunes passive_nodes)'
  : false;

const SCHEMA = `prune_refund_${process.pid}`;
const APP_NAME = `prune-refund-${process.pid}`;

test('a forced reseed refunds points spent on pruned nodes', { skip }, async (t) => {
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  const pool = new Pool({
    connectionString: url,
    max: 6,
    application_name: APP_NAME,
    options: `-c search_path=${SCHEMA}`,
  });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await admin.end();
  });

  for (const table of ['passive_nodes', 'passive_edges', 'character_passives', 'player_progression']) {
    await admin.query(`CREATE TABLE ${SCHEMA}.${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  await admin.query(`
    ALTER TABLE ${SCHEMA}.character_passives
      ADD FOREIGN KEY (node_id) REFERENCES ${SCHEMA}.passive_nodes (id) ON DELETE CASCADE;
    ALTER TABLE ${SCHEMA}.passive_edges
      ADD FOREIGN KEY (a_id) REFERENCES ${SCHEMA}.passive_nodes (id) ON DELETE CASCADE,
      ADD FOREIGN KEY (b_id) REFERENCES ${SCHEMA}.passive_nodes (id) ON DELETE CASCADE`);

  const force = () => seedPassiveTree(pool, { force: true, quiet: true });
  await force();

  let serial = 0;

  // A node the generator does not produce, so the next forced reseed prunes it.
  async function retiredNode() {
    serial += 1;
    const r = await pool.query(
      `INSERT INTO passive_nodes (key, sector, ring, x, y, kind, label, grants)
       SELECT $1, sector, ring, 0, 0, 'minor', 'Retired', '[]'::jsonb
         FROM passive_nodes WHERE kind = 'minor' LIMIT 1
       RETURNING id`,
      [`retired_${serial}`],
    );
    return r.rows[0].id;
  }

  // `banked: null` means no player_progression row, the state a character is in
  // until loadProgression first creates it.
  async function character({ banked = 0, spentOn = [] }) {
    serial += 1;
    const id = serial;
    if (banked !== null) {
      await pool.query(
        'INSERT INTO player_progression (character_id, passive_points) VALUES ($1, $2)',
        [id, banked],
      );
    }
    for (const nodeId of spentOn) {
      await pool.query(
        'INSERT INTO character_passives (character_id, node_id) VALUES ($1, $2)',
        [id, nodeId],
      );
    }
    return id;
  }

  const banked = async (id) => {
    const r = await pool.query(
      'SELECT passive_points FROM player_progression WHERE character_id = $1', [id]);
    return r.rows.length ? r.rows[0].passive_points : null;
  };
  const spent = async (id) => {
    const r = await pool.query(
      'SELECT node_id FROM character_passives WHERE character_id = $1 ORDER BY node_id', [id]);
    return r.rows.map((x) => x.node_id);
  };
  const nodeExists = async (id) => (
    await pool.query('SELECT 1 FROM passive_nodes WHERE id = $1', [id])).rowCount === 1;
  const kept = (await pool.query(
    "SELECT id FROM passive_nodes WHERE key = 'strength-r2-0-1'")).rows[0]?.id;
  assert.ok(kept, 'a generated node to keep an allocation on');

  await t.test('the seeder is really writing the private copy', async () => {
    const here = await pool.query("SELECT to_regclass('passive_nodes')::text AS t");
    assert.strictEqual(here.rows[0].t, 'passive_nodes');
    const retired = await retiredNode();
    const shared = await admin.query('SELECT 1 FROM public.passive_nodes WHERE key = $1', [`retired_${serial}`]);
    assert.strictEqual(shared.rowCount, 0, 'a peer must not be able to see this node');
    await force();
    assert.strictEqual(await nodeExists(retired), false);
  });

  await t.test('refunds each character exactly what it had on pruned nodes', async () => {
    const [a, b] = [await retiredNode(), await retiredNode()];
    const both = await character({ banked: 2, spentOn: [kept, a, b] });
    const one = await character({ banked: 0, spentOn: [a] });
    const neither = await character({ banked: 5, spentOn: [kept] });

    await force();

    assert.strictEqual(await banked(both), 4, '2 banked + 2 refunded');
    assert.deepStrictEqual(await spent(both), [kept], 'the allocation on a kept node stays');
    assert.strictEqual(await banked(one), 1);
    assert.deepStrictEqual(await spent(one), []);
    assert.strictEqual(await banked(neither), 5, 'nothing pruned, nothing refunded');
    assert.deepStrictEqual(await spent(neither), [kept]);
    assert.strictEqual(await nodeExists(a), false);
    assert.strictEqual(await nodeExists(b), false);
  });

  await t.test('creates the progression row for a character without one', async () => {
    const node = await retiredNode();
    const c = await character({ banked: null, spentOn: [node] });
    assert.strictEqual(await banked(c), null, 'precondition: no progression row');

    await force();

    assert.strictEqual(await banked(c), 1);
    assert.deepStrictEqual(await spent(c), []);
  });

  await t.test('a second forced reseed refunds nothing more', async () => {
    const node = await retiredNode();
    const c = await character({ banked: 3, spentOn: [node] });

    await force();
    assert.strictEqual(await banked(c), 4);
    await force();
    assert.strictEqual(await banked(c), 4);
  });

  await t.test('a reseed without force prunes and refunds nothing', async () => {
    const node = await retiredNode();
    const c = await character({ banked: 3, spentOn: [node] });

    await seedPassiveTree(pool, { quiet: true });

    assert.strictEqual(await banked(c), 3);
    assert.deepStrictEqual(await spent(c), [node]);
    assert.strictEqual(await nodeExists(node), true);
    await force(); // leave the tree as the generator makes it
  });

  await t.test('a failure part-way changes nothing, so a rerun still refunds', async () => {
    const node = await retiredNode();
    const c = await character({ banked: 1, spentOn: [node] });

    // Real database, real transaction: only the final node delete fails.
    const failingPool = {
      query: (...args) => pool.query(...args),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: (sql, params) => (/DELETE FROM passive_nodes/.test(sql)
            ? Promise.reject(new Error('injected failure'))
            : client.query(sql, params)),
        };
      },
    };
    await assert.rejects(
      seedPassiveTree(failingPool, { force: true, quiet: true }), /injected failure/);

    assert.strictEqual(await banked(c), 1, 'the refund rolled back');
    assert.deepStrictEqual(await spent(c), [node], 'the allocation rolled back');
    assert.strictEqual(await nodeExists(node), true);

    await force();
    assert.strictEqual(await banked(c), 2);
    assert.deepStrictEqual(await spent(c), []);
  });

  await t.test('a point being spent while the reseed runs is still refunded', async () => {
    const node = await retiredNode();
    const c = await character({ banked: 0 });

    // An allocation still in flight when the reseed picks its stale nodes. If
    // the prune counted first and locked later, the node delete's cascade would
    // take this row uncounted.
    const allocator = await pool.connect();
    try {
      await allocator.query('BEGIN');
      await allocator.query(
        'INSERT INTO character_passives (character_id, node_id) VALUES ($1, $2)', [c, node]);

      const reseed = force();
      const deadline = Date.now() + 20000;
      for (;;) {
        const blocked = await admin.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE application_name = $1 AND wait_event_type = 'Lock'`, [APP_NAME]);
        if (blocked.rowCount) break;
        assert.ok(Date.now() < deadline, 'the reseed never waited for the in-flight allocation');
        await new Promise((res) => { setTimeout(res, 20); });
      }
      await allocator.query('COMMIT');
      await reseed;
    } finally {
      await allocator.query('ROLLBACK').catch(() => {});
      allocator.release();
    }

    assert.strictEqual(await banked(c), 1);
    assert.deepStrictEqual(await spent(c), []);
  });
});
