const test = require('node:test');
const assert = require('node:assert');
const { sellPriceFor, fetchShop, seedBaseCatalog, seedItemAcrossVillages, insertBuyback, SELL_FRACTION, BUYBACK_DAYS } =
  require('../src/services/merchantStock');

test('sellPriceFor is half the value, floored, and never negative', () => {
  assert.equal(SELL_FRACTION, 0.5);
  assert.equal(sellPriceFor(10), 5);
  assert.equal(sellPriceFor(11), 5);
  assert.equal(sellPriceFor(0), 0);
  assert.equal(sellPriceFor(undefined), 0);
});

// SOMET-500 widened the read: the shelf now carries the DISPLAY IDENTITY of the
// instance a buyback row is holding (services/heldInstance.js). This case pins
// both halves of that against a mock -- a hydrated row gains rarity/itemLevel/
// affixes, and an instance-less row (the infinite base catalogue, and any
// pre-484 buyback row) keeps the five-key shape it has always had. The mock
// cannot prove the JOIN finds the right instance; merchant_buyback_instance_db
// and shelf_rarity_db do that against a real database.
test('fetchShop sweeps expired rows, then splits catalog vs buyback', async () => {
  const calls = [];
  const EFFECT = { type: 'stat', stat: 'strength' };
  const pool = { query: async (sql, params) => {
    calls.push(sql);
    if (/DELETE FROM merchant_stock/i.test(sql)) return { rowCount: 2 };
    if (/SELECT[\s\S]*FROM merchant_stock/i.test(sql)) {
      assert.match(sql, /ms\.expires_at IS NULL OR ms\.expires_at > now\(\)/i,
        'the read must exclude expired rows');
      assert.match(sql, /pi\.merchant_stock_id = ms\.id/i,
        'and must reach the instance the stock row is holding');
      return { rows: [
        // No instance: the generated base catalogue, permanently.
        { id: 'c1', item_type_id: 1, price: 20, quantity: 1, seller_user_id: null, instance_id: null },
        // Holding one, which is what SOMET-484 made possible and SOMET-500 lists.
        {
          id: 'b1', item_type_id: 2, price: 5, quantity: 1, seller_user_id: 7,
          instance_id: 'pi-1', rarity: 'yellow', item_level: 30,
          affixes: [{ affixTypeId: 3, key: 'of_might', label: 'of Might', value: 3.13, effect: EFFECT }],
        },
      ] };
    }
    throw new Error('unexpected ' + sql);
  } };
  const shop = await fetchShop(pool, 'v1', 7);
  assert.ok(calls.some((s) => /DELETE FROM merchant_stock/i.test(s)), 'expired sweep ran');
  assert.deepStrictEqual(shop.catalog, [
    { id: 'c1', itemTypeId: 1, price: 20, quantity: 1, sellerUserId: null },
  ], 'an instance-less row must gain no keys at all -- the panel falls back to its own neutral');
  assert.deepStrictEqual(shop.buyback, [{
    id: 'b1', itemTypeId: 2, price: 5, quantity: 1, sellerUserId: 7,
    rarity: 'yellow', itemLevel: 30,
    affixes: [{ affixTypeId: 3, key: 'of_might', label: 'of Might', value: 3.13, effect: EFFECT }],
  }], 'a held instance reaches the shelf with its grade, its level and its rolled VALUES');
});

// SOMET-280. A mock pool returns whatever the fixture declared regardless of
// the WHERE clause, so this can only check that the read is SHAPED to scope
// buyback to its seller and is parameterized on the viewer -- a filter written
// against the wrong parameter would still pass here. The behavioural proof (B
// genuinely does not receive A's row) is in merchant_buyback_scope_db.test.js,
// against a real database. This case is the cheap sentinel that runs even with
// no Postgres around.
test('fetchShop scopes buyback rows to the viewing user, and keeps the base catalog public', async () => {
  let readSql = '', readParams = null;
  const pool = { query: async (sql, params) => {
    if (/DELETE FROM merchant_stock/i.test(sql)) {
      assert.ok(!/seller_user_id/i.test(sql),
        'the expired sweep must stay global: an expired row is garbage whoever sold it');
      return { rowCount: 0 };
    }
    readSql = sql; readParams = params;
    return { rows: [] };
  } };
  await fetchShop(pool, 'v1', 42);
  assert.match(readSql, /ms\.seller_user_id IS NULL OR ms\.seller_user_id = \$2/i,
    'base catalog stays public; seller-owned rows are restricted to their seller');
  assert.deepEqual(readParams, ['v1', 42], 'the viewer id must be the second bound parameter');
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

// F-006 (SOMET-186): seedBaseCatalog only ever ran once, at village creation,
// so an item type added afterward never reached a village that already
// existed. Fixed by (1) making the base-catalog INSERT idempotent (a NOT
// EXISTS guard) and (2) adding seedItemAcrossVillages, called right after an
// item type is created, to backfill that one item type into every existing
// village. Both need the guard so a retried/duplicate call never double-
// inserts a base-catalog row for the same village+item.
test('seedBaseCatalog is idempotent: it does not re-insert a row that already exists', async () => {
  let insertSql = '';
  const pool = { query: async (sql) => {
    if (/INSERT INTO merchant_stock/i.test(sql)) { insertSql = sql; return { rows: [] }; }
    throw new Error('unexpected ' + sql);
  } };
  await seedBaseCatalog(pool, 'w1', 'v1');
  assert.match(insertSql, /NOT EXISTS/i, 'must guard against a duplicate base-catalog row');
  assert.match(insertSql, /seller_user_id IS NULL/i, 'the guard must only match base-catalog rows, not buyback rows');
});

test('seedItemAcrossVillages backfills one item type into every village missing it', async () => {
  let insertSql = '', insertParams = null;
  const pool = { query: async (sql, params) => {
    if (/INSERT INTO merchant_stock/i.test(sql)) { insertSql = sql; insertParams = params; return { rows: [] }; }
    throw new Error('unexpected ' + sql);
  } };
  await seedItemAcrossVillages(pool, 76);
  assert.match(insertSql, /FROM villages v/i, 'must fan out across every village, not one');
  assert.match(insertSql, /JOIN item_types it ON it\.id = \$1/i);
  assert.match(insertSql, /category IN \('weapon','armor'\)/i);
  assert.match(insertSql, /value > 0/i);
  assert.match(insertSql, /NOT EXISTS/i, 'must not duplicate a village that already has this item');
  assert.deepEqual(insertParams, [76]);
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
