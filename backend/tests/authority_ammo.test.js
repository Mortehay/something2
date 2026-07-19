const test = require('node:test');
const assert = require('node:assert');
const { consumeAmmo, ammoCount } = require('../src/authority/ammo');

// NOTE ON WHAT THESE TESTS CAN AND CANNOT SEE. Everything in this file mocks
// the pool, so the SQL is never executed and no *schema* rule — above all
// player_items' CHECK (quantity > 0) — can possibly fire here. That blind
// spot is not hypothetical: a fully green run of this file shipped a
// consumeAmmo whose decrement threw on the last unit of every stack, because
// the constraint it violated lives in the schema and not in the code. These
// tests defend the statement's *shape*; the behaviour that depends on the
// real schema is covered by authority_ammo_db.test.js against a live
// database, and that is the test that actually proves the last shot works.

test('consumeAmmo returns true and spends one unit in a single statement', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rowCount: 1, rows: [{ spent: 1 }] };
  } };
  assert.equal(await consumeAmmo(pool, 'u1', 7), true);
  assert.deepEqual(calls[0].params, ['u1', 7]);
  // One statement is a correctness requirement, not an optimisation: a
  // decrement and a follow-up delete cannot be split across two statements
  // without the first one violating CHECK (quantity > 0) on the last unit.
  assert.equal(calls.length, 1, 'the spend must be one atomic statement, never a decrement plus a cleanup delete');
});

// The mock pool ignores the SQL string, so nothing about the statement is
// defended unless the test reads the statement itself. Without the
// single-row pick, one shot decrements EVERY stack of that ammo type.
test('the consume statement targets exactly one row', async () => {
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rowCount: 1, rows: [{ spent: 1 }] }; } };
  await consumeAmmo(pool, 'u1', 7);
  const norm = sql.replace(/\s+/g, ' ').toLowerCase();
  assert.ok(norm.includes('limit 1'),
    'consume must pick a single stack id — without LIMIT 1 the write hits every stack of this ammo type, so one shot spends several units');
  assert.ok(norm.includes('order by created_at'),
    'the oldest stack must drain first');
  assert.ok(norm.includes('quantity > 0'),
    'the quantity > 0 predicate is the has-ammo gate; without it an empty stack is picked and the shot is wrongly allowed');
});

// The regression guard for the shipped defect, at the level a mocked pool can
// still express: the statement must remove the row it empties rather than
// write a zero into it.
test('the consume statement deletes the last-unit stack instead of decrementing it to zero', async () => {
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rowCount: 1, rows: [{ spent: 1 }] }; } };
  await consumeAmmo(pool, 'u1', 7);
  const norm = sql.replace(/\s+/g, ' ').toLowerCase();
  assert.ok(norm.includes('delete from player_items'),
    'a stack down to its last unit must be DELETEd; decrementing it to 0 violates CHECK (quantity > 0) and throws');
  assert.ok(norm.includes('quantity = 1'),
    'the delete branch must be selected by the stack holding exactly one unit');
  assert.ok(norm.includes('quantity > 1'),
    'the decrement branch must be restricted to stacks with more than one unit, so it can never construct a zero row');
});

test('consumeAmmo returns false when no stack has any left', async () => {
  const pool = { query: async () => ({ rowCount: 1, rows: [{ spent: 0 }] }) };
  assert.equal(await consumeAmmo(pool, 'u1', 7), false);
});

// This is the one that fails if someone "simplifies" ammoCount to reading a
// single row: stacks are deliberately never merged (see consumeAmmo's own
// comment above), so a player holding two arrow stacks must have both
// counted, not just whichever one a naive query happens to hit first.
test('ammoCount sums across multiple stacks of the same type', async () => {
  let seenSql = '', seenParams = null;
  const pool = { query: async (sql, params) => {
    seenSql = sql;
    seenParams = params;
    // A real Postgres SUM query never returns per-row data — a mock that
    // simulates it correctly returns exactly one aggregate row.
    return { rows: [{ n: 12 + 30 + 1 }] };
  } };
  const n = await ammoCount(pool, 'u1', 7);
  assert.equal(n, 43, 'the summed total across every stack must be returned');
  assert.match(seenSql.toLowerCase(), /sum\(quantity\)/, 'must aggregate with SUM, not read one row');
  assert.deepEqual(seenParams, ['u1', 7]);
});

test('ammoCount is 0 when the player holds no stacks of that type', async () => {
  const pool = { query: async () => ({ rows: [{ n: 0 }] }) };
  assert.equal(await ammoCount(pool, 'u1', 7), 0);
});
