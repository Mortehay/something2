// SOMET-484. The merchant round trip, through the REAL sell and buy paths.
//
// Every test here calls authority/trade.js's sellItem and buyStock against a
// real database with real rows. That is deliberate and not negotiable: this
// epic has now shipped several features that were live in the schema, drawn in
// the UI and completely inert in play, each with a fully green suite, because
// what was tested was a pure helper round-tripping a JS object rather than the
// path a player actually walks.
//
// Affix rolls are asserted BY VALUE with deepStrictEqual, never by count and
// never by key set: a `.length` check or a key comparison passes just as
// happily with every rolled number zeroed, which is most of what SOMET-484
// destroyed.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, loadInventory } = require('../src/authority/items.js');
const { sellItem, buyStock } = require('../src/authority/trade.js');
const { fetchShop, insertBuyback, seedBaseCatalog } = require('../src/services/merchantStock.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

async function openPool() {
  if (!DB_URL) return { unreachable: 'no TEST_DATABASE_URL / DATABASE_URL' };
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: `NO DATABASE at ${DB_URL} (${err.message})` };
  }
  return pool;
}

function uniq(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Every row is created by THIS test and torn down by THIS test. Nothing here
// touches a pre-existing user, character, world or item type.
async function fixture(pool, tag) {
  const u = await pool.query(
    `INSERT INTO users (username, password_hash, role, gold)
     VALUES ($1, 'x', 'player', 100000) RETURNING id`,
    [uniq(`s484-${tag}`)],
  );
  const userId = u.rows[0].id;
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.is_playable = true
      ORDER BY e.id LIMIT 1 RETURNING id`,
    [userId, uniq(`s484-char-${tag}`)],
  );
  const w = await pool.query(
    `INSERT INTO worlds (name, width, height, chunk_size, seed)
     VALUES ($1, 64, 64, 16, 1) RETURNING id`,
    [uniq(`s484-world-${tag}`)],
  );
  const worldId = w.rows[0].id;
  // trade.js scopes every stock row to (world_id, village_id) -- the SOMET-199
  // fix, and not something a test may route around.
  const v = await pool.query(
    `INSERT INTO villages (world_id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y)
     VALUES ($1, 1, 1, 8, 8, 'N', 100, 100) RETURNING id`,
    [worldId],
  );
  return { userId, characterId: c.rows[0].id, worldId, villageId: v.rows[0].id };
}

async function cleanup(pool, fx) {
  if (!fx) return;
  // merchant_stock FIRST: player_items.merchant_stock_id is ON DELETE CASCADE,
  // so this also removes any instance still sitting on the merchant's shelf.
  await pool.query('DELETE FROM merchant_stock WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM villages WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM world_items WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM player_items WHERE character_id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM worlds WHERE id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [fx.userId]).catch(() => {});
  if (fx.itemTypeId) {
    await pool.query('DELETE FROM item_types WHERE id = $1', [fx.itemTypeId]).catch(() => {});
  }
}

// A world entry shaped the way server.js builds one, with a stub map: nothing
// on the trade path reads terrain.
async function armEntry(pool, fx) {
  const itemTypes = await loadItemTypes(pool);
  const map = { chunkSize: 16, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  const world = new World(map, itemTypes, null, 16);
  const entry = { worldId: fx.worldId, world, claiming: new Set(), creatureTypeIds: new Map() };
  const inv = await loadInventory(pool, fx.characterId);
  world.addPlayer(String(fx.userId), { x: 100, y: 100 }, inv, { x: 100, y: 100 }, 0, undefined, fx.characterId);
  const p = world.getPlayer(String(fx.userId));
  p.gold = 100000;
  return { entry, itemTypes, p };
}

// A private item type, so no test here can be perturbed by (or perturb) the
// shared catalog, and so the catalog-deletion test has something it is allowed
// to delete.
async function ownType(pool, fx, tag) {
  const r = await pool.query(
    // Armor, not a weapon: item_types_weapon_fields_check demands a whole
    // kind/reach/arc or kind/range/speed/radius set that nothing here needs,
    // while armor only needs a slot and a defense. value > 0 is what makes it
    // sellable AND what puts it in seedBaseCatalog's reach.
    `INSERT INTO item_types (name, category, slot, damage, cooldown, defense, value)
     VALUES ($1, 'armor', 'chest', 0, 0, 3, 40) RETURNING id`,
    [uniq(`s484-type-${tag}`)],
  );
  fx.itemTypeId = r.rows[0].id;
  return r.rows[0].id;
}

// Three affixes with values chosen to be awkward on purpose: a two-decimal
// fraction that float4 cannot represent (this is what the migration's
// double-precision note is about), a half, and an integer. A carry path that
// rounds, truncates or zeroes shows up here and nowhere in a count check.
const ROLLS = [3.13, 11.5, 7];

async function affixedItem(pool, fx, itemTypeId, { rarity = 'yellow', itemLevel = 30 } = {}) {
  const it = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
     VALUES ($1, $2, 1, $3, $4) RETURNING id`,
    [fx.characterId, itemTypeId, rarity, itemLevel],
  );
  const itemId = it.rows[0].id;
  const at = await pool.query('SELECT id FROM affix_types ORDER BY id LIMIT 3');
  assert.strictEqual(at.rowCount, 3, 'the affix catalog must be seeded for this test to mean anything');
  const affixTypeIds = at.rows.map((r) => r.id);
  for (let i = 0; i < 3; i += 1) {
    await pool.query(
      'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,$2,$3,$4)',
      [itemId, i, affixTypeIds[i], ROLLS[i]],
    );
  }
  return { itemId, affixTypeIds };
}

