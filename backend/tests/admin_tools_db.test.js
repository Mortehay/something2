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

test('an enchanted weapon is written with its level, a clamped one with the cap', { skip }, () => withFixture(async (pool, fx) => {
  const enchant = require('../src/services/enchant.js');
  const t = await pool.query("SELECT id FROM item_types WHERE category = 'weapon' ORDER BY id LIMIT 1");
  const entry = { worldId: fx.worldId, world: { groundItems: { add() {}, reserve() {} } }, affixPool: [] };
  const a = await tools.dropItem(pool, entry, String(fx.userId), 10, 10, { itemTypeId: t.rows[0].id, enchantLevel: 10 });
  const b = await tools.dropItem(pool, entry, String(fx.userId), 20, 20, { itemTypeId: t.rows[0].id, enchantLevel: 500 });
  assert.deepEqual([a.ok, a.enchantLevel, b.enchantLevel], [true, 10, enchant.ENCHANT_CONFIG.maxLevel]);
  const q = await pool.query('SELECT enchant_level FROM world_items WHERE world_id = $1 ORDER BY x', [fx.worldId]);
  assert.deepEqual(q.rows.map((r) => r.enchant_level), [10, enchant.ENCHANT_CONFIG.maxLevel]);
}));

test('gems are granted for real: one, a class, twice (idempotent), and the live set follows', { skip }, () => withFixture(async (pool, fx) => {
  const { SKILLS } = require('../seeds/data/skills.js');
  const player = { className: 'Warrior' };
  const one = await tools.grantGems(pool, player, fx.characterId, { skillId: 'war_flurry_of_steel' });
  assert.deepEqual([one.ok, one.granted, one.already], [true, ['war_flurry_of_steel'], 0]);
  const cls = await tools.grantGems(pool, player, fx.characterId, { scope: 'class' });
  const warriors = SKILLS.filter((s) => s.class === 'Warrior').length;
  assert.equal(cls.total, warriors);
  assert.equal(cls.already, 1, 'the one granted a moment ago is not granted twice');
  assert.equal(cls.granted.length, warriors - 1);
  const again = await tools.grantGems(pool, player, fx.characterId, { scope: 'class' });
  assert.deepEqual([again.granted.length, again.already], [0, warriors]);
  const rows = await pool.query('SELECT count(*)::int AS n, sum(price_paid)::int AS paid FROM character_gems WHERE character_id = $1', [fx.characterId]);
  assert.deepEqual([rows.rows[0].n, rows.rows[0].paid], [warriors, 0]);
  assert.equal(player.ownedGems.size, warriors);
}));

test('a skill level is stored exactly, replaced, capped and removed', { skip }, () => withFixture(async (pool, fx) => {
  const leveling = require('../src/services/skillLeveling.js');
  const cap = leveling.SKILL_LEVELING_CONFIG.maxLevel;
  const player = {};
  const read = async () => (await pool.query('SELECT level FROM character_skill_levels WHERE character_id = $1 AND skill_id = $2', [fx.characterId, 'war_flurry_of_steel'])).rows.map((r) => r.level);
  assert.deepEqual(await read(), []);
  await tools.setSkillLevel(pool, player, fx.characterId, 'war_flurry_of_steel', 6);
  assert.deepEqual(await read(), [6]);
  await tools.setSkillLevel(pool, player, fx.characterId, 'war_flurry_of_steel', 3);
  assert.deepEqual(await read(), [3], 'replaced, not added');
  const over = await tools.setSkillLevel(pool, player, fx.characterId, 'war_flurry_of_steel', 1000);
  assert.deepEqual([await read(), over.capped], [[cap], true]);
  await tools.setSkillLevel(pool, player, fx.characterId, 'war_flurry_of_steel', 0);
  assert.deepEqual(await read(), []);
  assert.equal(player.skillLevels.has('war_flurry_of_steel'), false);
}));
