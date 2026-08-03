const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

// Gated exactly like creature_levels_db.test.js / seed_catalogs_db.test.js:
// skip without TEST_DATABASE_URL and do NOT fall back to DATABASE_URL, so a
// bare `npm test` on a machine with a working dev database can never reach
// this file. This test only reads information_schema and mutates inside
// transactions it rolls back -- it never leaves a written row behind.
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

test('player_progression columns have the documented types and defaults', async (t) => {
  if (!requireTestDb(t, 'this test reads player_progression column metadata')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} -- the column defaults are UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'player_progression'`,
    );
    const by = new Map(rows.map((r) => [r.column_name, r]));

    // Exact equality, never a regex. `assert.match(column_default, /1/)` also
    // matches 15, 100 and 1000 -- that exact hole shipped in A1's task 1.
    assert.equal(by.get('experience').data_type, 'bigint');
    assert.equal(by.get('experience').column_default, '0');
    assert.equal(by.get('level').column_default, '1');
    assert.equal(by.get('stat_points').column_default, '0');
    for (const s of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
      assert.equal(by.get(s).data_type, 'integer', `${s} must be integer`);
      assert.equal(by.get(s).column_default, '5', `${s} must default to the base stat`);
      assert.equal(by.get(s).is_nullable, 'NO', `${s} must be NOT NULL`);
    }
  } finally { await pool.end(); }
});

test('the CHECK constraints actually reject bad rows', async (t) => {
  if (!requireTestDb(t, 'this test UPDATEs a player_progression row inside a rolled-back transaction')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} -- the CHECK constraints are UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  // Borrowed read-only: an existing row backfilled by the migration itself,
  // never inserted or deleted by this test.
  const { rows: existing } = await pool.query('SELECT user_id FROM player_progression ORDER BY user_id LIMIT 1');
  if (existing.length === 0) {
    await pool.end();
    t.skip('no player_progression rows to borrow -- run the migration backfill first');
    return;
  }
  const testUserId = existing[0].user_id;

  // A CHECK constraint test that only reads information_schema proves the
  // constraint EXISTS, not that it BITES. Insert into a transaction and
  // require the failure, then roll back so the borrowed row is untouched.
  //
  // BEGIN/ROLLBACK must run on the SAME connection, so this checks out a
  // single dedicated client rather than letting the pool round-robin.
  const client = await pool.connect();
  try {
    for (const [label, sql] of [
      ['negative experience', 'UPDATE player_progression SET experience = -1 WHERE user_id = $1'],
      ['level 0', 'UPDATE player_progression SET level = 0 WHERE user_id = $1'],
      ['level 51', 'UPDATE player_progression SET level = 51 WHERE user_id = $1'],
      ['negative points', 'UPDATE player_progression SET stat_points = -1 WHERE user_id = $1'],
      ['sub-base strength', 'UPDATE player_progression SET strength = 4 WHERE user_id = $1'],
    ]) {
      await client.query('BEGIN');
      await assert.rejects(() => client.query(sql, [testUserId]), `${label} must be rejected`);
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
    await pool.end();
  }
});

test('every existing user was backfilled', async (t) => {
  if (!requireTestDb(t, 'this test reads the users/player_progression join')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} -- the backfill is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS missing
         FROM users u LEFT JOIN player_progression p ON p.user_id = u.id
        WHERE p.user_id IS NULL`,
    );
    assert.equal(rows[0].missing, 0);
  } finally { await pool.end(); }
});
