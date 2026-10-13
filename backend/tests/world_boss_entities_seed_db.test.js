// backend/tests/world_boss_entities_seed_db.test.js
// SOMET-603 (S1, spec §3.8): the world bosses and their minion types are
// catalog rows. Expected values are the ones the old JS WORLD_BOSS_CATALOG
// carried, restated here as literals -- never read back from the migration.
//
// SOMET-610 (S7): the four world bosses and Fire Elemental Guard were
// repointed off the shared 'Line' row onto their own dedicated behavior rows
// (migration 1714440730000_boss_dedicated_behaviors.js) so a boss's skill
// kit binds to it alone rather than leaking onto every Line creature. The
// other three Elemental Guards are untouched by that migration and still
// share 'Line'.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

const COLS = `e.name, e.boss_tier, e.element, e.attack_element, e.hp, e.max_hp, e.defense,
  e.base_damage, e.hitbox_size, e.display_width, e.display_height, e.xp_reward,
  e.gold_min, e.gold_max, e.faction, e.is_creature, b.name AS behavior`;

test('the four world bosses are boss_tier=world rows with their legacy stats', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT ${COLS} FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
        WHERE e.boss_tier = 'world' ORDER BY e.name`);
    const row = (name, element, hp, defense, dmg, size, xp, gold) => ({
      name, boss_tier: 'world', element, attack_element: element, hp, max_hp: hp, defense,
      base_damage: dmg, hitbox_size: size, display_width: size, display_height: size,
      xp_reward: xp, gold_min: gold, gold_max: gold, faction: 'hostile', is_creature: true,
      behavior: name,
    });
    assert.deepEqual(r.rows, [
      row('Abyssor, the Voidreaver', 'arcane', 10000, 18, 55, 80, 4000, 600),
      row('Glacius, the Frost Leviathan', 'ice', 14000, 32, 35, 96, 3800, 550),
      row('Gorgon, the Thunder Titan', 'lightning', 13000, 24, 45, 96, 3600, 520),
      row('Ignis, the Magma Colossus', 'fire', 12000, 25, 42, 96, 3500, 500),
    ]);
  } finally {
    await pool.end();
  }
});

test('the four Elemental Guard minion types are ordinary (untiered) creature rows', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT ${COLS} FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
        WHERE e.name LIKE '% Elemental Guard' ORDER BY e.name`);
    const row = (name, element, behavior) => ({
      name, boss_tier: null, element, attack_element: element, hp: 1500, max_hp: 1500,
      defense: 15, base_damage: 25, hitbox_size: null, display_width: null, display_height: null,
      xp_reward: null, gold_min: 0, gold_max: 0, faction: 'hostile', is_creature: true,
      behavior,
    });
    assert.deepEqual(r.rows, [
      row('Arcane Elemental Guard', 'arcane', 'Line'),
      row('Fire Elemental Guard', 'fire', 'Fire Elemental Guard'),
      row('Ice Elemental Guard', 'ice', 'Line'),
      row('Lightning Elemental Guard', 'lightning', 'Line'),
    ]);
  } finally {
    await pool.end();
  }
});
