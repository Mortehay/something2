// backend/tests/claim_stone_db.test.js
// A magic stone picked up off the ground must be usable: claimItem writes its stone_instances row in
// the same statement as the pickup (socketStone, the inventory hydration and the drop guard all
// join to it), and the whole socket / unsocket round trip then works on it. Before this, only the
// starting loadout and a one-off migration wrote that row, so a looted stone was "stone not found".
// Real rows, real claimItem, real socketStone; every row is created and removed by this test.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, loadInventory, socketStone, unsocketStone } = require('../src/authority/items.js');
const { claimItem } = require('../src/authority/loot.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const skip = DB_URL ? false : 'no DATABASE_URL';
const uniq = (t) => `${t}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function withFixture(fn) {
  const pool = new Pool({ connectionString: DB_URL, max: 4 });
  let fx = null;
  try {
    const u = await pool.query("INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id", [uniq('stn')]);
    const c = await pool.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id)
       SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.is_playable = true ORDER BY e.id LIMIT 1 RETURNING id`,
      [u.rows[0].id, uniq('stnc')],
    );
    const w = await pool.query('INSERT INTO worlds (name, width, height, chunk_size, seed) VALUES ($1, 64, 64, 16, 1) RETURNING id', [uniq('stnw')]);
    fx = { userId: u.rows[0].id, characterId: c.rows[0].id, worldId: w.rows[0].id };
    const itemTypes = await loadItemTypes(pool);
    const map = { chunkSize: 16, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
    const world = new World(map, itemTypes, null, 16);
    const entry = { worldId: fx.worldId, world, claiming: new Set(), creatureTypeIds: new Map() };
    const inv = await loadInventory(pool, fx.characterId);
    world.addPlayer(String(fx.userId), { x: 100, y: 100 }, inv, { x: 100, y: 100 }, 0, undefined, fx.characterId);
    await fn({ pool, fx, entry, itemTypes });
  } finally {
    if (fx) {
      await pool.query('DELETE FROM world_items WHERE world_id = $1', [fx.worldId]).catch(() => {});
      await pool.query('DELETE FROM player_items WHERE character_id = $1', [fx.characterId]).catch(() => {});
      await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]).catch(() => {});
      await pool.query('DELETE FROM worlds WHERE id = $1', [fx.worldId]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = $1', [fx.userId]).catch(() => {});
    }
    await pool.end();
  }
}

async function onTheGround(pool, fx, entry, typeId) {
  const r = await pool.query(
    `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity, rarity, item_level, affixes)
     VALUES ($1, $2, 100, 100, now() + interval '10 minutes', 1, 'white', 1, '[]'::jsonb)
     RETURNING id, item_type_id, x, y, expires_at, quantity, rarity, item_level`,
    [fx.worldId, typeId],
  );
  entry.world.groundItems.add(r.rows);
  return r.rows[0].id;
}

async function typeId(pool, sql) {
  const r = await pool.query(sql);
  assert.ok(r.rows[0], `fixture: ${sql}`);
  return r.rows[0].id;
}

test('a stone picked up off the ground gets its stone_instances row', { skip }, () => withFixture(async ({ pool, fx, entry }) => {
  const stoneType = await typeId(pool, "SELECT id FROM item_types WHERE category = 'stone' AND element IS NOT NULL ORDER BY id LIMIT 1");
  const groundId = await onTheGround(pool, fx, entry, stoneType);
  const got = await claimItem(pool, entry, String(fx.userId), fx.characterId, groundId);
  assert.ok(got && got.id, 'claimed');
  const q = await pool.query('SELECT socketed_into_id FROM stone_instances WHERE player_item_id = $1', [got.id]);
  assert.strictEqual(q.rowCount, 1, 'one instance row');
  assert.strictEqual(q.rows[0].socketed_into_id, null, 'loose, not socketed');
}));

test('a weapon or a potion picked up gets none (only stones do)', { skip }, () => withFixture(async ({ pool, fx, entry }) => {
  const weaponType = await typeId(pool, "SELECT id FROM item_types WHERE name = 'crude-blade'");
  const groundId = await onTheGround(pool, fx, entry, weaponType);
  const got = await claimItem(pool, entry, String(fx.userId), fx.characterId, groundId);
  const q = await pool.query('SELECT 1 FROM stone_instances WHERE player_item_id = $1', [got.id]);
  assert.strictEqual(q.rowCount, 0);
}));

test('the looted stone can be socketed into a weapon and taken out again', { skip }, () => withFixture(async ({ pool, fx, entry, itemTypes }) => {
  const stoneType = await typeId(pool, "SELECT id FROM item_types WHERE category = 'stone' AND element IS NOT NULL ORDER BY id LIMIT 1");
  const weaponType = await typeId(pool, "SELECT id FROM item_types WHERE name = 'crude-blade'");
  const stone = await claimItem(pool, entry, String(fx.userId), fx.characterId, await onTheGround(pool, fx, entry, stoneType));
  const host = await claimItem(pool, entry, String(fx.userId), fx.characterId, await onTheGround(pool, fx, entry, weaponType));
  const inv = entry.world.getPlayer(String(fx.userId)).inv;

  const s = await socketStone(pool, fx.characterId, inv, stone.id, host.id, itemTypes);
  assert.deepStrictEqual(s, { ok: true });
  assert.strictEqual(inv.items.find((i) => i.id === host.id).socketedStoneItemId, stone.id);

  const again = await socketStone(pool, fx.characterId, inv, stone.id, host.id, itemTypes);
  assert.strictEqual(again.ok, false, 'already socketed');

  const out = await unsocketStone(pool, fx.characterId, inv, stone.id, { confirm: true, rng: () => 0.99 });
  assert.deepStrictEqual(out, { ok: true, destroyed: false });
  assert.strictEqual(inv.items.find((i) => i.id === host.id).socketedStoneItemId, undefined);
}));
