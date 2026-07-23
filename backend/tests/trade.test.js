// backend/tests/trade.test.js
const test = require('node:test');
const assert = require('node:assert');
const { buyStock, sellItem } = require('../src/authority/trade');

function mkEntry(player, worldId = 'w1') {
  return { worldId, world: { getPlayer: () => player } };
}
const PLAYER = () => ({ userId: 1, gold: 100, x: 0, y: 0, width: 64, height: 64,
  inv: { items: [{ id: 'i1', typeId: 3, quantity: 1 }], equipment: {} } });

// Builds a mock pool whose `connect()` returns a fake client that records
// BEGIN/COMMIT/ROLLBACK alongside the statements routed to `handlers`.
function mkPool(handlers) {
  const seen = [];
  let committed = false;
  let rolledBack = false;
  const client = {
    query: async (sql, params) => {
      seen.push(sql);
      if (/^BEGIN$/i.test(sql.trim())) return {};
      if (/^COMMIT$/i.test(sql.trim())) { committed = true; return {}; }
      if (/^ROLLBACK$/i.test(sql.trim())) { rolledBack = true; return {}; }
      for (const [re, fn] of handlers) {
        if (re.test(sql)) return fn(sql, params);
      }
      throw new Error('unexpected ' + sql);
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    seen,
    get committed() { return committed; },
    get rolledBack() { return rolledBack; },
  };
  return pool;
}

test('buyStock debits gold, grants the item, and leaves a base-catalog row in place', async () => {
  const p = PLAYER();
  const pool = mkPool([
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's1', item_type_id: 3, price: 20, seller_user_id: null, village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, (sql) => { assert.match(sql, /gold >= /, 'debit must be overdraft-safe'); return { rowCount: 1, rows: [{ gold: 80 }] }; }],
    [/INSERT INTO player_items/i, () => ({ rows: [{ id: 'new1', item_type_id: 3, quantity: 1 }] })],
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 's1');
  assert.equal(r.ok, true);
  assert.equal(r.gold, 80);
  assert.equal(p.gold, 80, 'in-memory wallet mirrors');
  assert.ok(p.inv.items.some((it) => it.id === 'new1'), 'item added to in-memory inventory');
  assert.ok(!pool.seen.some((s) => /DELETE FROM merchant_stock/i.test(s)), 'base-catalog row is NOT consumed');
  assert.equal(pool.committed, true, 'transaction committed on success');
  assert.equal(pool.rolledBack, false);
  // BEGIN before any business query, COMMIT after the last one.
  assert.match(pool.seen[0], /^BEGIN$/i);
  assert.match(pool.seen[pool.seen.length - 1], /^COMMIT$/i);
});

test('buying a buyback row deletes it', async () => {
  const p = PLAYER();
  let deleted = false;
  const pool = mkPool([
    // NOTE: DELETE is checked before the generic SELECT match below, since
    // "DELETE FROM merchant_stock WHERE id = $1" also matches
    // /FROM merchant_stock WHERE id/i and would otherwise be misrouted.
    [/DELETE FROM merchant_stock/i, () => { deleted = true; return { rowCount: 1 }; }],
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's2', item_type_id: 3, price: 5, seller_user_id: 7, village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, () => ({ rowCount: 1, rows: [{ gold: 95 }] })],
    [/INSERT INTO player_items/i, () => ({ rows: [{ id: 'new2', item_type_id: 3, quantity: 1 }] })],
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 's2');
  assert.equal(r.ok, true);
  assert.equal(deleted, true, 'buyback rows are one-off and must be removed');
  assert.equal(pool.committed, true);
  assert.equal(pool.rolledBack, false);
});

test('buyStock locks the stock row FOR UPDATE to prevent a concurrent double-sell', async () => {
  const p = PLAYER();
  let selectSql = null;
  const pool = mkPool([
    [/FROM merchant_stock WHERE id/i, (sql) => { selectSql = sql; return { rows: [{ id: 's1', item_type_id: 3, price: 20, seller_user_id: null, village_id: 'v1' }] }; }],
    [/UPDATE users SET gold = gold - /i, () => ({ rowCount: 1, rows: [{ gold: 80 }] })],
    [/INSERT INTO player_items/i, () => ({ rows: [{ id: 'new1', item_type_id: 3, quantity: 1 }] })],
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 's1');
  assert.equal(r.ok, true);
  assert.match(selectSql, /FOR UPDATE/i, 'stock row must be locked to serialize concurrent buyers');
});

test('a buyback whose row vanishes out from under the DELETE (lost race) rolls back and grants nothing', async () => {
  const p = PLAYER();
  const pool = mkPool([
    // Row still visible to this transaction's SELECT ... FOR UPDATE (it had to
    // wait for the winner's lock, then re-read), but by the time this tx's
    // DELETE runs the row is already gone — defensive rowCount check catches it.
    [/DELETE FROM merchant_stock/i, () => ({ rowCount: 0 })],
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's2', item_type_id: 3, price: 5, seller_user_id: 7, village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, () => ({ rowCount: 1, rows: [{ gold: 95 }] })],
    [/INSERT INTO player_items/i, () => ({ rows: [{ id: 'new2', item_type_id: 3, quantity: 1 }] })],
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 's2');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no longer for sale/i);
  assert.equal(pool.rolledBack, true, 'must roll back when the buyback row is already gone');
  assert.equal(pool.committed, false, 'must not commit a grant for a row that no longer exists');
  assert.equal(p.gold, 100, 'wallet must be untouched — no debit persisted in memory');
  assert.ok(!p.inv.items.some((it) => it.id === 'new2'), 'no item granted');
  assert.equal(p.inv.items.length, 1, 'inventory unchanged from initial state');
});

test('buyStock with insufficient gold errors, grants nothing, and rolls back', async () => {
  const p = PLAYER();
  const pool = mkPool([
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's1', item_type_id: 3, price: 500, seller_user_id: null, village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, () => ({ rowCount: 0, rows: [] })], // guard rejected
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 's1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /gold/i);
  assert.equal(p.gold, 100, 'wallet untouched');
  assert.ok(!pool.seen.some((s) => /INSERT INTO player_items/i.test(s)), 'no item granted');
  assert.equal(pool.committed, false, 'must not commit on rejection');
  assert.equal(pool.rolledBack, true, 'must roll back on rejection');
});

test('sellItem removes the item, credits gold, and inserts a buyback row', async () => {
  const p = PLAYER();
  const pool = mkPool([
    [/DELETE FROM player_items/i, (sql) => { assert.match(sql, /user_id = \$2/, 'ownership enforced in SQL'); return { rowCount: 1, rows: [{ item_type_id: 3, quantity: 1 }] }; }],
    [/SELECT value FROM item_types/i, () => ({ rows: [{ value: 20 }] })],
    [/UPDATE users SET gold = gold \+ /i, () => ({ rowCount: 1, rows: [{ gold: 110 }] })],
    [/INSERT INTO merchant_stock/i, () => ({ rows: [{ id: 'b1' }] })],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 'v1', 'i1');
  assert.equal(r.ok, true);
  assert.equal(r.price, 10, 'sell price is half of value 20');
  assert.equal(r.gold, 110);
  assert.equal(p.gold, 110);
  assert.ok(!p.inv.items.some((it) => it.id === 'i1'), 'item removed from in-memory inventory');
  assert.equal(pool.committed, true, 'transaction committed on success');
  assert.equal(pool.rolledBack, false);
  assert.match(pool.seen[0], /^BEGIN$/i);
  assert.match(pool.seen[pool.seen.length - 1], /^COMMIT$/i);
});

test('sellItem refuses an equipped item, mutates nothing, and never opens a transaction', async () => {
  const p = PLAYER(); p.inv.equipment = { main_hand: 'i1' };
  const pool = {
    connect: async () => { throw new Error('must not connect: equipped-item guard must reject before DB work'); },
  };
  const r = await sellItem(pool, mkEntry(p), 1, 'v1', 'i1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unequip/i);
});

test('sellItem refuses an item the player does not own and rolls back', async () => {
  const p = PLAYER();
  const pool = mkPool([
    [/DELETE FROM player_items/i, () => ({ rowCount: 0, rows: [] })],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 'v1', 'nope');
  assert.equal(r.ok, false);
  assert.match(r.reason, /own/i);
  assert.ok(!pool.seen.some((s) => /UPDATE users SET gold = gold \+ /i.test(s)), 'no credit on rejection');
  assert.ok(!pool.seen.some((s) => /INSERT INTO merchant_stock/i.test(s)), 'no buyback row on rejection');
  assert.equal(pool.committed, false, 'must not commit on rejection');
  assert.equal(pool.rolledBack, true, 'must roll back on rejection');
});

test('buyStock requires an inventory (fails loud like sellItem, not silently)', async () => {
  const p = PLAYER(); delete p.inv;
  const pool = { connect: async () => { throw new Error('must not connect: missing-inv guard must reject before DB work'); } };
  const r = await buyStock(pool, mkEntry(p), 1, 's1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no player/i);
});