// The affix rows AS ROWS: idx, type and value, in idx order. This is the
// comparison the whole ticket turns on -- same numbers, not merely the same
// affix keys.
async function affixRows(pool, itemId) {
  const r = await pool.query(
    `SELECT idx, affix_type_id, value FROM player_item_affixes
      WHERE player_item_id = $1 ORDER BY idx`,
    [itemId],
  );
  return r.rows.map((x) => ({ idx: Number(x.idx), affixTypeId: x.affix_type_id, value: Number(x.value) }));
}

function carry(p, itemId, typeId) {
  p.inv.items.push({ id: itemId, typeId, quantity: 1 });
}

test('SOMET-484: an affixed item survives sell-and-buy-back with identical rarity, item level and affix VALUES', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'roundtrip');
  const typeId = await ownType(pool, fx, 'roundtrip');
  const { itemId, affixTypeIds } = await affixedItem(pool, fx, typeId);
  const before = await affixRows(pool, itemId);
  assert.deepStrictEqual(before, [
    { idx: 0, affixTypeId: affixTypeIds[0], value: 3.13 },
    { idx: 1, affixTypeId: affixTypeIds[1], value: 11.5 },
    { idx: 2, affixTypeId: affixTypeIds[2], value: 7 },
  ], 'precondition: the item starts with three rolled affixes');

  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, itemId);
  assert.strictEqual(sold.ok, true, `an affixed item must be sellable (got: ${sold.reason})`);

  const stock = await pool.query(
    'SELECT id FROM merchant_stock WHERE seller_user_id = $1 AND item_type_id = $2',
    [fx.userId, typeId],
  );
  assert.strictEqual(stock.rowCount, 1, 'the sale must produce exactly one buyback row');

  const bought = await buyStock(pool, entry, String(fx.userId), fx.characterId, stock.rows[0].id, fx.villageId);
  assert.strictEqual(bought.ok, true, `the buyback must succeed (got: ${bought.reason})`);

  const back = await pool.query(
    'SELECT character_id, item_type_id, rarity, item_level, merchant_stock_id FROM player_items WHERE id = $1',
    [bought.item.id],
  );
  assert.strictEqual(back.rowCount, 1, 'the bought-back item must exist');
  assert.strictEqual(back.rows[0].character_id, fx.characterId, 'and be owned by the buying character');
  assert.strictEqual(back.rows[0].merchant_stock_id, null, 'and no longer be held by the merchant');
  assert.strictEqual(back.rows[0].item_type_id, typeId);
  assert.strictEqual(back.rows[0].rarity, 'yellow', 'rarity must survive the round trip');
  assert.strictEqual(Number(back.rows[0].item_level), 30, 'item level must survive the round trip');

  assert.deepStrictEqual(await affixRows(pool, bought.item.id), before,
    'every affix must come back with the SAME index, type and rolled VALUE');
});

