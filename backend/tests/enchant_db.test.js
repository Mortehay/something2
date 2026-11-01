// Weapon enchanting and paid skill levels against a REAL database.
//
// enchant_and_skill_levels.test.js proves the rules and the transaction logic with
// an in-memory stand-in. This file proves the SQL: that the migration's columns
// exist, that the scroll is sold, that enchantItem / upgradeSkill work through real
// Postgres (row locks, cascades, the gold guard), and that an enchanted weapon keeps
// its level across every table it can travel through -- the ground, a merchant's
// shelf -- because a column the carry paths forget is a weapon that silently loses
// its +14 the first time it is dropped.
//
// Every row is created by this test and removed by it.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, loadInventory, activeWeaponType } = require('../src/authority/items.js');
const { enchantItem, upgradeSkill, loadSkillLevels } = require('../src/authority/enchantOps.js');
const { dropItem, claimItem } = require('../src/authority/loot.js');
const { sellItem, buyStock } = require('../src/authority/trade.js');
const enchant = require('../src/services/enchant.js');
const leveling = require('../src/services/skillLeveling.js');

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

const uniq = (tag) => `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function fixture(pool, tag, { gold = 100000 } = {}) {
  const u = await pool.query(
    `INSERT INTO users (username, password_hash, role, gold) VALUES ($1, 'x', 'player', $2) RETURNING id`,
    [uniq(`ench-${tag}`), gold],
  );
  const userId = u.rows[0].id;
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.is_playable = true ORDER BY e.id LIMIT 1 RETURNING id`,
    [userId, uniq(`ench-char-${tag}`)],
  );
  const w = await pool.query(
    `INSERT INTO worlds (name, width, height, chunk_size, seed) VALUES ($1, 64, 64, 16, 1) RETURNING id`,
    [uniq(`ench-world-${tag}`)],
  );
  const worldId = w.rows[0].id;
  const v = await pool.query(
    `INSERT INTO villages (world_id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y)
     VALUES ($1, 1, 1, 8, 8, 'N', 100, 100) RETURNING id`,
    [worldId],
  );
  return { userId, characterId: c.rows[0].id, worldId, villageId: v.rows[0].id, typeIds: [] };
}

async function cleanup(pool, fx) {
  if (!fx) return;
  await pool.query('DELETE FROM merchant_stock WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM villages WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM world_items WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM player_items WHERE character_id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM character_skill_levels WHERE character_id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM worlds WHERE id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [fx.userId]).catch(() => {});
  for (const id of fx.typeIds) await pool.query('DELETE FROM item_types WHERE id = $1', [id]).catch(() => {});
}

// A private melee weapon type, so nothing here depends on or disturbs the catalog.
async function ownWeapon(pool, fx, tag) {
  const r = await pool.query(
    `INSERT INTO item_types (name, category, slot, kind, damage, cooldown, reach, arc_width, value)
     VALUES ($1, 'weapon', 'main_hand', 'melee', 10, 1, 90, 1.5, 50) RETURNING id`,
    [uniq(`ench-sword-${tag}`)],
  );
  fx.typeIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function scrollTypeId(pool) {
  const r = await pool.query(`SELECT id FROM item_types WHERE name = 'enchant_scroll'`);
  assert.strictEqual(r.rowCount, 1, 'the migration must have created the enchant_scroll item');
  return r.rows[0].id;
}

async function give(pool, fx, typeId, { quantity = 1, enchantLevel = 0 } = {}) {
  const r = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, enchant_level) VALUES ($1, $2, $3, $4) RETURNING id`,
    [fx.characterId, typeId, quantity, enchantLevel],
  );
  return r.rows[0].id;
}

async function armEntry(pool, fx, className = 'Warrior') {
  const itemTypes = await loadItemTypes(pool);
  const map = { chunkSize: 16, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  const world = new World(map, itemTypes, null, 16);
  const entry = { worldId: fx.worldId, world, claiming: new Set(), claimRetryAt: new Map(), creatureTypeIds: new Map() };
  const inv = await loadInventory(pool, fx.characterId);
  world.addPlayer(String(fx.userId), { x: 100, y: 100 }, inv, { x: 100, y: 100 }, 0, undefined, fx.characterId);
  const p = world.getPlayer(String(fx.userId));
  p.gold = 100000;
  p.className = className;
  p.skillLevels = await loadSkillLevels(pool, fx.characterId);
  return { entry, p, itemTypes };
}

const always = (v) => () => v;
const uid = (fx) => String(fx.userId);

test('the migration landed: columns, the scroll item, its price, and the skill table', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  // ONE after-hook, cleanup BEFORE the pool closes: two separate hooks run in registration
  // order, and closing the pool first makes the cleanup's queries fail silently.
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  for (const table of ['player_items', 'world_items']) {
    const c = await pool.query(
      `SELECT data_type, column_default, is_nullable FROM information_schema.columns
        WHERE table_name = $1 AND column_name = 'enchant_level'`, [table]);
    assert.strictEqual(c.rowCount, 1, `${table}.enchant_level`);
    assert.strictEqual(c.rows[0].is_nullable, 'NO');
    assert.match(String(c.rows[0].column_default), /0/);
  }
  const s = await pool.query(`SELECT category, stackable, value FROM item_types WHERE name = 'enchant_scroll'`);
  assert.deepStrictEqual(
    { category: s.rows[0].category, stackable: s.rows[0].stackable, value: Number(s.rows[0].value) },
    { category: 'consumable', stackable: true, value: enchant.ENCHANT_CONFIG.scrollPrice },
    'the scroll is a stackable consumable priced from the config default',
  );
  const t1 = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'character_skill_levels'`);
  assert.strictEqual(t1.rowCount, 1);

  // The column guards the cap in the database too, not only in code.
  fx = await fixture(pool, 'check');
  const wtype = await ownWeapon(pool, fx, 'check');
  await assert.rejects(() => give(pool, fx, wtype, { enchantLevel: 16 }), /enchant_level_check/);
  await assert.rejects(() => give(pool, fx, wtype, { enchantLevel: -1 }), /enchant_level_check/);
});

