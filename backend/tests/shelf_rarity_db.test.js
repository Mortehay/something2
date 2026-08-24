// SOMET-500 (merchant buyback shelf) + SOMET-502 (account chest listing).
//
// The two tickets are one defect in two places: SOMET-484 and SOMET-498 made
// the merchant and the chest HOLD the sold/stored instance, so its rarity and
// its rolled affixes were one join away from both listings -- and neither
// listing read them, so a yellow helm was shelved looking exactly like a white
// one and a foxy sword sat in the bank drawn as plain.
//
// Everything below runs through the REAL entry points (sellItem, fetchShop,
// buyStock, depositItem, fetchChest, withdrawItem) against a real database with
// real rows. That is deliberate and not negotiable: this epic has repeatedly
// shipped features that were live in the schema and inert in play with a fully
// green suite, because what was tested was a pure helper round-tripping a JS
// object rather than the path a player walks.
//
// Affixes are compared BY VALUE with deepStrictEqual, never by count and never
// by key set -- a length check passes just as happily with every rolled number
// zeroed. 3.13 is not representable in float4, so a carry path that lost
// precision shows here and nowhere in a count check. assert.equal is avoided
// throughout: `12 == '12'` has passed a real test in this repo.
//
// The LEGACY assertions use deepStrictEqual against the complete pre-change
// object, not `assert.ok(!('rarity' in row))`. An absent key and a key holding
// undefined are different wire shapes, and the whole point of the legacy rule
// is that an instance-less row is byte-identical to what it was.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, loadInventory } = require('../src/authority/items.js');
const { sellItem, buyStock } = require('../src/authority/trade.js');
const { fetchShop, seedBaseCatalog } = require('../src/services/merchantStock.js');
const { depositItem, withdrawItem, fetchChest } = require('../src/services/accountChest.js');

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
// touches a pre-existing user, character, world, village or item type.
async function fixture(pool, tag) {
  const u = await pool.query(
    `INSERT INTO users (username, password_hash, role, gold)
     VALUES ($1, 'x', 'player', 100000) RETURNING id`,
    [uniq(`s500-${tag}`)],
  );
  const userId = u.rows[0].id;
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.is_playable = true
      ORDER BY e.id LIMIT 1 RETURNING id`,
    [userId, uniq(`s500-char-${tag}`)],
  );
  const w = await pool.query(
    `INSERT INTO worlds (name, width, height, chunk_size, seed)
     VALUES ($1, 64, 64, 16, 1) RETURNING id`,
    [uniq(`s500-world-${tag}`)],
  );
  const worldId = w.rows[0].id;
  const v = await pool.query(
    `INSERT INTO villages (world_id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y)
     VALUES ($1, 1, 1, 8, 8, 'N', 100, 100) RETURNING id`,
    [worldId],
  );
  return { userId, characterId: c.rows[0].id, worldId, villageId: v.rows[0].id };
}

async function cleanup(pool, fx) {
  if (!fx) return;
  // Containers FIRST: player_items.merchant_stock_id and .account_item_id are
  // both ON DELETE CASCADE, so this also removes any instance still on a shelf
  // or in the chest.
  await pool.query('DELETE FROM merchant_stock WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM account_items WHERE user_id = $1', [fx.userId]).catch(() => {});
  await pool.query('DELETE FROM villages WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM player_items WHERE character_id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM worlds WHERE id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [fx.userId]).catch(() => {});
  if (fx.itemTypeId) {
    await pool.query('DELETE FROM item_types WHERE id = $1', [fx.itemTypeId]).catch(() => {});
  }
}

// A world entry shaped the way server.js builds one, with a stub map: nothing
// on the trade or chest path reads terrain.
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

// A private item type. Armor rather than a weapon: item_types_weapon_fields_
// check demands a whole kind/reach/arc set nothing here needs, while armor only
// needs a slot and a defense. value > 0 is what makes it sellable AND what puts
// it in seedBaseCatalog's reach.
async function ownType(pool, fx, tag) {
  const r = await pool.query(
    `INSERT INTO item_types (name, category, slot, damage, cooldown, defense, value)
     VALUES ($1, 'armor', 'chest', 0, 0, 3, 40) RETURNING id`,
    [uniq(`s500-type-${tag}`)],
  );
  fx.itemTypeId = r.rows[0].id;
  return r.rows[0].id;
}

// Values chosen to be awkward on purpose: a two-decimal fraction float4 cannot
// hold, and a half. A carry path that rounds, truncates or zeroes shows up here.
const ROLLS = [3.13, 11.5];

// One rolled instance plus the CATALOG rows its affixes point at. The catalog
// rows are returned so the expectation below can be built from what the
// database actually holds -- the listing's job is to reproduce the affix
// catalog's key/label/effect, so hard-coding them here would assert the fixture
// against itself.
async function affixedItem(pool, fx, itemTypeId, { rarity = 'foxy', itemLevel = 88 } = {}) {
  const it = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
     VALUES ($1, $2, 1, $3, $4) RETURNING id`,
    [fx.characterId, itemTypeId, rarity, itemLevel],
  );
  const itemId = it.rows[0].id;
  const at = await pool.query('SELECT id, key, label, effect FROM affix_types ORDER BY id LIMIT 2');
  assert.strictEqual(at.rowCount, 2, 'the affix catalog must be seeded for this test to mean anything');
  for (let i = 0; i < 2; i += 1) {
    await pool.query(
      'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,$2,$3,$4)',
      [itemId, i, at.rows[i].id, ROLLS[i]],
    );
  }
  // Exactly the shape items.js#loadInventory emits, in idx order.
  const expectedAffixes = at.rows.map((a, i) => ({
    affixTypeId: a.id, key: a.key, label: a.label, value: ROLLS[i], effect: a.effect,
  }));
  return { itemId, expectedAffixes };
}

