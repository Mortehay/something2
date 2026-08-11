const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const MigrationBuilder = require('node-pg-migrate/dist/migration-builder').default;
const mig = require('../migrations/1714440165000_stone_item_type.js');

// Important #5 fix (SOMET-245 final review). 1714440165000_stone_item_type.js's
// down() drops item_types.stat_bonus_stat/stat_bonus_amount and narrows
// item_types_category_check back to exclude 'stone'. down() migrations run
// in REVERSE timestamp order, so 1714440167000_convert_magic_weapons_to_
// stones.js's own down() (which deletes every 'stone_of_%' row -- its own
// naming convention) has already run by the time this one executes. If ANY
// OTHER category='stone' row still exists (real, hand-authored stone
// content, necessarily not named 'stone_of_%'), re-narrowing the CHECK
// constraint while that row still violates it fails hard with a raw
// constraint-violation error. The fix adds an explicit, clearly-worded
// refusal ahead of the destructive DDL. This test proves the REAL SQL
// behavior (not just that pgm.sql was called, which
// migration_stone_item_type.test.js's fakePgm-level test already covers)
// against a live database: refuses loudly when a non-stone_of_% stone row
// exists, succeeds cleanly when none does.
//
// Same rolled-back-transaction discipline as migration_convert_magic_
// weapons_db.test.js (read in full before writing this file): every
// statement here -- fixture setup, up(), the guard assertions, down() --
// runs on ONE checked-out client inside ONE transaction that is ALWAYS
// rolled back in `finally`, so nothing here is ever committed against the
// shared dev DB.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function applyMigration(client, migModule, direction) {
  const pgm = new MigrationBuilder({}, {}, false, { debug() {}, info() {}, warn() {}, error() {} });
  const action = migModule[direction];
  action(pgm);
  for (const sql of pgm.getSqlSteps()) {
    await client.query(sql);
  }
}

async function openTxClient(t) {
  const client = new Client({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    const msg = `NO DATABASE at ${DB_URL} (${err.message}) — the stone_item_type down() guard is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return null;
  }
  await client.query('BEGIN');
  return client;
}

test('down() succeeds cleanly when zero category=stone rows remain', async (t) => {
  const client = await openTxClient(t);
  if (!client) return;

  try {
    await applyMigration(client, mig, 'up');

    // No stone rows at all (up() only adds columns/constraints, never rows)
    // -- down() must run clean, not refuse.
    await assert.doesNotReject(() => applyMigration(client, mig, 'down'));

    const col = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'item_types' AND column_name = 'stat_bonus_stat'`,
    );
    assert.equal(col.rowCount, 0, 'down() must actually have dropped stat_bonus_stat when it succeeds');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
});

test('down() refuses loudly (does not silently corrupt or crash with a raw constraint error) when a non-stone_of_% stone row exists', async (t) => {
  const client = await openTxClient(t);
  if (!client) return;

  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const handAuthoredName = `zz-stones-handauthored-${tag}`;

  try {
    await applyMigration(client, mig, 'up');

    // Simulate real, hand-authored stone content added after this shipped --
    // by construction this can never be named 'stone_of_%' the way the
    // conversion migration's own rows are, so 1714440167000.down() (which
    // only cleans stone_of_% rows) would never have removed it.
    await client.query(
      `INSERT INTO item_types (name, category, element, damage, cooldown, stackable)
       VALUES ($1, 'stone', 'fire', 0, 0, false)`,
      [handAuthoredName],
    );

    // A failed statement aborts the whole enclosing transaction in Postgres
    // (later queries error with "current transaction is aborted" rather than
    // running at all) -- SAVEPOINT/ROLLBACK TO lets this ONE expected
    // failure be absorbed so the assertions below (still inside the same
    // outer, never-committed transaction) can keep querying.
    await client.query('SAVEPOINT guard_test');
    await assert.rejects(
      () => applyMigration(client, mig, 'down'),
      /stone_item_type down\(\)/,
      'down() must refuse with its own clear message, not a raw/cryptic constraint-violation error',
    );
    await client.query('ROLLBACK TO SAVEPOINT guard_test');

    // The refusal must be BEFORE any destructive DDL -- the column must
    // still exist (nothing partially applied).
    const col = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'item_types' AND column_name = 'stat_bonus_stat'`,
    );
    assert.equal(col.rowCount, 1, 'a refused down() must leave stat_bonus_stat untouched, not half-dropped');

    const stillThere = await client.query('SELECT category FROM item_types WHERE name = $1', [handAuthoredName]);
    assert.equal(stillThere.rowCount, 1, 'the hand-authored stone row itself must be untouched by a refused down()');
    assert.equal(stillThere.rows[0].category, 'stone');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
});