test('every village that exists sells the scroll at the configured price', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(() => pool.end().catch(() => {}));
  const missing = await pool.query(
    `SELECT v.id FROM villages v
      WHERE NOT EXISTS (SELECT 1 FROM merchant_stock ms JOIN item_types it ON it.id = ms.item_type_id
                         WHERE ms.village_id = v.id AND it.name = 'enchant_scroll' AND ms.seller_user_id IS NULL)`);
  assert.deepStrictEqual(missing.rows, [], 'a village without the scroll on its shelf');
});

test('a new village gets the scroll from seedBaseCatalog', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'seed');
  const { seedBaseCatalog } = require('../src/services/merchantStock.js');
  await seedBaseCatalog(pool, fx.worldId, fx.villageId);
  const r = await pool.query(
    `SELECT ms.price FROM merchant_stock ms JOIN item_types it ON it.id = ms.item_type_id
      WHERE ms.village_id = $1 AND it.name = 'enchant_scroll'`, [fx.villageId]);
  assert.strictEqual(r.rowCount, 1);
  assert.strictEqual(Number(r.rows[0].price), enchant.ENCHANT_CONFIG.scrollPrice);
});

test('enchanting through Postgres: a success keeps the weapon, spends one scroll of the stack', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'ok');
  const wtype = await ownWeapon(pool, fx, 'ok');
  const stype = await scrollTypeId(pool);
  const weaponId = await give(pool, fx, wtype);
  const scrollId = await give(pool, fx, stype, { quantity: 3 });
  const { entry, p } = await armEntry(pool, fx);

  const r = await enchantItem(pool, entry, uid(fx), fx.characterId, scrollId, weaponId, { rng: always(0) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.level, 1);
  const rows = await pool.query('SELECT id, quantity, enchant_level FROM player_items WHERE character_id = $1', [fx.characterId]);
  const byId = new Map(rows.rows.map((x) => [x.id, x]));
  assert.strictEqual(Number(byId.get(scrollId).quantity), 2);
  assert.strictEqual(byId.get(weaponId).enchant_level, 1);
  assert.strictEqual(p.inv.items.find((i) => i.id === weaponId).enchantLevel, 1);

  // It survives a reload, and the reloaded weapon hits harder.
  const inv = await loadInventory(pool, fx.characterId);
  assert.strictEqual(inv.items.find((i) => i.id === weaponId).enchantLevel, 1);
  inv.equipment.main_hand = weaponId;
  const w = activeWeaponType(inv, entry.world.weapons, entry.world.defaultWeaponId);
  assert.strictEqual(w.damage, 10 * enchant.damageMultiplier(1));
});

test('a burn deletes the weapon, its equipment row, and still spends the scroll', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'burn');
  const wtype = await ownWeapon(pool, fx, 'burn');
  const stype = await scrollTypeId(pool);
  const weaponId = await give(pool, fx, wtype, { enchantLevel: 7 });
  const scrollId = await give(pool, fx, stype, { quantity: 1 });
  await pool.query(`INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, 'main_hand', $2)`, [fx.characterId, weaponId]);
  const { entry, p } = await armEntry(pool, fx);
  assert.strictEqual(p.inv.equipment.main_hand, weaponId);

  const r = await enchantItem(pool, entry, uid(fx), fx.characterId, scrollId, weaponId, { rng: always(0.9999) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.outcome, 'destroyed');
  assert.strictEqual(r.wasEquipped, true);

  const left = await pool.query('SELECT id FROM player_items WHERE character_id = $1', [fx.characterId]);
  assert.deepStrictEqual(left.rows, [], 'both the weapon and the last scroll are gone');
  const eq = await pool.query('SELECT 1 FROM player_equipment WHERE character_id = $1', [fx.characterId]);
  assert.strictEqual(eq.rowCount, 0, 'no dangling equipment row');
  assert.strictEqual(p.inv.equipment.main_hand, undefined);
  assert.strictEqual(p.inv.items.length, 0);
});

