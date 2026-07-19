const test = require('node:test');
const assert = require('node:assert');
const { consumeAmmo, ammoCount } = require('../src/authority/ammo');

test('consumeAmmo returns true and spends one unit', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rowCount: 1, rows: [{ id: 'i1', quantity: 4 }] };
  } };
  assert.equal(await consumeAmmo(pool, 'u1', 7), true);
  assert.equal(calls.length, 1, 'a non-empty stack needs no follow-up delete');
});

// The mock pool ignores the SQL string, so nothing about the statement is
// defended unless the test reads the statement itself. Without the
// single-row subquery, one shot decrements EVERY stack of that ammo type.
test('the consume statement targets exactly one row', async () => {
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rowCount: 1, rows: [{ id: 'i1', quantity: 2 }] }; } };
  await consumeAmmo(pool, 'u1', 7);
  const norm = sql.replace(/\s+/g, ' ').toLowerCase();
  assert.ok(norm.includes('limit 1'),
    'consume must select a single stack id — without LIMIT 1 the UPDATE hits every stack of this ammo type, so one shot spends several units');
  assert.ok(norm.includes('where id ='),
    'the UPDATE must be keyed on a single id, not on user_id/item_type_id directly');
  assert.ok(norm.includes('quantity > 0'),
    'the quantity > 0 predicate is the has-ammo gate; without it an empty stack decrements to a CHECK violation and 500s');
});

test('consumeAmmo returns false when no stack has any left', async () => {
  const pool = { query: async () => ({ rowCount: 0, rows: [] }) };
  assert.equal(await consumeAmmo(pool, 'u1', 7), false);
});

test('emptying a stack deletes it rather than leaving quantity 0', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (calls.length === 1) return { rowCount: 1, rows: [{ id: 'i1', quantity: 0 }] };
    return { rowCount: 1, rows: [] };
  } };
  assert.equal(await consumeAmmo(pool, 'u1', 7), true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /delete\s+from\s+player_items/i);
  assert.deepEqual(calls[1].params, ['i1']);
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
