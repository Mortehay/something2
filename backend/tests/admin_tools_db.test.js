// backend/tests/admin_tools_db.test.js
// The admin menu's grants against a real database: gold lands in the wallet, a level is set exactly
// (with the passive points a real level-up pays), xp goes through the real award path, an item is a
// real world_items row. Every row is created and removed by this test.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const tools = require('../src/authority/adminTools.js');
const { xpFloor } = require('../src/services/playerStats.js');
const { loadProgression } = require('../src/services/progressionStore.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const uniq = (t) => `${t}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function withFixture(fn) {
  if (!DB_URL) return;
  const pool = new Pool({ connectionString: DB_URL, max: 4 });
  let fx = null;
  try {
    const u = await pool.query("INSERT INTO users (username, password_hash, role, gold) VALUES ($1, 'x', 'admin', 100) RETURNING id", [uniq('adm')]);
    const c = await pool.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id)
       SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.is_playable = true ORDER BY e.id LIMIT 1 RETURNING id`,
      [u.rows[0].id, uniq('admc')],
    );
    const w = await pool.query('INSERT INTO worlds (name, width, height, chunk_size, seed) VALUES ($1, 64, 64, 16, 1) RETURNING id', [uniq('admw')]);
    fx = { userId: u.rows[0].id, characterId: c.rows[0].id, worldId: w.rows[0].id };
    await fn(pool, fx);
  } finally {
    if (fx) {
      await pool.query('DELETE FROM world_items WHERE world_id = $1', [fx.worldId]).catch(() => {});
      await pool.query('DELETE FROM player_progression WHERE character_id = $1', [fx.characterId]).catch(() => {});
      await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]).catch(() => {});
      await pool.query('DELETE FROM worlds WHERE id = $1', [fx.worldId]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = $1', [fx.userId]).catch(() => {});
    }
    await pool.end();
  }
}
const skip = DB_URL ? false : 'no DATABASE_URL';

test('gold is added to the account wallet', { skip }, () => withFixture(async (pool, fx) => {
  const r = await tools.giveGold(pool, fx.characterId, 1_000_000);
  assert.equal(r.ok, true);
  assert.equal(r.gold, 1_000_100);
  const q = await pool.query('SELECT gold FROM users WHERE id = $1', [fx.userId]);
  assert.equal(Number(q.rows[0].gold), 1_000_100);
}));

test('setLevel sets level and experience exactly and pays passive points for levels gained', { skip }, () => withFixture(async (pool, fx) => {
  const before = await loadProgression(pool, fx.characterId);
  const r = await tools.setLevel(pool, fx.characterId, 50);
  assert.equal(r.ok, true);
  assert.equal(r.level, 50);
  const after = await loadProgression(pool, fx.characterId);
  assert.equal(after.level, 50);
  assert.equal(after.experience, xpFloor(50));
  assert.equal(after.passive_points, before.passive_points + r.pointsGained, 'points follow levels gained');
  assert.ok(r.pointsGained >= 0);
  // going down takes no points away
  const down = await tools.setLevel(pool, fx.characterId, 5);
  assert.equal(down.level, 5);
  assert.equal(down.pointsGained, 0);
  const lowered = await loadProgression(pool, fx.characterId);
  assert.equal(lowered.passive_points, after.passive_points);
}));

test('setLevel above the top of the curve clamps and says so', { skip }, () => withFixture(async (pool, fx) => {
  const r = await tools.setLevel(pool, fx.characterId, 9999);
  assert.equal(r.ok, true);
  assert.equal(r.capped, true);
  assert.ok(r.level < 9999);
}));

test('xp goes through the real award path and can level up', { skip }, () => withFixture(async (pool, fx) => {
  const r = await tools.giveXp(pool, fx.characterId, 1_000_000);
  assert.equal(r.ok, true);
  assert.equal(r.leveledUp, true);
  assert.ok(r.level > 1);
  assert.equal((await loadProgression(pool, fx.characterId)).level, r.level);
}));

test('passive points add up', { skip }, () => withFixture(async (pool, fx) => {
  const a = await tools.givePassivePoints(pool, fx.characterId, 10);
  const b = await tools.givePassivePoints(pool, fx.characterId, 5);
  assert.equal(b.total, a.total + 5);
}));

test('an item lands in world_items for the admin, at the asked level', { skip }, () => withFixture(async (pool, fx) => {
  const t = await pool.query("SELECT id, name FROM item_types WHERE category = 'weapon' ORDER BY id LIMIT 1");
  const added = []; const reserved = [];
  const entry = { worldId: fx.worldId, world: { groundItems: { add: (r) => added.push(...r), reserve: (...a) => reserved.push(a) } }, affixPool: [] };
  const r = await tools.dropItem(pool, entry, String(fx.userId), 100, 120, { itemTypeId: t.rows[0].id, rarity: 'foxy', level: 77 });
  assert.equal(r.ok, true);
  assert.equal(r.name, t.rows[0].name);
  const q = await pool.query('SELECT item_type_id, rarity, item_level, x, y FROM world_items WHERE world_id = $1', [fx.worldId]);
  assert.equal(q.rows.length, 1);
  assert.deepEqual([q.rows[0].rarity, q.rows[0].item_level, q.rows[0].x, q.rows[0].y], ['foxy', 77, 100, 120]);
  assert.equal(added.length, 1);
  assert.equal(reserved[0][1], String(fx.userId));
}));
