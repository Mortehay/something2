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

// SOMET-320. Apply the migration only if its schema is not already present.
//
// `up()` here is a PRECONDITION -- "put the schema in the state down() expects"
// -- not the subject; every assertion in this file is about down(). Running it
// unconditionally works on a virgin database and is impossible on a migrated
// one, where it dies on
//   column "stat_bonus_stat" of relation "item_types" already exists  (42701)
// This was the third file sharing that one cause, alongside
// stones_integration_db and migration_convert_magic_weapons_db.
//
// Keyed on an explicit presence check, never on catching the error: a
// duplicate-object error raised by a migration is a real defect, and this file
// exists precisely to police that migration's behaviour.
async function applyMigrationIfAbsent(client, migModule, presenceSql) {
  const present = await client.query(presenceSql);
  if (present.rowCount > 0) return false;
  await applyMigration(client, migModule, 'up');
  return true;
}

const HAS_STAT_BONUS_COLUMN = `SELECT 1 FROM information_schema.columns
   WHERE table_name = 'item_types' AND column_name = 'stat_bonus_stat'`;

// SOMET-320. Serialize every test transaction that writes item_types' STONE
// rows, across files.
//
// THIS IS NOT PRECAUTIONARY -- it fixes an observed deadlock. `node --test`
// runs files in PARALLEL, and three files write these rows: this one (the
// precondition DELETE below), migration_convert_magic_weapons_db (its
// conversion INSERTs) and stones_integration_db (its fixtures). Two of them
// touching the same rows in different orders produced a real
// "deadlock detected" abort in a full-suite run while passing in isolation --
// the worst kind of failure, because it is nondeterministic and can take an
// innocent test down with it.
//
// pg_advisory_xact_lock is TRANSACTION-scoped, so it is released by the
// ROLLBACK these files already perform in `finally`; there is nothing extra to
// clean up and a crashed test cannot strand the lock. The key is a hash of a
// fixed string so every file computes the same one. Same technique the
// entry-world guard uses for its own cross-file coordination.
//
// Every file that writes stone item_types must take this lock -- a lock only
// serializes those who ask for it.
const STONE_CATALOG_LOCK = "SELECT pg_advisory_xact_lock(hashtext('somet320:item_types_stone'))";

// SOMET-497. The advisory lock above is necessary but NOT sufficient, and the
// reason is the sentence right above it: a lock only serializes those who ask.
// The three stone files ask. Everybody else who touches item_types does not,
// and does not need to -- until this file's transaction runs DDL.
//
// The captured lock graph (Postgres deadlock DETAIL, somet497 scratch DB):
//
//   Process 43220 waits for ShareLock on transaction 4324658; blocked by 43218.
//   Process 43218 waits for AccessExclusiveLock on relation item_types;
//                                                 blocked by process 43220.
//   Process 43220: INSERT INTO player_items (character_id, item_type_id) ...
//   Process 43218: ALTER TABLE "item_types" DROP CONSTRAINT
//                  "item_types_stat_bonus_stat_check";
//   CONTEXT: while locking tuple (1,51) in relation "item_types"
//            SQL statement "SELECT 1 FROM ONLY "public"."item_types" x
//                            WHERE "id" = $1 FOR KEY SHARE OF x"
//
// Read it as a lock-ordering bug in THIS file, because that is what it is:
//
//   * 43218 is us. We hold the advisory lock, we have already DELETEd the
//     category='stone' rows (row locks on item_types tuples), and only THEN
//     does down()'s DDL ask for AccessExclusiveLock on the whole table.
//     Row locks first, table lock second -- the classic inversion.
//   * 43220 is any peer file inserting a player_items row whose item_type_id
//     is one of those stone rows (life_cost_live_join_db's staff/stone
//     fixture is the one that caught it). Its FK check takes RowShareLock on
//     item_types (conflicts with our AccessExclusiveLock) and then waits on
//     the stone tuple we deleted. Table lock first, row lock second -- the
//     opposite order, so: cycle.
//
// The fix is to take the coarsest lock FIRST, before this transaction owns any
// row. While we are waiting for it we hold nothing but the advisory lock (both
// are taken at the very top of openTxClient, before a single item_types row is
// read or written), so we cannot be one edge of a cycle; and once it is
// granted, a peer's FK probe simply queues behind us instead of overtaking us
// into a tuple we are about to delete. Nothing outside these three files has
// to change, which is the point -- the alternative was to teach every file
// that inserts a stone-typed player_item about a lock it has no business
// knowing, and that list only ever grows.
//
// LOCK TABLE is transaction-scoped like the advisory lock, so the ROLLBACK in
// `finally` still releases everything. Measured cost: peers block for the
// ~100-500ms these transactions live, not longer.
const STONE_CATALOG_TABLE_LOCK = 'LOCK TABLE item_types IN ACCESS EXCLUSIVE MODE';

async function lockStoneCatalog(client) {
  await client.query(STONE_CATALOG_LOCK);
  await client.query(STONE_CATALOG_TABLE_LOCK);
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
  await lockStoneCatalog(client);
  return client;
}

test('down() succeeds cleanly when zero category=stone rows remain', async (t) => {
  const client = await openTxClient(t);
  if (!client) return;

  try {
    await applyMigrationIfAbsent(client, mig, HAS_STAT_BONUS_COLUMN);

    // ESTABLISH THIS TEST'S PRECONDITION EXPLICITLY RATHER THAN ASSUMING IT.
    //
    // The name says "when zero category=stone rows remain", and on a virgin
    // database that was free: up() only adds columns and constraints, never
    // rows, so there were none. On a migrated database it is FALSE -- the
    // conversion migration (1714440167000) really ran, and item_types carries
    // its stone_of_% rows plus any hand-authored stone content. down() would
    // then correctly REFUSE, and this test would fail while testing nothing it
    // claims to test.
    //
    // Deleting them states the precondition the test was always relying on.
    // Safe by the same discipline as every other write in this file: it runs
    // inside the single transaction that `finally` always rolls back, so the
    // shared catalog is never actually touched. (SOMET-320)
    await client.query(`DELETE FROM item_types WHERE category = 'stone'`);

    // No stone rows at all -- down() must run clean, not refuse.
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
    await applyMigrationIfAbsent(client, mig, HAS_STAT_BONUS_COLUMN);

    // NO precondition delete here, deliberately, unlike the test above: this
    // one asserts down() REFUSES while a non-stone_of_% stone row exists, and
    // it inserts exactly such a row below. Pre-existing stone rows on a
    // migrated database can only reinforce that refusal, never mask it, so the
    // assertion stays honest either way.

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