// The by-construction half of the fix. If this holds, no carry path exists at
// all and no future column can be forgotten from one; if the buyback ever goes
// back to minting a fresh row, this fails even when the copy happens to be
// complete today.
test('SOMET-484: the buyback returns the SAME instance row, not a rebuilt copy', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'sameid');
  const typeId = await ownType(pool, fx, 'sameid');
  const { itemId } = await affixedItem(pool, fx, typeId);
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, itemId);
  assert.strictEqual(sold.ok, true, sold.reason);

  // While it is on the shelf: still one row, owned by nobody, held by the
  // merchant, with its affix rows untouched.
  const held = await pool.query(
    'SELECT character_id, merchant_stock_id FROM player_items WHERE id = $1', [itemId],
  );
  assert.strictEqual(held.rowCount, 1, 'the sale must NOT destroy the instance');
  assert.strictEqual(held.rows[0].character_id, null, 'the seller must no longer own it');
  assert.notStrictEqual(held.rows[0].merchant_stock_id, null, 'the merchant must hold it');
  assert.strictEqual((await affixRows(pool, itemId)).length, 3,
    'its affix rows must still be there while it sits on the shelf');
  // And it must be invisible to the seller's inventory while the merchant has it.
  const invWhileSold = await loadInventory(pool, fx.characterId);
  assert.strictEqual(invWhileSold.items.some((i) => i.id === itemId), false,
    'a sold item must not still load into the seller inventory');

  const stock = await pool.query(
    'SELECT id FROM merchant_stock WHERE seller_user_id = $1', [fx.userId],
  );
  const bought = await buyStock(pool, entry, String(fx.userId), fx.characterId, stock.rows[0].id, fx.villageId);
  assert.strictEqual(bought.ok, true, bought.reason);
  assert.strictEqual(bought.item.id, itemId, 'the buyer must get back the very instance they sold');
});

// The in-memory mirror is what equipRequirements#gearStatGrants reads on the
// equip path -- NOT the database. An item that is correct in Postgres and
// affix-less in p.inv.items is exactly the "live in the schema, inert in play"
// shape this epic keeps shipping.
test('SOMET-484: the bought-back item carries its rarity and affix values in the LIVE inventory, not just the DB', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'inmem');
  const typeId = await ownType(pool, fx, 'inmem');
  const { itemId, affixTypeIds } = await affixedItem(pool, fx, typeId, { rarity: 'foxy', itemLevel: 44 });
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, itemId);
  assert.strictEqual(sold.ok, true, sold.reason);
  const stock = await pool.query('SELECT id FROM merchant_stock WHERE seller_user_id = $1', [fx.userId]);
  const bought = await buyStock(pool, entry, String(fx.userId), fx.characterId, stock.rows[0].id, fx.villageId);
  assert.strictEqual(bought.ok, true, bought.reason);

  const live = p.inv.items.find((i) => i.id === bought.item.id);
  assert.ok(live, 'the bought-back item must be pushed into the live inventory');
  assert.strictEqual(live.rarity, 'foxy', 'the live copy must carry the rarity');
  assert.strictEqual(live.itemLevel, 44, 'the live copy must carry the item level');
  assert.deepStrictEqual(
    live.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    [
      { affixTypeId: affixTypeIds[0], value: 3.13 },
      { affixTypeId: affixTypeIds[1], value: 11.5 },
      { affixTypeId: affixTypeIds[2], value: 7 },
    ],
    'the live copy must carry every affix, in order, with its rolled VALUE',
  );
  // key/effect come from the affix_types join and are what the equip path
  // actually reads -- an id-only list would grant nothing.
  for (const a of live.affixes) {
    assert.ok(a.key, 'every live affix must carry its catalog key');
    assert.ok(a.effect && typeof a.effect === 'object', 'every live affix must carry its effect payload');
  }
  // And the same thing on a fresh join, so the two loaders agree.
  const reloaded = await loadInventory(pool, fx.characterId);
  const fromDb = reloaded.items.find((i) => i.id === bought.item.id);
  assert.ok(fromDb, 'the bought-back item must reload on the next join');
  assert.strictEqual(fromDb.rarity, 'foxy');
  assert.strictEqual(fromDb.itemLevel, 44);
  assert.deepStrictEqual(
    fromDb.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    live.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    'the live copy and the reloaded copy must be the same affixes with the same values',
  );
});

