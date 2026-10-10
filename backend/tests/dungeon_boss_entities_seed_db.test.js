// backend/tests/dungeon_boss_entities_seed_db.test.js
// SOMET-609 (S9, spec §3.8). The six dungeon bosses on a real migrated DB.
// Values are restated as literals -- never read back from the migration or
// seeds/data -- so a typo in BOTH sources still fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('the six dungeon bosses are tiered catalog rows with their stats', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT e.name, e.boss_tier, e.element, e.attack_element, e.hp, e.max_hp, e.defense,
              e.base_damage, e.hitbox_size, e.display_width, e.xp_reward, e.gold_min, e.gold_max,
              e.faction, e.auras, b.name AS behavior
         FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
        WHERE e.boss_tier IN ('dungeon_end', 'dungeon_elite') ORDER BY e.name`);
    const row = (name, tier, element, hp, def, dmg, size, xp, gmin, gmax, behavior, auras) => ({
      name, boss_tier: tier, element, attack_element: element, hp, max_hp: hp, defense: def,
      base_damage: dmg, hitbox_size: size, display_width: size, xp_reward: xp,
      gold_min: gmin, gold_max: gmax, faction: 'hostile', auras, behavior,
    });
    assert.deepEqual(r.rows, [
      row('Cinder Matriarch', 'dungeon_elite', 'fire', 2200, 23, 31, 72, 500, 30, 60, 'Champion', ['cinder_brood']),
      row('Ossuary Warden', 'dungeon_elite', 'physical', 850, 15, 14, 72, 120, 8, 15, 'Champion', ['ossuary_dread']),
      row('Shade Herald', 'dungeon_elite', 'arcane', 4100, 36, 56, 80, 1100, 75, 150, 'Champion', ['shade_veil']),
      row('The Bone Regent', 'dungeon_end', 'physical', 2000, 16, 24, 96, 300, 20, 40, 'Apex', []),
      row('The Ember Queen', 'dungeon_end', 'fire', 5000, 25, 52, 96, 1200, 75, 150, 'Apex', []),
      row('The Umbral Gatekeeper', 'dungeon_end', 'arcane', 8700, 37, 88, 112, 2500, 175, 350, 'Apex', []),
    ]);
  } finally {
    await pool.end();
  }
});

test('the three Elite auras are ally-side library rows with no DoT', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT name, target_side, radius, damage_mult, defense_mult, speed_mult, dot_dps
         FROM aura_effects WHERE name IN ('ossuary_dread', 'cinder_brood', 'shade_veil') ORDER BY name`);
    assert.deepEqual(r.rows, [
      { name: 'cinder_brood', target_side: 'allies', radius: 300, damage_mult: 1.25, defense_mult: 1, speed_mult: 1.1, dot_dps: 0 },
      { name: 'ossuary_dread', target_side: 'allies', radius: 320, damage_mult: 1, defense_mult: 1.3, speed_mult: 1, dot_dps: 0 },
      { name: 'shade_veil', target_side: 'allies', radius: 340, damage_mult: 1, defense_mult: 1.15, speed_mult: 1.25, dot_dps: 0 },
    ]);
  } finally {
    await pool.end();
  }
});

test('every dungeon boss has exactly its one drop rule', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT e.name, it.name AS item FROM creature_drops cd
         JOIN entity_types e ON e.id = cd.entity_type_id JOIN item_types it ON it.id = cd.item_type_id
        WHERE e.boss_tier IN ('dungeon_end', 'dungeon_elite') ORDER BY e.name`);
    assert.deepEqual(r.rows, [
      { name: 'Cinder Matriarch', item: 'flame staff' },
      { name: 'Ossuary Warden', item: 'short sword' },
      { name: 'Shade Herald', item: 'archmage staff' },
      { name: 'The Bone Regent', item: 'long sword' },
      { name: 'The Ember Queen', item: 'flame staff' },
      { name: 'The Umbral Gatekeeper', item: 'archmage staff' },
    ]);
  } finally {
    await pool.end();
  }
});
