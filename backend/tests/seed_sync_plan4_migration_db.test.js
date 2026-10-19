const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const MigrationBuilder = require('node-pg-migrate/dist/migration-builder').default;
const { withSeedSyncLock } = require('./helpers/seedSyncTest.js');

// SOMET-641. Plan-4 migration: per-PC map_spec_state and a travelling
// world_point_kinds.sync_uuid. One transaction, always rolled back.
const DB_URL = process.env.TEST_DATABASE_URL;

function md5uuid(table, key) {
  const h = crypto.createHash('md5').update(`s2sync:${table}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function apply(client, mod, direction) {
  const pgm = new MigrationBuilder({ query: (...a) => client.query(...a) }, {}, false, { debug() {}, info() {}, warn() {}, error() {} });
  await mod[direction](pgm);
  for (const sql of pgm.getSqlSteps()) await client.query(sql);
}

const HAS_COL = `SELECT 1 FROM information_schema.columns WHERE table_name = 'world_point_kinds' AND column_name = 'sync_uuid'`;

test('plan4 migration: map_spec_state and point kind identity', async (t) => {
  if (!DB_URL) { t.skip('TEST_DATABASE_URL not set'); return; }
  const mod = require('../migrations/1714440810000_seed_sync_plan4.js');
  const pool = new Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 3000 });
  t.after(async () => { await pool.end().catch(() => {}); });
  await withSeedSyncLock(pool, async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '10s'");
      if ((await c.query(HAS_COL)).rowCount > 0) await apply(c, mod, 'down');
      const tag = `sx_p4_${process.pid}`;
      await c.query('INSERT INTO world_point_kinds (kind) VALUES ($1)', [tag]);

      await apply(c, mod, 'up');

      // Backfill formula, for the fixture and for every pre-existing kind.
      const all = (await c.query('SELECT kind, sync_uuid FROM world_point_kinds')).rows;
      assert.ok(all.length >= 9);
      for (const r of all) assert.strictEqual(r.sync_uuid, md5uuid('world_point_kinds', r.kind), r.kind);

      // New row: default works and is not the formula.
      const fresh = (await c.query(`INSERT INTO world_point_kinds (kind) VALUES ($1) RETURNING sync_uuid`, [`${tag}_b`])).rows[0].sync_uuid;
      assert.match(fresh, /^[0-9a-f-]{36}$/);
      assert.notStrictEqual(fresh, md5uuid('world_point_kinds', `${tag}_b`));
      // UNIQUE
      await c.query('SAVEPOINT s');
      await assert.rejects(c.query('UPDATE world_point_kinds SET sync_uuid = $1 WHERE kind = $2', [fresh, tag]), (e) => e.code === '23505');
      await c.query('ROLLBACK TO s');

      // map_spec_state
      await c.query(`INSERT INTO map_spec_state (spec_name) VALUES ($1)`, [tag]);
      const row = (await c.query('SELECT * FROM map_spec_state WHERE spec_name = $1', [tag])).rows[0];
      assert.ok(row.updated_at instanceof Date);
      for (const k of ['applied_sha256', 'applied_at', 'exported_sha256', 'exported_at', 'box_pushed_sha256', 'box_error']) {
        assert.strictEqual(row[k], null, k);
      }
      await c.query('SAVEPOINT s2');
      await assert.rejects(c.query(`INSERT INTO map_spec_state (spec_name) VALUES ($1)`, [tag]), (e) => e.code === '23505');
      await c.query('ROLLBACK TO s2');

      // Down drops both.
      await apply(c, mod, 'down');
      assert.strictEqual((await c.query(HAS_COL)).rowCount, 0);
      assert.strictEqual((await c.query(`SELECT to_regclass('map_spec_state') AS r`)).rows[0].r, null);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });
});