test('a +15 weapon refuses the scroll and nothing changes in the database', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'cap');
  const wtype = await ownWeapon(pool, fx, 'cap');
  const stype = await scrollTypeId(pool);
  const weaponId = await give(pool, fx, wtype, { enchantLevel: 15 });
  const scrollId = await give(pool, fx, stype, { quantity: 2 });
  const { entry } = await armEntry(pool, fx);
  const r = await enchantItem(pool, entry, uid(fx), fx.characterId, scrollId, weaponId, { rng: always(0) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /already \+15/);
  const q = await pool.query('SELECT quantity FROM player_items WHERE id = $1', [scrollId]);
  assert.strictEqual(Number(q.rows[0].quantity), 2);
});

test('another character\'s scroll or weapon cannot be used', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let a = null; let b = null;
  t.after(async () => { await cleanup(pool, a); await cleanup(pool, b); await pool.end().catch(() => {}); });
  a = await fixture(pool, 'a');
  b = await fixture(pool, 'b');
  const wtype = await ownWeapon(pool, a, 'xchar');
  const stype = await scrollTypeId(pool);
  const myWeapon = await give(pool, a, wtype);
  const theirScroll = await give(pool, b, stype, { quantity: 1 });
  const { entry } = await armEntry(pool, a);
  // The cache would refuse this first, so seed it to prove the DATABASE refuses too.
  entry.world.getPlayer(uid(a)).inv.items.push({ id: theirScroll, typeId: stype, quantity: 1, enchantLevel: 0 });
  const r = await enchantItem(pool, entry, uid(a), a.characterId, theirScroll, myWeapon, { rng: always(0) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /do not own that scroll/);
  const q = await pool.query('SELECT quantity FROM player_items WHERE id = $1', [theirScroll]);
  assert.strictEqual(Number(q.rows[0].quantity), 1, 'the other character\'s scroll is untouched');
});

test('an enchanted weapon keeps its level through drop and pick-up', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'drop');
  const wtype = await ownWeapon(pool, fx, 'drop');
  const weaponId = await give(pool, fx, wtype, { enchantLevel: 11 });
  const { entry, p } = await armEntry(pool, fx);
  entry.world.groundItems = entry.world.groundItems || { add() {}, remove() {} };

  const dropped = await dropItem(pool, entry, uid(fx), fx.characterId, weaponId, { ttlMs: 60000 });
  assert.strictEqual(dropped.ok, true);
  const ground = await pool.query('SELECT id, enchant_level FROM world_items WHERE world_id = $1', [fx.worldId]);
  assert.strictEqual(ground.rowCount, 1);
  assert.strictEqual(ground.rows[0].enchant_level, 11, 'the ground row carries the level');

  const claimed = await claimItem(pool, entry, uid(fx), fx.characterId, ground.rows[0].id);
  assert.ok(claimed, 'the pickup succeeded');
  const back = await pool.query('SELECT enchant_level FROM player_items WHERE id = $1', [claimed.id]);
  assert.strictEqual(back.rows[0].enchant_level, 11, 'and the reclaimed instance still has it');
  assert.strictEqual(p.inv.items.find((i) => i.id === claimed.id).enchantLevel, 11, 'including in memory');
});

test('an enchanted weapon keeps its level through sell and buy-back', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'sell');
  const wtype = await ownWeapon(pool, fx, 'sell');
  const weaponId = await give(pool, fx, wtype, { enchantLevel: 6 });
  const { entry, p } = await armEntry(pool, fx);

  const sold = await sellItem(pool, entry, uid(fx), fx.characterId, fx.villageId, weaponId);
  assert.strictEqual(sold.ok, true, sold.reason);
  const held = await pool.query('SELECT enchant_level FROM player_items WHERE id = $1', [weaponId]);
  assert.strictEqual(held.rows[0].enchant_level, 6, 'the merchant holds the same enchanted instance');

  const stock = await pool.query(
    'SELECT id FROM merchant_stock WHERE village_id = $1 AND seller_user_id IS NOT NULL', [fx.villageId]);
  assert.strictEqual(stock.rowCount, 1);
  const bought = await buyStock(pool, entry, uid(fx), fx.characterId, stock.rows[0].id, fx.villageId);
  assert.strictEqual(bought.ok, true, bought.reason);
  assert.strictEqual(bought.item.enchantLevel, 6, 'the bought-back item reports its level');
  assert.strictEqual(p.inv.items.find((i) => i.id === bought.item.id).enchantLevel, 6);
});

