const test = require('node:test');
const assert = require('node:assert');
const { sellPriceFor, fetchShop, seedBaseCatalog, insertBuyback, SELL_FRACTION, BUYBACK_DAYS } =
  require('../src/services/merchantStock');

test('sellPriceFor is half the value, floored, and never negative', () => {
  assert.equal(SELL_FRACTION, 0.5);
  assert.equal(sellPriceFor(10), 5);
  assert.equal(sellPriceFor(11), 5);
  assert.equal(sellPriceFor(0), 0);
  assert.equal(sellPriceFor(undefined), 0);
});

test('fetchShop sweeps expired rows, then splits catalog vs buyback', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push(sql);
    if (/DELETE FROM merchant_stock/i.test(sql)) return { rowCount: 2 };
    if (/SELECT .* FROM merchant_stock/i.test(sql)) {
      assert.match(sql, /expires_at IS NULL OR expires_at > now\(\)/i,
        'the read must exclude expired rows');
      return { rows: [
        { id: 'c1', item_type_id: 1, price: 20, quantity: 1, seller_user_id: null },
        { id: 'b1', item_type_id: 2, price: 5, quantity: 1, seller_user_id: 7 },
      ] };
    }
    throw new Error('unexpected ' + sql);
  } };
  const shop = await fetchShop(pool, 'v1');
  assert.ok(calls.some((s) => /DELETE FROM merchant_stock/i.test(s)), 'expired sweep ran');
  assert.deepEqual(shop.catalog, [{ id: 'c1', itemTypeId: 1, price: 20, quantity: 1, sellerUserId: null }]);
  assert.deepEqual(shop.buyback, [{ id: 'b1', itemTypeId: 2, price: 5, quantity: 1, sellerUserId: 7 }]);
});

test('seedBaseCatalog inserts only sellable weapon/armor types at price = value', async () => {
  let insertSql = '', insertParams = null;
  const pool = { query: async (sql, params) => {
    if (/INSERT INTO merchant_stock/i.test(sql)) { insertSql = sql; insertParams = params; return { rows: [] }; }
    throw new Error('unexpected ' + sql);
  } };
  await seedBaseCatalog(pool, 'w1', 'v1');
  assert.match(insertSql, /SELECT/i, 'seeds via INSERT ... SELECT from item_types');
  assert.match(insertSql, /category IN \('weapon','armor'\)/i);
  assert.match(insertSql, /value > 0/i);
  assert.deepEqual(insertParams, ['w1', 'v1']);
});

test('insertBuyback stores the sold price, the seller, and an expiry', async () => {
  let params = null, sql = '';
  const pool = { query: async (s, p) => { sql = s; params = p; return { rows: [{ id: 'b9' }] }; } };
  const row = await insertBuyback(pool, 'w1', 'v1', 3, 5, 7, BUYBACK_DAYS);
  assert.equal(row.id, 'b9');
  assert.match(sql, /INSERT INTO merchant_stock/i);
  assert.match(sql, /interval/i, 'expiry computed in SQL');
  assert.deepEqual(params, ['w1', 'v1', 3, 5, 7, BUYBACK_DAYS]);
});
