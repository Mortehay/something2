// SOMET-278 (reserved/referenced item types) + SOMET-281 (repricing merchant
// stock on a value edit). Both live in the same two route handlers
// (PUT/DELETE /api/item-types/:id), which is why they share a file.
//
// SOMET-278: the gold row (name 'gold', category 'currency') is the game's
// currency. authority/items.js resolveGoldItemTypeId finds it BY NAME, so a
// DELETE (which cascades every world_items gold pile away) or a rename turns
// the economy off with nothing logged. DELETE also had no reference check at
// all, unlike the entity-types DELETE right above it.
//
// SOMET-281: merchant_stock.price is a seed-time snapshot of item_types.value.
// PUT never refreshed it, so raising an item's value left villages SELLING at
// the old price while trade.js PAID sellPriceFor(the new value). The repair
// must never touch a buyback row: its price is what its seller was actually
// paid, and SOMET-156 promises they can buy it back at that price.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');

const { app, __setPool } = require('../src/index.js');
const { repriceBaseCatalog } = require('../src/services/merchantStock');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// Same dispatch-on-SQL pool mock item_types_api.test.js uses. Anything the
// route queries that the test did not anticipate throws, so "the route did not
// issue query X" is provable both by the absence of X in `calls` and by the
// request not 500ing.
function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) {
        if (re.test(sql)) return fn(params);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const GOLD_ROW = { id: 28, name: 'gold', category: 'currency', value: 0 };
const SWORD_ROW = { id: 7, name: 'shortsword', category: 'weapon', value: 10 };

const LOAD_ROW = [/SELECT .*FROM item_types WHERE id = \$1/i];

// The seven reference probes DELETE fans out, all answered empty by default.
function noReferences() {
  return [
    [/SELECT 1 FROM player_items/i, () => ({ rows: [] })],
    [/SELECT 1 FROM creature_drops/i, () => ({ rows: [] })],
    [/SELECT 1 FROM behavior_drops/i, () => ({ rows: [] })],
    [/SELECT 1 FROM chest_loot/i, () => ({ rows: [] })],
    [/SELECT 1 FROM class_loadouts/i, () => ({ rows: [] })],
    [/SELECT 1 FROM merchant_stock/i, () => ({ rows: [] })],
    [/FROM item_types WHERE ammo_type_id/i, () => ({ rows: [] })],
  ];
}

function deleteCalls(pool) {
  return pool.calls.filter((c) => /DELETE FROM item_types/i.test(c.sql));
}

function itemUpdateCalls(pool) {
  return pool.calls.filter((c) => /UPDATE item_types/i.test(c.sql));
}

// --------------------------------------------------------------------------
// SOMET-278: the reserved currency row
// --------------------------------------------------------------------------

// The gold row has no player_items/loot-table references of its own -- gold
// lives in world_items and users.gold -- so these mocks answer every reference
// probe empty AND stand ready to serve the DELETE. Only the reserved guard can
// stop it: remove that guard and the route 204s with the DELETE issued.
test('DELETE /api/item-types/:id refuses to delete the reserved gold row', async () => {
  const pool = mockPool([
    [...LOAD_ROW, () => ({ rows: [GOLD_ROW] })],
    ...noReferences(),
    [/DELETE FROM item_types/i, (p) => ({ rows: [{ id: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/item-types/28').set(...AUTH);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /gold/);
  assert.equal(deleteCalls(pool).length, 0, 'the reserved row must never reach the DELETE');
});

test('DELETE /api/item-types/:id refuses a currency row even after it was renamed out of band', async () => {
  // The second reservation key: `category = 'currency'`. If the guard keyed on
  // the name alone, a row renamed by SQL or a future migration would lose its
  // protection.
  const pool = mockPool([
    [...LOAD_ROW, () => ({ rows: [{ id: 28, name: 'coin', category: 'currency', value: 0 }] })],
    ...noReferences(),
    [/DELETE FROM item_types/i, (p) => ({ rows: [{ id: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/item-types/28').set(...AUTH);
  assert.equal(res.status, 409);
  assert.equal(deleteCalls(pool).length, 0);
});

test('DELETE /api/item-types/:id 409s when a player still owns an instance', async () => {
  const pool = mockPool([
    [...LOAD_ROW, () => ({ rows: [SWORD_ROW] })],
    ...noReferences().filter(([re]) => !/player_items/.test(re.source)),
    [/SELECT 1 FROM player_items/i, () => ({ rows: [{ '?column?': 1 }] })],
    // Servable, so dropping the reference check 204s instead of erroring out.
    [/DELETE FROM item_types/i, (p) => ({ rows: [{ id: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/item-types/7').set(...AUTH);
  assert.equal(res.status, 409);
  assert.equal(res.body.references.player_items, true);
  assert.equal(deleteCalls(pool).length, 0, 'a referenced type must not be cascaded away');
});

test('DELETE /api/item-types/:id 409s when a weapon still names it as ammo', async () => {
  const pool = mockPool([
    [...LOAD_ROW, () => ({ rows: [{ id: 9, name: 'arrow', category: 'ammo', value: 1 }] })],
    ...noReferences().filter(([re]) => !/ammo_type_id/.test(re.source)),
    [/FROM item_types WHERE ammo_type_id/i, () => ({ rows: [{ id: 3, name: 'bow' }] })],
    [/DELETE FROM item_types/i, (p) => ({ rows: [{ id: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/item-types/9').set(...AUTH);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.referencing_weapons, [{ id: 3, name: 'bow' }]);
  assert.equal(deleteCalls(pool).length, 0);
});

test('DELETE /api/item-types/:id still deletes an unreferenced ordinary item type', async () => {
  const pool = mockPool([
    [...LOAD_ROW, () => ({ rows: [SWORD_ROW] })],
    ...noReferences(),
    [/DELETE FROM item_types/i, (p) => ({ rows: [{ id: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/item-types/7').set(...AUTH);
  assert.equal(res.status, 204);
  assert.equal(deleteCalls(pool).length, 1, 'the guard must not make the route unusable');
  // Base-catalog merchant rows are regenerable, so only BUYBACK rows (one
  // player's contract) may block a delete -- otherwise every seeded weapon
  // would be permanently undeletable.
  const stockProbe = pool.calls.find((c) => /SELECT 1 FROM merchant_stock/i.test(c.sql));
  assert.match(stockProbe.sql, /seller_user_id IS NOT NULL/i);
});

test('DELETE /api/item-types/:id 404s for an unknown id', async () => {
  const pool = mockPool([[...LOAD_ROW, () => ({ rows: [] })]]);
  __setPool(pool);
  const res = await request(app).delete('/api/item-types/999').set(...AUTH);
  assert.equal(res.status, 404);
  assert.equal(deleteCalls(pool).length, 0);
});

test('PUT /api/item-types/:id refuses to rename the reserved gold row', async () => {
  // The rename an admin can actually perform today: category 'armor' + a slot
  // and defense passes validateItemType, so nothing but this guard stops
  // `name === 'gold'` from resolving to nothing forever after.
  // The mock would happily serve the UPDATE and everything after it: only the
  // guard stops this request from succeeding.
  const pool = mockPool([
    [...LOAD_ROW, () => ({ rows: [GOLD_ROW] })],
    [/UPDATE item_types/i, (p) => ({ rows: [{ id: 28, name: p[0], category: p[1], value: 0 }] })],
    [/DELETE FROM merchant_stock/i, () => ({ rowCount: 0 })],
    [/INSERT INTO merchant_stock/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/item-types/28').set(...AUTH)
    .send({ name: 'coin', category: 'armor', slot: 'chest', defense: 1, value: 0 });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /gold/);
  assert.equal(itemUpdateCalls(pool).length, 0, 'the rename must never reach the UPDATE');
});

test('PUT /api/item-types/:id refuses to recategorize the reserved gold row under its own name', async () => {
  const pool = mockPool([
    [...LOAD_ROW, () => ({ rows: [GOLD_ROW] })],
    [/UPDATE item_types/i, (p) => ({ rows: [{ id: 28, name: p[0], category: p[1], value: 0 }] })],
    [/DELETE FROM merchant_stock/i, () => ({ rowCount: 0 })],
    [/INSERT INTO merchant_stock/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/item-types/28').set(...AUTH)
    .send({ name: 'gold', category: 'armor', slot: 'chest', defense: 1, value: 0 });
  assert.equal(res.status, 409);
  assert.equal(itemUpdateCalls(pool).length, 0);
});

test('PUT /api/item-types/:id lets the reserved row be edited under its own name and category', async () => {
  // Before the fix this 400d with "category must be 'weapon', 'armor' or
  // 'ammo'" -- a misleading message for a row whose real, seeded category is
  // 'currency'. Editing its icon/value must work.
  const pool = mockPool([
    [...LOAD_ROW, () => ({ rows: [GOLD_ROW] })],
    [/UPDATE item_types/i, (p) => ({ rows: [{ id: 28, name: p[0], category: p[1], value: 0 }] })],
    [/DELETE FROM merchant_stock/i, () => ({ rowCount: 0 })],
    [/INSERT INTO merchant_stock/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/item-types/28').set(...AUTH)
    .send({ name: 'gold', category: 'currency', icon: 'coin.png', value: 0 });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'gold');
  assert.equal(res.body.category, 'currency');
  assert.equal(itemUpdateCalls(pool).length, 1);
});

test('PUT /api/item-types/:id still rejects category currency on a row that is not reserved', async () => {
  // The relaxation is keyed to the STORED row, never to the request body --
  // otherwise any caller could mint a currency row by simply asking for one.
  const pool = mockPool([
    [...LOAD_ROW, () => ({ rows: [SWORD_ROW] })],
    [/UPDATE item_types/i, (p) => ({ rows: [{ id: 7, name: p[0], category: p[1], value: 10 }] })],
    [/UPDATE merchant_stock/i, () => ({ rowCount: 0 })],
    [/INSERT INTO merchant_stock/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/item-types/7').set(...AUTH)
    .send({ name: 'shortsword', category: 'currency', value: 10 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /category/i);
  assert.equal(itemUpdateCalls(pool).length, 0);
});

// --------------------------------------------------------------------------
// SOMET-281: repricing merchant stock, without disturbing buyback rows
// --------------------------------------------------------------------------

test('repriceBaseCatalog rewrites base-catalog prices only', async () => {
  let sql = '', params = null;
  const pool = { query: async (s, p) => { sql = s; params = p; return { rowCount: 3 }; } };
  const n = await repriceBaseCatalog(pool, 7, 1000);
  assert.equal(n, 3);
  assert.match(sql, /UPDATE merchant_stock/i);
  assert.match(sql, /seller_user_id IS NULL/i, "a buyback row's price is its seller's contract");
  assert.deepEqual(params, [7, 1000]);
});

test('repriceBaseCatalog removes base-catalog rows when the value drops to 0, keeping buyback rows', async () => {
  // value <= 0 is exactly the "not sold in shops" rule seedBaseCatalog applies.
  // Repricing to 0 instead would hand out free gear.
  let sql = '', params = null;
  const pool = { query: async (s, p) => { sql = s; params = p; return { rowCount: 2 }; } };
  const n = await repriceBaseCatalog(pool, 7, 0);
  assert.equal(n, 2);
  assert.match(sql, /DELETE FROM merchant_stock/i);
  assert.match(sql, /seller_user_id IS NULL/i);
  assert.doesNotMatch(sql, /SET price/i);
  assert.deepEqual(params, [7]);
});

test('PUT /api/item-types/:id reprices existing stock when the value changes', async () => {
  const pool = mockPool([
    [...LOAD_ROW, () => ({ rows: [SWORD_ROW] })], // stored value 10
    [/UPDATE item_types/i, (p) => ({ rows: [{ id: 7, name: p[0], category: p[1], value: 1000 }] })],
    [/UPDATE merchant_stock/i, () => ({ rowCount: 4 })],
    [/INSERT INTO merchant_stock/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/item-types/7').set(...AUTH).send({
    name: 'shortsword', category: 'weapon', kind: 'melee', reach: 60, arc_width: 0.5, value: 1000,
  });
  assert.equal(res.status, 200);

  const reprice = pool.calls.find((c) => /UPDATE merchant_stock/i.test(c.sql));
  assert.ok(reprice, 'a value edit must re-price the stock it snapshotted');
  assert.deepEqual(reprice.params, [7, 1000], 'must reprice this item to the NEW value');
  assert.equal(res.body.repricedStock, 4);

  // Nothing this route does to merchant_stock may be able to reach a buyback
  // row: every statement it issues is scoped to seller_user_id IS NULL (the
  // INSERT backfill only ever creates base rows, hence the NULL literal).
  const stockWrites = pool.calls.filter((c) => /merchant_stock/i.test(c.sql));
  assert.ok(stockWrites.length >= 2);
  for (const w of stockWrites) {
    assert.match(w.sql, /seller_user_id IS NULL|NULL, NULL, 1/i,
      `merchant_stock statement must not be able to touch a buyback row: ${w.sql}`);
  }
});

// --------------------------------------------------------------------------
// The predicate itself, executed by a real Postgres -- READ ONLY.
//
// The assertions above check the SQL *text*; this one checks what that text
// actually SELECTS. It takes the WHERE clause the production statement issues
// (captured, not retyped) and evaluates it against a fixture row set built
// with VALUES, so no table is read, written, locked or created. If the guard
// were ever weakened to `seller_user_id = NULL` (always false/NULL), dropped,
// or replaced with `seller_user_id IS NOT NULL`, this fails on the rows the
// predicate picks, not on how it is spelled.
// --------------------------------------------------------------------------

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

// Rows a real village has after a sale: base-catalog rows for two item types
// plus one buyback row for the same item, priced at what its seller was paid.
const FIXTURE = `(VALUES
    ('base-same-price', 7, NULL::int, 1000::int),
    ('base-stale',      7, NULL::int, 10::int),
    ('buyback',         7, 42::int,   5::int),
    ('base-other-item', 8, NULL::int, 10::int)
  ) AS merchant_stock(id, item_type_id, seller_user_id, price)`;

function whereClauseOf(sql) {
  const idx = sql.search(/\bWHERE\b/i);
  assert.ok(idx > 0, `expected a WHERE clause in: ${sql}`);
  const where = sql.slice(idx);
  assert.ok(!/;/.test(where), 'WHERE clause extraction must capture a single statement');
  return where;
}

async function capture(itemTypeId, value) {
  let captured = null;
  await repriceBaseCatalog(
    { query: async (sql, params) => { captured = { sql, params }; return { rowCount: 0 }; } },
    itemTypeId, value,
  );
  return captured;
}

test('the reprice predicate, run by Postgres, never selects a buyback row (read-only)', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`database unreachable: ${pool.unreachable}`); return; }
  try {
    const up = await capture(7, 1000);
    const rows = (await pool.query(
      `SELECT id FROM ${FIXTURE} ${whereClauseOf(up.sql)} ORDER BY id`, up.params,
    )).rows.map((r) => r.id);
    assert.deepEqual(rows, ['base-stale'],
      'must reprice only the drifted base-catalog row of THIS item -- never the buyback row');

    const del = await capture(7, 0);
    const deleted = (await pool.query(
      `SELECT id FROM ${FIXTURE} ${whereClauseOf(del.sql)} ORDER BY id`, del.params,
    )).rows.map((r) => r.id);
    assert.deepEqual(deleted, ['base-same-price', 'base-stale'],
      'un-stocking must remove this item\'s base rows only -- never the buyback row, never another item');
  } finally {
    if (pool.end) await pool.end().catch(() => {});
  }
});
