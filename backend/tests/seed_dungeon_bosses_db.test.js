// backend/tests/seed_dungeon_bosses_db.test.js
// SOMET-609 (S9). An admin who deletes a dungeon boss gets it back from
// `make seed-catalogs` -- tiered, behaved, aura-bound and with its drop rule --
// not as an untiered plain creature (what seedOneCreatureType would restore).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { seedOneDungeonBoss } = require('../scripts/seed-catalogs.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

const ZZ = {
  name: 'zzS9 Restored Warden', boss_tier: 'dungeon_elite', element: 'physical', color: '#b8b09a',
  hp: 850, defense: 15, base_damage: 14, size: 72, xp_reward: 120, gold_min: 8, gold_max: 15,
  behavior_name: 'Champion', auras: ['ossuary_dread'], resistances: { ice: 0.4 },
  drop_item: 'short sword', prompt: 'test',
};

test('seedOneDungeonBoss inserts a complete boss once and never overwrites it', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    assert.equal(await seedOneDungeonBoss(c, ZZ), 1, 'first run inserts');
    const r = await c.query(
      `SELECT e.boss_tier, e.element, e.attack_element, e.hp, e.max_hp, e.hitbox_size, e.display_height,
              e.base_damage, e.auras, e.resistances, b.name AS behavior,
              (SELECT count(*)::int FROM creature_drops cd JOIN item_types it ON it.id = cd.item_type_id
                WHERE cd.entity_type_id = e.id AND it.name = 'short sword') AS drops
         FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id WHERE e.name = $1`, [ZZ.name]);
    assert.deepEqual(r.rows[0], {
      boss_tier: 'dungeon_elite', element: 'physical', attack_element: 'physical', hp: 850, max_hp: 850,
      hitbox_size: 72, display_height: 72, base_damage: 14, auras: ['ossuary_dread'],
      resistances: { ice: 0.4 }, behavior: 'Champion', drops: 1,
    });

    await c.query('UPDATE entity_types SET hp = 1 WHERE name = $1', [ZZ.name]);
    assert.equal(await seedOneDungeonBoss(c, ZZ), 0, 'second run is a no-op');
    const again = await c.query(
      `SELECT e.hp, (SELECT count(*)::int FROM creature_drops cd WHERE cd.entity_type_id = e.id) AS drops
         FROM entity_types e WHERE e.name = $1`, [ZZ.name]);
    assert.deepEqual(again.rows[0], { hp: 1, drops: 1 }, 'admin edit kept, no duplicate drop rule');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
    await pool.end();
  }
});