// AC2. Unrelated guard (SOMET-277), and the one most at risk from this change:
// the refusal used to be reached AFTER a DELETE and undone by ROLLBACK, and it
// is now reached after a locking SELECT. If it regressed, the starting-gear
// gold faucet reopens.
test('SOMET-484: a soulbound item still cannot be sold at all', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'bound');
  const typeId = await ownType(pool, fx, 'bound');
  const it = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound, rarity, item_level)
     VALUES ($1, $2, 1, true, 'blue', 12) RETURNING id`,
    [fx.characterId, typeId],
  );
  const itemId = it.rows[0].id;
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);
  const goldBefore = Number((await pool.query('SELECT gold FROM users WHERE id = $1', [fx.userId])).rows[0].gold);

  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, itemId);
  assert.strictEqual(sold.ok, false, 'a soulbound item must be refused');
  assert.strictEqual(sold.reason, 'starting gear cannot be sold');

  const still = await pool.query(
    'SELECT character_id, merchant_stock_id FROM player_items WHERE id = $1', [itemId],
  );
  assert.strictEqual(still.rowCount, 1, 'the refused item must still exist');
  assert.strictEqual(still.rows[0].character_id, fx.characterId, 'and still belong to its character');
  assert.strictEqual(still.rows[0].merchant_stock_id, null, 'and NOT have been handed to the merchant');
  const stock = await pool.query('SELECT count(*)::int AS n FROM merchant_stock WHERE seller_user_id = $1', [fx.userId]);
  assert.strictEqual(stock.rows[0].n, 0, 'a refused sale must create no buyback row');
  const goldAfter = Number((await pool.query('SELECT gold FROM users WHERE id = $1', [fx.userId])).rows[0].gold);
  assert.strictEqual(goldAfter, goldBefore, 'a refused sale must pay nothing');
});

// AC3. Deleting the catalog type CASCADEs the merchant_stock row away, and
// player_items.merchant_stock_id CASCADEs the held instance with it. Nothing
// half-built is left behind and the buy is a clean refusal, not a 500.
test('SOMET-484: buying back an item whose base type was deleted fails cleanly and leaves no instance', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'typegone');
  const typeId = await ownType(pool, fx, 'typegone');
  const { itemId } = await affixedItem(pool, fx, typeId);
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, itemId);
  assert.strictEqual(sold.ok, true, sold.reason);
  const stock = await pool.query('SELECT id FROM merchant_stock WHERE seller_user_id = $1', [fx.userId]);
  const stockId = stock.rows[0].id;

  await pool.query('DELETE FROM item_types WHERE id = $1', [typeId]);
  fx.itemTypeId = null;

  const gone = await pool.query('SELECT count(*)::int AS n FROM merchant_stock WHERE id = $1', [stockId]);
  assert.strictEqual(gone.rows[0].n, 0, 'the stock row must go with its item type');
  const inst = await pool.query('SELECT count(*)::int AS n FROM player_items WHERE id = $1', [itemId]);
  assert.strictEqual(inst.rows[0].n, 0, 'the held instance must not survive as an orphan');
  const aff = await pool.query(
    'SELECT count(*)::int AS n FROM player_item_affixes WHERE player_item_id = $1', [itemId],
  );
  assert.strictEqual(aff.rows[0].n, 0, 'and neither must its affix rows');

  const bought = await buyStock(pool, entry, String(fx.userId), fx.characterId, stockId, fx.villageId);
  assert.strictEqual(bought.ok, false, 'the buy must be refused, not throw and not half-succeed');
  assert.strictEqual(bought.reason, 'that item is no longer for sale');
  const made = await pool.query(
    'SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [fx.characterId],
  );
  assert.strictEqual(made.rows[0].n, 0, 'a refused buy must mint no instance');
});

// AC4. Rows that predate this migration hold no instance at all. They must
// still buy back, exactly as they always did -- a fresh white instance from
// the type.
test('SOMET-484: a legacy buyback row with no held instance still buys back unchanged', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'legacy');
  const typeId = await ownType(pool, fx, 'legacy');
  // Exactly the shape sellItem produced before this migration: a buyback row,
  // no player_items row anywhere behind it.
  const row = await insertBuyback(pool, fx.worldId, fx.villageId, typeId, 20, fx.userId, 3);
  const holder = await pool.query(
    'SELECT count(*)::int AS n FROM player_items WHERE merchant_stock_id = $1', [row.id],
  );
  assert.strictEqual(holder.rows[0].n, 0, 'precondition: this legacy row holds no instance');

  const { entry } = await armEntry(pool, fx);
  const bought = await buyStock(pool, entry, String(fx.userId), fx.characterId, row.id, fx.villageId);
  assert.strictEqual(bought.ok, true, `a legacy buyback row must still be purchasable (got: ${bought.reason})`);

  const back = await pool.query(
    'SELECT character_id, item_type_id, rarity, item_level FROM player_items WHERE id = $1',
    [bought.item.id],
  );
  assert.strictEqual(back.rows[0].character_id, fx.characterId);
  assert.strictEqual(back.rows[0].item_type_id, typeId);
  assert.strictEqual(back.rows[0].rarity, 'white', 'a legacy row still mints a plain white instance');
  assert.strictEqual(Number(back.rows[0].item_level), 1);
  assert.deepStrictEqual(bought.item.affixes, [], 'and it has no affixes');
  const consumed = await pool.query('SELECT count(*)::int AS n FROM merchant_stock WHERE id = $1', [row.id]);
  assert.strictEqual(consumed.rows[0].n, 0, 'and the buyback row is still consumed');
});

// The base catalog is infinite stock conjured from the item type and must
// never hold an instance -- this is the invariant the migration deliberately
// leaves to code rather than to a trigger, so it is pinned here.
test('SOMET-484: a base-catalog buy still mints a fresh white instance and leaves the row in stock', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'catalog');
  const typeId = await ownType(pool, fx, 'catalog');
  await seedBaseCatalog(pool, fx.worldId, fx.villageId);
  const cat = await pool.query(
    'SELECT id FROM merchant_stock WHERE village_id = $1 AND item_type_id = $2 AND seller_user_id IS NULL',
    [fx.villageId, typeId],
  );
  assert.strictEqual(cat.rowCount, 1, 'precondition: the private type is in the base catalog');
  const stockId = cat.rows[0].id;
  const held = await pool.query(
    'SELECT count(*)::int AS n FROM player_items WHERE merchant_stock_id = $1', [stockId],
  );
  assert.strictEqual(held.rows[0].n, 0, 'a base-catalog row must hold no instance');

  const { entry } = await armEntry(pool, fx);
  const bought = await buyStock(pool, entry, String(fx.userId), fx.characterId, stockId, fx.villageId);
  assert.strictEqual(bought.ok, true, bought.reason);
  const back = await pool.query('SELECT rarity, item_level FROM player_items WHERE id = $1', [bought.item.id]);
  assert.strictEqual(back.rows[0].rarity, 'white');
  assert.strictEqual(Number(back.rows[0].item_level), 1);
  const stillStocked = await pool.query('SELECT count(*)::int AS n FROM merchant_stock WHERE id = $1', [stockId]);
  assert.strictEqual(stillStocked.rows[0].n, 1, 'a base-catalog row is infinite and must NOT be consumed');
});

// The self-cleaning half of the design: the expiry sweep is one of four places
// that delete a merchant_stock row, and none of them knows an instance may be
// attached. The CASCADE is what makes that safe, so it is pinned.
test('SOMET-484: sweeping an expired buyback row destroys the instance it was holding', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'expire');
  const typeId = await ownType(pool, fx, 'expire');
  const { itemId } = await affixedItem(pool, fx, typeId);
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);
  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, itemId);
  assert.strictEqual(sold.ok, true, sold.reason);

  await pool.query(
    "UPDATE merchant_stock SET expires_at = now() - interval '1 hour' WHERE seller_user_id = $1",
    [fx.userId],
  );
  // The REAL sweep, not a hand-written DELETE: fetchShop is what runs it.
  await fetchShop(pool, fx.villageId, fx.userId);

  const inst = await pool.query('SELECT count(*)::int AS n FROM player_items WHERE id = $1', [itemId]);
  assert.strictEqual(inst.rows[0].n, 0, 'the expired shelf must not leave an ownerless instance behind');
});

// Stock rows outlive the character that sold them (fetchShop scopes buyback by
// USER, not character, precisely so a deleted character does not strand one).
// A held instance must survive that too -- it is not owned by the character
// any more, so characters' ON DELETE CASCADE must not reach it.
test('SOMET-484: a held instance outlives the character that sold it', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'orphan');
  const typeId = await ownType(pool, fx, 'orphan');
  const { itemId } = await affixedItem(pool, fx, typeId);
  const before = await affixRows(pool, itemId);
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);
  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, itemId);
  assert.strictEqual(sold.ok, true, sold.reason);

  await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]);

  const inst = await pool.query(
    'SELECT character_id, rarity, item_level FROM player_items WHERE id = $1', [itemId],
  );
  assert.strictEqual(inst.rowCount, 1, 'deleting the seller character must not take the shelved item');
  assert.strictEqual(inst.rows[0].rarity, 'yellow');
  assert.deepStrictEqual(await affixRows(pool, itemId), before, 'and its rolls must be intact');

  // A second character on the same account can still buy it back -- that is
  // exactly what fetchShop's account scoping promises.
  const c2 = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 2, $2, e.id FROM entity_types e WHERE e.is_playable = true
      ORDER BY e.id LIMIT 1 RETURNING id`,
    [fx.userId, uniq('s484-char2')],
  );
  fx.characterId = c2.rows[0].id;
  const stock = await pool.query('SELECT id FROM merchant_stock WHERE seller_user_id = $1', [fx.userId]);
  const { entry: e2 } = await armEntry(pool, fx);
  const bought = await buyStock(pool, e2, String(fx.userId), fx.characterId, stock.rows[0].id, fx.villageId);
  assert.strictEqual(bought.ok, true, `the account must still be able to reclaim it (got: ${bought.reason})`);
  assert.strictEqual(bought.item.id, itemId, 'and it is the same instance');
  assert.deepStrictEqual(await affixRows(pool, itemId), before, 'with the same rolls');
});