function carry(p, itemId, typeId) {
  p.inv.items.push({ id: itemId, typeId, quantity: 1 });
}

// ---------------------------------------------------------------- SOMET-500

test('SOMET-500: fetchShop lists a buyback row with the held instance\'s rarity, item level and affix VALUES', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'shelf');
  const typeId = await ownType(pool, fx, 'shelf');
  const { itemId, expectedAffixes } = await affixedItem(pool, fx, typeId, { rarity: 'yellow', itemLevel: 30 });
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, itemId);
  assert.strictEqual(sold.ok, true, `an affixed item must be sellable (got: ${sold.reason})`);

  // BEFORE any purchase -- this is the whole acceptance criterion. The shelf is
  // read exactly as server.js's `interact` handler reads it.
  const shop = await fetchShop(pool, fx.villageId, fx.userId);
  assert.strictEqual(shop.buyback.length, 1, 'the sale must produce exactly one buyback row');
  const listed = shop.buyback[0];
  assert.strictEqual(listed.itemTypeId, typeId);
  assert.strictEqual(listed.rarity, 'yellow', 'the shelf must say what grade it is holding');
  assert.strictEqual(listed.itemLevel, 30);
  assert.deepStrictEqual(listed.affixes, expectedAffixes,
    'every rolled affix must reach the shelf with its label, effect and VALUE');
});

test('SOMET-500: what the shelf shows is what buying returns, for the SAME instance', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'nodrift');
  const typeId = await ownType(pool, fx, 'nodrift');
  const { itemId } = await affixedItem(pool, fx, typeId, { rarity: 'foxy', itemLevel: 66 });
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, itemId);
  assert.strictEqual(sold.ok, true, sold.reason);

  const listed = (await fetchShop(pool, fx.villageId, fx.userId)).buyback[0];
  const bought = await buyStock(pool, entry, String(fx.userId), fx.characterId, listed.id, fx.villageId);
  assert.strictEqual(bought.ok, true, `the buyback must succeed (got: ${bought.reason})`);

  // The instance is the anchor: display and item cannot be compared through two
  // fixtures that merely agree.
  assert.strictEqual(bought.item.id, itemId, 'the buyer must get back the very instance that was listed');
  assert.strictEqual(listed.rarity, bought.item.rarity);
  assert.strictEqual(listed.itemLevel, bought.item.itemLevel);
  assert.deepStrictEqual(listed.affixes, bought.item.affixes,
    'the shelf and the purchase must describe the same affixes, down to the label');

  // And the same object again after a reconnect, which is the copy the
  // inventory grid colours.
  const reloaded = (await loadInventory(pool, fx.characterId)).items.find((i) => i.id === itemId);
  assert.ok(reloaded, 'the bought-back instance must load into the inventory');
  assert.strictEqual(listed.rarity, reloaded.rarity);
  assert.deepStrictEqual(listed.affixes, reloaded.affixes);
});

