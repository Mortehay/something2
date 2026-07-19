const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { consumeAmmo, ammoCount } = require('../src/authority/ammo');

// THE ONLY TEST IN THIS PROJECT THAT RUNS THE AMMO SPEND AGAINST A REAL SCHEMA.
//
// Every other test that touches consumeAmmo — including the ones named
// "integration" elsewhere in this directory — hands it a `{ query: async () => … }`
// mock. A mock cannot enforce a CHECK constraint, a foreign key, or any other
// rule that lives in the database rather than in the code, so a mocked suite
// is structurally incapable of noticing a statement that Postgres refuses to
// run. That is not a theoretical gap: a fully green suite shipped a spend
// whose `UPDATE … quantity = quantity - 1` violated
// player_items_quantity_check on the 1 -> 0 transition, which meant the last
// unit of every ammo stack could never be fired and the bow silently stopped
// working in the browser. The bug lived precisely in the space the mocks
// cannot see, so the regression test has to live outside it.
//
// Skipping: if no database is reachable this file SKIPS rather than fails, so
// the suite still runs on a machine without Postgres — but it skips loudly,
// naming what went uncovered. A skip here means the last-unit behaviour was
// NOT verified on this run; treat a skipped result as "unknown", never as
// "passing".
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: err.message };
  }
}

// A user id no other test or real player can collide with, and an ammo item
// type that actually exists (player_items.item_type_id is a FK — another rule
// only a real schema enforces).
function testUser(tag) { return `ammo-db-test-${tag}-${process.pid}-${Date.now()}`; }

async function anItemTypeId(pool) {
  const r = await pool.query('SELECT id FROM item_types ORDER BY id ASC LIMIT 1');
  assert.ok(r.rows.length, 'the schema must have at least one item type to reference');
  return r.rows[0].id;
}

async function stacks(pool, userId) {
  const r = await pool.query(
    'SELECT quantity FROM player_items WHERE user_id = $1 ORDER BY created_at ASC, id ASC',
    [userId],
  );
  return r.rows.map((row) => Number(row.quantity));
}

test('consumeAmmo against a REAL database: a stack drains through its last unit and the row is gone', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    t.skip(`NO DATABASE at ${DB_URL} (${pool.unreachable}) — the last-unit ammo spend is UNVERIFIED on this run`);
    return;
  }
  const user = testUser('drain');
  try {
    const typeId = await anItemTypeId(pool);

    // The CHECK constraint must actually be present, or this test proves
    // nothing: it would pass just as happily against the broken decrement.
    const chk = await pool.query(
      `SELECT 1 FROM pg_constraint
        WHERE conrelid = 'player_items'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%quantity > 0%'`,
    );
    assert.equal(chk.rowCount, 1,
      'player_items must still carry CHECK (quantity > 0) — that constraint is what makes this test meaningful');

    await pool.query(
      'INSERT INTO player_items (user_id, item_type_id, quantity) VALUES ($1, $2, 2)',
      [user, typeId],
    );
    assert.deepEqual(await stacks(pool, user), [2], 'setup: one stack of two units');
    assert.equal(await ammoCount(pool, user, typeId), 2);

    // First unit: an ordinary decrement.
    assert.equal(await consumeAmmo(pool, user, typeId), true, 'the first unit spends');
    assert.deepEqual(await stacks(pool, user), [1], 'the stack is down to its last unit');
    assert.equal(await ammoCount(pool, user, typeId), 1);

    // THE UNIT THAT COULD NEVER BE FIRED. Before the fix this call threw
    // (check constraint violation) instead of returning, so the assertion
    // below is reached only if the spend is expressed as a statement that
    // never constructs a zero-quantity row.
    assert.equal(await consumeAmmo(pool, user, typeId), true,
      'the LAST unit must spend — this is the exact call that threw a CHECK violation before the fix');
    assert.deepEqual(await stacks(pool, user), [],
      'the emptied stack must be GONE, not sitting at quantity 0');
    assert.equal(await ammoCount(pool, user, typeId), 0);

    // And an empty inventory is a clean refusal, not an error: this is what
    // makes the server send `noammo` instead of silently dropping the frame.
    assert.equal(await consumeAmmo(pool, user, typeId), false,
      'with no stacks left the spend refuses cleanly');
    assert.deepEqual(await stacks(pool, user), []);
  } finally {
    await pool.query('DELETE FROM player_items WHERE user_id = $1', [user]).catch(() => {});
    await pool.end().catch(() => {});
  }
});

test('consumeAmmo against a REAL database: one shot touches exactly one stack, oldest first', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    t.skip(`NO DATABASE at ${DB_URL} (${pool.unreachable}) — single-stack targeting is UNVERIFIED on this run`);
    return;
  }
  const user = testUser('stacks');
  try {
    const typeId = await anItemTypeId(pool);

    // Two stacks of the same type — the state the mocked tests can only
    // assert about indirectly, by reading the SQL text. Explicit created_at
    // values pin which one is "oldest" instead of relying on insert order
    // resolving inside now()'s transaction-level granularity.
    await pool.query(
      `INSERT INTO player_items (user_id, item_type_id, quantity, created_at) VALUES
         ($1, $2, 1, now() - interval '2 hours'),
         ($1, $2, 3, now() - interval '1 hour')`,
      [user, typeId],
    );
    assert.deepEqual(await stacks(pool, user), [1, 3], 'setup: oldest stack holds one unit, newer holds three');

    assert.equal(await consumeAmmo(pool, user, typeId), true);
    // The oldest stack held exactly one unit, so this single shot must have
    // deleted it and left the newer stack completely untouched. A statement
    // that hit every stack would show [2] here; one that drained the wrong
    // stack would show [1, 2].
    assert.deepEqual(await stacks(pool, user), [3],
      'exactly one stack is affected per shot, and the oldest drains first');
    assert.equal(await ammoCount(pool, user, typeId), 3,
      'total across stacks fell by exactly one unit');
  } finally {
    await pool.query('DELETE FROM player_items WHERE user_id = $1', [user]).catch(() => {});
    await pool.end().catch(() => {});
  }
});
