const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const MigrationBuilder = require('node-pg-migrate/dist/migration-builder').default;
const { withSeedSyncLock } = require('./helpers/seedSyncTest.js');

// SOMET-647. The quest objective columns used to exist only through
// scripts/seed-quests.js. The migration must add them with the seeder's exact
// types/defaults, be a no-op where the seeder already added them, and drop
// them on down. One transaction, always rolled back.
const DB_URL = process.env.TEST_DATABASE_URL;

async function apply(client, mod, direction) {
  const pgm = new MigrationBuilder({ query: (...a) => client.query(...a) }, {}, false, { debug() {}, info() {}, warn() {}, error() {} });
  await mod[direction](pgm);
  for (const sql of pgm.getSqlSteps()) await client.query(sql);
}

const COLS = `
  SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
    FROM information_schema.columns
   WHERE table_name = 'quests'
     AND column_name IN ('objective', 'target_count', 'prerequisite_key')
   ORDER BY column_name`;

function assertShape(rows) {
  const by = Object.fromEntries(rows.map((r) => [r.column_name, r]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['objective', 'prerequisite_key', 'target_count']);
  assert.strictEqual(by.objective.data_type, 'text');
  assert.strictEqual(by.objective.is_nullable, 'YES');
  assert.strictEqual(by.target_count.data_type, 'integer');
  assert.strictEqual(by.target_count.is_nullable, 'NO');
  assert.strictEqual(by.target_count.column_default, '1');
  assert.strictEqual(by.prerequisite_key.data_type, 'character varying');
  assert.strictEqual(by.prerequisite_key.character_maximum_length, 64);
  assert.strictEqual(by.prerequisite_key.is_nullable, 'YES');
}

test('quests objective columns migration: up adds, idempotent, down drops', async (t) => {
  if (!DB_URL) { t.skip('TEST_DATABASE_URL not set'); return; }
  const mod = require('../migrations/1714440812000_quests_objective_columns.js');
  const pool = new Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 3000 });
  t.after(async () => { await pool.end().catch(() => {}); });
  await withSeedSyncLock(pool, async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '10s'");

      // From a database without the columns (the dev DB's state).
      await apply(c, mod, 'down');
      assert.strictEqual((await c.query(COLS)).rowCount, 0);
      const tag = `sx_q647_${process.pid}`;
      await c.query(
        `INSERT INTO quests (key, act, title, description) VALUES ($1, 1, 't', 'd')`, [tag],
      );

      await apply(c, mod, 'up');
      assertShape((await c.query(COLS)).rows);
      // Existing row picks up the default; questsService's columns are queryable.
      const row = (await c.query(
        'SELECT objective, target_count, prerequisite_key FROM quests WHERE key = $1', [tag],
      )).rows[0];
      assert.deepStrictEqual(row, { objective: null, target_count: 1, prerequisite_key: null });

      // Idempotent: columns already present (the seeder-added state) -> no error,
      // data and shape untouched.
      await c.query(`UPDATE quests SET objective = 'o', target_count = 5, prerequisite_key = 'p' WHERE key = $1`, [tag]);
      await apply(c, mod, 'up');
      assertShape((await c.query(COLS)).rows);
      const kept = (await c.query(
        'SELECT objective, target_count, prerequisite_key FROM quests WHERE key = $1', [tag],
      )).rows[0];
      assert.deepStrictEqual(kept, { objective: 'o', target_count: 5, prerequisite_key: 'p' });

      // Down drops all three.
      await apply(c, mod, 'down');
      assert.strictEqual((await c.query(COLS)).rowCount, 0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });
});
