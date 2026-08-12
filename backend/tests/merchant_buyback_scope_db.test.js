const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { fetchShop } = require('../src/services/merchantStock');
const { buyStock } = require('../src/authority/trade');

// SOMET-280 — buyback is scoped to the account that sold the item.
//
// RUNS AGAINST A REAL SCHEMA, on purpose. Half of this ticket lives in a SQL
// predicate (`seller_user_id IS NULL OR seller_user_id = $2`), and a `{ query:
// async () => rows }` mock cannot filter anything: it hands back whatever the
// fixture declared no matter what the WHERE clause says. A mocked test of the
// list filter could only assert on the SQL *string*, which passes just as
// happily against a predicate that names the wrong column or the wrong
// parameter. So the listing half is proven here, against Postgres.
//
// The two things under test:
//   1. fetchShop must not list player A's buyback row to player B.
//   2. buyStock must REFUSE B's purchase of A's row even when handed the
//      correct row id — the crafted-websocket-frame case, which never goes
//      near fetchShop and is therefore the half that actually enforces
//      ownership. A list filter is not an authorization check.
// Base-catalog rows (seller_user_id IS NULL) must stay buyable by anyone, and
// A must still be able to buy their own row back at the price they were paid.
//
// Skipping: with no database reachable this file SKIPS (and FAILS under CI)
// rather than passing silently — a skip here means the ownership rule went
// UNVERIFIED on that run, not that it holds.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: err.message };
  }
}

const TAG = `buyback-scope-${process.pid}-${Date.now()}`;

