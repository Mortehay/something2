const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

// Gated exactly like seed_catalogs_db.test.js: skip without TEST_DATABASE_URL
// and do NOT fall back to DATABASE_URL, so a bare `npm test` on a machine with
// a working dev database can never reach it. This test INSERTs and DELETEs.
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

test('the level band constraint rejects an inverted band', async (t) => {
  if (!requireTestDb(t, 'this test INSERTs a world row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} -- the band constraint is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const NAME = 'zz_level_band_canary';
  try {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO worlds (name, seed, level_min, level_max) VALUES ($1, 1, 9, 3)`,
        [NAME],
      ),
      /worlds_level_band_check/,
      'an inverted band must be rejected by the database, not just by app code',
    );
    // The equal case is legal: a band of [5,5] is a fixed-level world.
    await pool.query(
      `INSERT INTO worlds (name, seed, level_min, level_max) VALUES ($1, 1, 5, 5)`,
      [NAME],
    );
    const r = await pool.query('SELECT level_min, level_max FROM worlds WHERE name = $1', [NAME]);
    assert.equal(r.rows[0].level_min, 5);
    assert.equal(r.rows[0].level_max, 5);
  } finally {
    await pool.query('DELETE FROM worlds WHERE name = $1', [NAME]).catch(() => {});
    await pool.end();
  }
});

test('existing creatures default to level 1 and damage 5', async (t) => {
  if (!requireTestDb(t, 'this test reads world_creatures defaults')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  try {
    const r = await pool.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'world_creatures' AND column_name IN ('level','damage')
        ORDER BY column_name`,
    );
    assert.equal(r.rowCount, 2, 'both columns must exist');
    assert.match(r.rows[0].column_default, /5/);  // damage
    assert.match(r.rows[1].column_default, /1/);  // level
  } finally { await pool.end(); }
});