// The equipped guard used to be covered accidentally: the DELETE cascaded any
// player_equipment row away. An UPDATE cascades nothing, so this is the
// database-side backstop for a stale in-memory mirror.
test('SOMET-484: an equipped item is refused even when the in-memory mirror does not know it', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'equipped');
  const typeId = await ownType(pool, fx, 'equipped');
  const { itemId } = await affixedItem(pool, fx, typeId);
  await pool.query(
    'INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, $2, $3)',
    [fx.characterId, 'main_hand', itemId],
  );

  const { entry, p } = await armEntry(pool, fx);
  // Deliberately NOT reflected in p.inv.equipment: this test exists to prove
  // the DB check, so the in-memory guard must not be the thing that fires.
  p.inv.equipment = {};
  carry(p, itemId, typeId);

  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, itemId);
  assert.strictEqual(sold.ok, false, 'an equipped item must be refused');
  assert.strictEqual(sold.reason, 'unequip it first');
  const still = await pool.query(
    'SELECT character_id, merchant_stock_id FROM player_items WHERE id = $1', [itemId],
  );
  assert.strictEqual(still.rows[0].character_id, fx.characterId, 'it must still belong to its character');
  assert.strictEqual(still.rows[0].merchant_stock_id, null, 'and not be on a merchant shelf');
  const eq = await pool.query('SELECT count(*)::int AS n FROM player_equipment WHERE item_id = $1', [itemId]);
  assert.strictEqual(eq.rows[0].n, 1, 'and the paper-doll row must be untouched');
});