// Every row this file writes is created here and torn down by id in `finally`.
// It NEVER deletes anything it did not create: no catalog table is touched,
// and the shared dev world/village rows are left alone (a previous agent wiped
// entity_types with an unscoped DELETE — see the class of accident this
// avoids).
async function seedFixture(pool) {
  const ua = await pool.query(
    `INSERT INTO users (username, password_hash, role, gold) VALUES ($1, 'x', 'player', 500) RETURNING id`,
    [`${TAG}-a`],
  );
  const ub = await pool.query(
    `INSERT INTO users (username, password_hash, role, gold) VALUES ($1, 'x', 'player', 500) RETURNING id`,
    [`${TAG}-b`],
  );
  const userA = ua.rows[0].id;
  const userB = ub.rows[0].id;

  const mkChar = async (userId, suffix) => {
    const c = await pool.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id)
       SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = 'Warrior' RETURNING id`,
      [userId, `${TAG}-${suffix}`],
    );
    assert.ok(c.rows.length, "fixture needs a 'Warrior' entity type to build a character on");
    return c.rows[0].id;
  };
  const charA = await mkChar(userA, 'ca');
  const charB = await mkChar(userB, 'cb');

  const w = await pool.query(
    `INSERT INTO worlds (name, seed, width, height) VALUES ($1, 1, 64, 64) RETURNING id`,
    [`${TAG}-world`],
  );
  const worldId = w.rows[0].id;
  const v = await pool.query(
    `INSERT INTO villages (world_id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y)
     VALUES ($1, 0, 0, 8, 8, 'N', 0, 0) RETURNING id`,
    [worldId],
  );
  const villageId = v.rows[0].id;

  const it = await pool.query(
    `SELECT id FROM item_types WHERE category IN ('weapon','armor') AND value > 0 ORDER BY id ASC LIMIT 1`,
  );
  assert.ok(it.rows.length, 'fixture needs at least one sellable item type');
  const itemTypeId = it.rows[0].id;

  const base = await pool.query(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     VALUES ($1, $2, $3, 10, NULL, NULL, 1) RETURNING id`,
    [worldId, villageId, itemTypeId],
  );
  const sold = await pool.query(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     VALUES ($1, $2, $3, 7, $4, now() + interval '3 days', 1) RETURNING id`,
    [worldId, villageId, itemTypeId, userA],
  );

  return {
    userA, userB, charA, charB, worldId, villageId, itemTypeId,
    baseRowId: base.rows[0].id,
    soldRowId: sold.rows[0].id,
  };
}

async function teardown(pool, fx) {
  if (!fx) return;
  // The world CASCADEs its village and every merchant_stock row in it; each
  // user CASCADEs their characters and player_items.
  await pool.query('DELETE FROM worlds WHERE id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[fx.userA, fx.userB]]).catch(() => {});
}

// buyStock resolves the buyer from entry.world.getPlayer(userId) and mirrors
// the result onto that in-memory player, so the fixture is the same shape the
// live authority holds.
function mkEntry(worldId, player) {
  return { worldId, world: { getPlayer: () => player } };
}
const mkPlayer = (gold) => ({ gold, inv: { items: [], equipment: {} }, stats: { priceMult: 0.5 } });

const goldOf = async (pool, userId) => {
  const r = await pool.query('SELECT gold FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].gold);
};
const stockExists = async (pool, id) => {
  const r = await pool.query('SELECT 1 FROM merchant_stock WHERE id = $1', [id]);
  return r.rowCount === 1;
};
const itemCount = async (pool, characterId) => {
  const r = await pool.query('SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [characterId]);
  return r.rows[0].n;
};

test('buyback is scoped to the seller: listing AND purchase (SOMET-280)', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — buyback seller-scoping is UNVERIFIED on this run`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  let fx = null;
  try {
    fx = await seedFixture(pool);

    await t.test("the seller sees their own buyback row", async () => {
      const shop = await fetchShop(pool, fx.villageId, fx.userA);
      assert.deepEqual(shop.buyback.map((r) => r.id), [fx.soldRowId]);
      assert.deepEqual(shop.catalog.map((r) => r.id), [fx.baseRowId],
        'the base catalog is public and unchanged for the seller');
    });

    await t.test("another player does NOT see the seller's buyback row", async () => {
      const shop = await fetchShop(pool, fx.villageId, fx.userB);
      assert.deepEqual(shop.buyback, [],
        "player B must not be shown player A's sold item — that is the snipe this ticket closes");
      assert.deepEqual(shop.catalog.map((r) => r.id), [fx.baseRowId],
        'B still sees the whole base catalog');
    });

    await t.test('a missing viewer id fails closed (no buyback rows, not everyone\'s)', async () => {
      const shop = await fetchShop(pool, fx.villageId, undefined);
      assert.deepEqual(shop.buyback, []);
      assert.deepEqual(shop.catalog.map((r) => r.id), [fx.baseRowId]);
    });

    // THE IMPORTANT ONE: a crafted `buy` frame carries a raw stockId and never
    // consults fetchShop, so the list filter above is worth nothing here.
    await t.test("a crafted buy of another player's row is REFUSED, given the correct id", async () => {
      const before = await goldOf(pool, fx.userB);
      const p = mkPlayer(before);
      const r = await buyStock(pool, mkEntry(fx.worldId, p), fx.userB, fx.charB, fx.soldRowId, fx.villageId);

      assert.equal(r.ok, false, "B must not be able to buy A's row by id");
      assert.match(r.reason, /no longer for sale/i);
      assert.equal(await goldOf(pool, fx.userB), before, 'no gold moved');
      assert.equal(p.gold, before, 'in-memory wallet untouched');
      assert.equal(p.inv.items.length, 0, 'no item mirrored into the live inventory');
      assert.equal(await itemCount(pool, fx.charB), 0, 'no player_items row was granted');
      assert.equal(await stockExists(pool, fx.soldRowId), true,
        "A's row must survive the refused purchase");
    });

    await t.test('base-catalog rows stay buyable by anyone', async () => {
      const before = await goldOf(pool, fx.userB);
      const p = mkPlayer(before);
      const r = await buyStock(pool, mkEntry(fx.worldId, p), fx.userB, fx.charB, fx.baseRowId, fx.villageId);

      assert.equal(r.ok, true, 'the public catalog must not be caught by the ownership check');
      assert.equal(await goldOf(pool, fx.userB), before - 10);
      assert.equal(await itemCount(pool, fx.charB), 1);
      assert.equal(await stockExists(pool, fx.baseRowId), true, 'base catalog is infinite stock');
    });

    await t.test('the seller can still buy their own row back, at the price they were paid', async () => {
      const before = await goldOf(pool, fx.userA);
      const p = mkPlayer(before);
      const r = await buyStock(pool, mkEntry(fx.worldId, p), fx.userA, fx.charA, fx.soldRowId, fx.villageId);

      assert.equal(r.ok, true);
      assert.equal(await goldOf(pool, fx.userA), before - 7, 'charged the stored buyback price, not the item value');
      assert.equal(await itemCount(pool, fx.charA), 1);
      assert.equal(await stockExists(pool, fx.soldRowId), false, 'a buyback row is one-off and is consumed');
    });
  } finally {
    await teardown(pool, fx);
    await pool.end().catch(() => {});
  }
});
