const test = require('node:test');
const assert = require('node:assert');
const { consumeAmmo } = require('../src/authority/ammo');

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
