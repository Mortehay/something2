// backend/tests/trade.test.js
const test = require('node:test');
const assert = require('node:assert');
const { buyStock, sellItem } = require('../src/authority/trade');

function mkEntry(player, worldId = 'w1') {
  return { worldId, world: { getPlayer: () => player } };
}
const PLAYER = () => ({ userId: 1, gold: 100, x: 0, y: 0, width: 64, height: 64,
  inv: { items: [{ id: 'i1', typeId: 3, quantity: 1 }], equipment: {} } });

test('buyStock debits gold, grants the item, and leaves a base-catalog row in place', async () => {
  const p = PLAYER(); const seen = [];
  const pool = { query: async (sql, params) => {
    seen.push(sql);
    if (/FROM merchant_stock WHERE id/i.test(sql)) return { rows: [{ id: 's1', item_type_id: 3, price: 20, seller_user_id: null, village_id: 'v1' }] };
    if (/UPDATE users SET gold = gold - /i.test(sql)) { assert.match(sql, /gold >= /, 'debit must be overdraft-safe'); return { rowCount: 1, rows: [{ gold: 80 }] }; }
    if (/INSERT INTO player_items/i.test(sql)) return { rows: [{ id: 'new1', item_type_id: 3, quantity: 1 }] };
    throw new Error('unexpected ' + sql);
  } };
  const r = await buyStock(pool, mkEntry(p), 1, 's1');
  assert.equal(r.ok, true);
  assert.equal(r.gold, 80);
  assert.equal(p.gold, 80, 'in-memory wallet mirrors');
  assert.ok(p.inv.items.some((it) => it.id === 'new1'), 'item added to in-memory inventory');
  assert.ok(!seen.some((s) => /DELETE FROM merchant_stock/i.test(s)), 'base-catalog row is NOT consumed');
});

test('buying a buyback row deletes it', async () => {
  const p = PLAYER(); let deleted = false;
  const pool = { query: async (sql) => {
    // NOTE: DELETE is checked before the generic SELECT match below, since
    // "DELETE FROM merchant_stock WHERE id = $1" also matches
    // /FROM merchant_stock WHERE id/i and would otherwise be misrouted.
    if (/DELETE FROM merchant_stock/i.test(sql)) { deleted = true; return { rowCount: 1 }; }
    if (/FROM merchant_stock WHERE id/i.test(sql)) return { rows: [{ id: 's2', item_type_id: 3, price: 5, seller_user_id: 7, village_id: 'v1' }] };
    if (/UPDATE users SET gold = gold - /i.test(sql)) return { rowCount: 1, rows: [{ gold: 95 }] };
    if (/INSERT INTO player_items/i.test(sql)) return { rows: [{ id: 'new2', item_type_id: 3, quantity: 1 }] };
    throw new Error('unexpected ' + sql);
  } };
  const r = await buyStock(pool, mkEntry(p), 1, 's2');
  assert.equal(r.ok, true);
  assert.equal(deleted, true, 'buyback rows are one-off and must be removed');
});

test('buyStock with insufficient gold errors and grants nothing', async () => {
  const p = PLAYER(); const seen = [];
  const pool = { query: async (sql) => {
    seen.push(sql);
    if (/FROM merchant_stock WHERE id/i.test(sql)) return { rows: [{ id: 's1', item_type_id: 3, price: 500, seller_user_id: null, village_id: 'v1' }] };
    if (/UPDATE users SET gold = gold - /i.test(sql)) return { rowCount: 0, rows: [] }; // guard rejected
    throw new Error('unexpected ' + sql);
  } };
  const r = await buyStock(pool, mkEntry(p), 1, 's1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /gold/i);
  assert.equal(p.gold, 100, 'wallet untouched');
  assert.ok(!seen.some((s) => /INSERT INTO player_items/i.test(s)), 'no item granted');
});

test('sellItem removes the item, credits gold, and inserts a buyback row', async () => {
  const p = PLAYER();
  const pool = { query: async (sql, params) => {
    if (/DELETE FROM player_items/i.test(sql)) {
      assert.match(sql, /user_id = \$2/, 'ownership enforced in SQL');
      return { rowCount: 1, rows: [{ item_type_id: 3, quantity: 1 }] };
    }
    if (/SELECT value FROM item_types/i.test(sql)) return { rows: [{ value: 20 }] };
    if (/UPDATE users SET gold = gold \+ /i.test(sql)) return { rowCount: 1, rows: [{ gold: 110 }] };
    if (/INSERT INTO merchant_stock/i.test(sql)) return { rows: [{ id: 'b1' }] };
    throw new Error('unexpected ' + sql);
  } };
  const r = await sellItem(pool, mkEntry(p), 1, 'v1', 'i1');
  assert.equal(r.ok, true);
  assert.equal(r.price, 10, 'sell price is half of value 20');
  assert.equal(r.gold, 110);
  assert.equal(p.gold, 110);
  assert.ok(!p.inv.items.some((it) => it.id === 'i1'), 'item removed from in-memory inventory');
});

test('sellItem refuses an equipped item and mutates nothing', async () => {
  const p = PLAYER(); p.inv.equipment = { main_hand: 'i1' };
  const pool = { query: async (sql) => { throw new Error('must not query: ' + sql); } };
  const r = await sellItem(pool, mkEntry(p), 1, 'v1', 'i1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unequip/i);
});

test('sellItem refuses an item the player does not own', async () => {
  const p = PLAYER();
  const pool = { query: async (sql) => {
    if (/DELETE FROM player_items/i.test(sql)) return { rowCount: 0, rows: [] };
    throw new Error('unexpected ' + sql);
  } };
  const r = await sellItem(pool, mkEntry(p), 1, 'v1', 'nope');
  assert.equal(r.ok, false);
  assert.match(r.reason, /own/i);
});