test('SOMET-500: the generated base catalogue holds no instance and is listed exactly as before', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'catalog');
  const typeId = await ownType(pool, fx, 'catalog');
  await seedBaseCatalog(pool, fx.worldId, fx.villageId);

  const shop = await fetchShop(pool, fx.villageId, fx.userId);
  assert.ok(shop.catalog.length > 0, 'the seeder must have stocked this village');

  // EVERY catalog row, not just ours: the join must not invent an instance for
  // any of them.
  for (const row of shop.catalog) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'rarity'), false,
      `catalog row ${row.id} must carry no grade -- nobody knows what it is until it is minted`);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'affixes'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'itemLevel'), false);
  }

  const mine = shop.catalog.find((r) => r.itemTypeId === typeId);
  assert.ok(mine, 'the private item type must be stocked');
  assert.deepStrictEqual(mine, {
    id: mine.id, itemTypeId: typeId, price: 40, quantity: 1, sellerUserId: null,
  }, 'a base-catalogue row is the pre-500 five-key shape and nothing more');
});

// ---------------------------------------------------------------- SOMET-502

test('SOMET-502: fetchChest lists a stored row with the held instance\'s rarity, item level and affix VALUES', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'chest');
  const typeId = await ownType(pool, fx, 'chest');
  const { itemId, expectedAffixes } = await affixedItem(pool, fx, typeId);
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const stored = await depositItem(pool, entry, String(fx.userId), fx.characterId, itemId);
  assert.strictEqual(stored.ok, true, `an affixed item must be storable (got: ${stored.reason})`);

  const chest = await fetchChest(pool, fx.userId);
  assert.strictEqual(chest.items.length, 1);
  const listed = chest.items[0];
  assert.strictEqual(listed.typeId, typeId);
  assert.strictEqual(listed.rarity, 'foxy', 'the bank panel must be able to colour a stored item');
  assert.strictEqual(listed.itemLevel, 88);
  assert.deepStrictEqual(listed.affixes, expectedAffixes);
});

test('SOMET-502: what the chest shows is what withdrawing returns, for the SAME instance', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'chestnodrift');
  const typeId = await ownType(pool, fx, 'chestnodrift');
  const { itemId } = await affixedItem(pool, fx, typeId, { rarity: 'blue', itemLevel: 12 });
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  assert.strictEqual((await depositItem(pool, entry, String(fx.userId), fx.characterId, itemId)).ok, true);

  const listed = (await fetchChest(pool, fx.userId)).items[0];
  const out = await withdrawItem(pool, entry, String(fx.userId), fx.characterId, listed.id);
  assert.strictEqual(out.ok, true, `the withdrawal must succeed (got: ${out.reason})`);

  assert.strictEqual(out.item.id, itemId, 'the withdrawal must return the very instance that was listed');
  assert.strictEqual(listed.rarity, out.item.rarity);
  assert.strictEqual(listed.itemLevel, out.item.itemLevel);
  assert.deepStrictEqual(listed.affixes, out.item.affixes,
    'the chest panel and the inventory grid must describe one item one way');

  const reloaded = (await loadInventory(pool, fx.characterId)).items.find((i) => i.id === itemId);
  assert.ok(reloaded, 'the withdrawn instance must load into the inventory');
  assert.strictEqual(listed.rarity, reloaded.rarity);
  assert.deepStrictEqual(listed.affixes, reloaded.affixes);
});

test('SOMET-502: a chest row holding no instance is listed exactly as it was before', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'legacychest');
  const typeId = await ownType(pool, fx, 'legacychest');
  // A pre-SOMET-498 chest row: the container's own three columns and no held
  // instance at all. The 1714440513000 backfill gave every row that existed at
  // migration time an instance, so this shape can only arise from a CASCADE
  // having taken one -- it must still list, and list unchanged.
  const ai = await pool.query(
    `INSERT INTO account_items (user_id, slot, item_type_id, quantity, soulbound)
     VALUES ($1, 1, $2, 4, true) RETURNING id`,
    [fx.userId, typeId],
  );

  const chest = await fetchChest(pool, fx.userId);
  assert.strictEqual(chest.items.length, 1);
  assert.deepStrictEqual(chest.items[0], {
    id: ai.rows[0].id, slot: 1, typeId, quantity: 4, soulbound: true,
  }, 'an instance-less chest row is the pre-502 five-key shape and nothing more');
});