// stone_instances.socketed_into_id is ON DELETE SET NULL, so the old DELETE
// cleaned this up by itself. It does not any more: ejectSocketedStone is now
// the only thing parting a socketed stone from a sold weapon.
test('SOMET-484: selling a socketed weapon still ejects the stone, which stays with the seller', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'socket');
  const typeId = await ownType(pool, fx, 'socket');
  const { itemId } = await affixedItem(pool, fx, typeId);
  // Any item type will do for the stone's own instance row: what is under test
  // is socketed_into_id, not the stone catalog.
  const stoneTypeId = typeId;
  const stoneItem = await pool.query(
    'INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1,$2,1) RETURNING id',
    [fx.characterId, stoneTypeId],
  );
  await pool.query(
    'INSERT INTO stone_instances (player_item_id, socketed_into_id) VALUES ($1, $2)',
    [stoneItem.rows[0].id, itemId],
  );

  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);
  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, itemId);
  assert.strictEqual(sold.ok, true, `selling the HOST weapon must be allowed (got: ${sold.reason})`);

  const si = await pool.query(
    'SELECT socketed_into_id FROM stone_instances WHERE player_item_id = $1', [stoneItem.rows[0].id],
  );
  assert.strictEqual(si.rowCount, 1, 'the stone instance itself must survive the host sale');
  assert.strictEqual(si.rows[0].socketed_into_id, null,
    'the stone must be ejected, not left pointing at an item on a merchant shelf');
  const stoneOwner = await pool.query(
    'SELECT character_id FROM player_items WHERE id = $1', [stoneItem.rows[0].id],
  );
  assert.strictEqual(stoneOwner.rows[0].character_id, fx.characterId,
    'and the stone itself stays with the seller -- it was never sold');
});