test('buying the scroll from a shelf gives an unenchanted scroll for the listed price', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'shop', { gold: 1000 });
  const { seedBaseCatalog } = require('../src/services/merchantStock.js');
  await seedBaseCatalog(pool, fx.worldId, fx.villageId);
  const stype = await scrollTypeId(pool);
  const shelf = await pool.query(
    'SELECT id, price FROM merchant_stock WHERE village_id = $1 AND item_type_id = $2', [fx.villageId, stype]);
  assert.strictEqual(shelf.rowCount, 1);
  const { entry, p } = await armEntry(pool, fx);
  p.gold = 1000;
  const bought = await buyStock(pool, entry, uid(fx), fx.characterId, shelf.rows[0].id, fx.villageId);
  assert.strictEqual(bought.ok, true, bought.reason);
  assert.strictEqual(bought.gold, 1000 - Number(shelf.rows[0].price));
  assert.strictEqual(bought.item.typeId, stype);
  assert.strictEqual(bought.item.enchantLevel, 0);
});

test('skill upgrades through Postgres: exact price, persisted level, wallet, cap', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  const total = leveling.costTable().reduce((a, b) => a + b, 0);
  fx = await fixture(pool, 'skill', { gold: total + 5 });
  const { entry, p } = await armEntry(pool, fx, 'Warrior');
  p.gold = total + 5;

  let spent = 0;
  for (let n = 1; n <= 15; n += 1) {
    const r = await upgradeSkill(pool, entry, uid(fx), fx.characterId, 'war_crushing_blow');
    assert.strictEqual(r.ok, true, `level ${n}: ${r.reason}`);
    assert.strictEqual(r.level, n);
    assert.strictEqual(r.cost, leveling.costForLevel(n));
    spent += r.cost;
  }
  assert.strictEqual(spent, total);
  const gold = Number((await pool.query('SELECT gold FROM users WHERE id = $1', [fx.userId])).rows[0].gold);
  assert.strictEqual(gold, 5, 'exactly the table was paid');
  assert.strictEqual(p.gold, 5);

  // Persisted: a fresh load (a new session) sees level 15.
  const levels = await loadSkillLevels(pool, fx.characterId);
  assert.strictEqual(levels.get('war_crushing_blow'), 15);

  const over = await upgradeSkill(pool, entry, uid(fx), fx.characterId, 'war_crushing_blow');
  assert.strictEqual(over.ok, false);
  assert.match(over.reason, /already level 15/);
  const after = Number((await pool.query('SELECT gold FROM users WHERE id = $1', [fx.userId])).rows[0].gold);
  assert.strictEqual(after, 5, 'the refused purchase cost nothing');
});

test('a skill upgrade with too little gold changes neither the wallet nor the level', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'poor', { gold: leveling.costForLevel(1) - 1 });
  const { entry, p } = await armEntry(pool, fx, 'Warrior');
  p.gold = leveling.costForLevel(1) + 10_000; // a stale, richer cache must not matter
  const r = await upgradeSkill(pool, entry, uid(fx), fx.characterId, 'war_crushing_blow');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not enough gold');
  const g = Number((await pool.query('SELECT gold FROM users WHERE id = $1', [fx.userId])).rows[0].gold);
  assert.strictEqual(g, leveling.costForLevel(1) - 1);
  const lv = await pool.query('SELECT 1 FROM character_skill_levels WHERE character_id = $1', [fx.characterId]);
  assert.strictEqual(lv.rowCount, 0);
});

test('levels are per character and the table cascades away with the character', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'cascade');
  await pool.query(`INSERT INTO character_skill_levels (character_id, skill_id, level) VALUES ($1, 'war_crushing_blow', 4)`, [fx.characterId]);
  await assert.rejects(
    () => pool.query(`INSERT INTO character_skill_levels (character_id, skill_id, level) VALUES ($1, 'x', 16)`, [fx.characterId]),
    /level_check/);
  await assert.rejects(
    () => pool.query(`INSERT INTO character_skill_levels (character_id, skill_id, level) VALUES ($1, 'war_crushing_blow', 5)`, [fx.characterId]),
    /duplicate key|pkey/);
  await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]);
  const gone = await pool.query('SELECT 1 FROM character_skill_levels WHERE character_id = $1', [fx.characterId]);
  assert.strictEqual(gone.rowCount, 0);
});
