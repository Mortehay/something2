// backend/migrations/1714440701000_seed_dungeon_boss_entities.js
//
// SOMET-609 (S9, spec §3.8). Three dungeon End bosses and three Elite bosses,
// one per p5-descent spine dungeon (Catacombs, Emberhive, Umbral Gate), plus
// the three ally-side auras the Elites carry. Frozen literals: this file must
// not require seeds/data (a later data edit would silently rewrite history).
// dungeon_boss_data_parity.test.js pins these equal to seeds/data today.
//
// Stats: the dungeon's Apex rung (hp 130 / def 13 / base damage 5) scaled by
// scaleCreature to the boss level, then End x8 hp x3 damage, Elite x4 hp x2
// damage. Bosses hydrate from this TYPE row (never a world_creatures row), so
// the row's hp/defense/base_damage are what the sim gets.
//
// Behaviour by name: Apex (End), Champion (Elite), both migration-seeded by
// 1714440080000. auras: End '[]' (explicit, so bindDefaultAuras' NULL-only
// rule never binds pack_leader to them), Elite one ally aura each.
//
// One drop rule each, same guarded cross-join as 1714440671000 (a missing item
// inserts nothing). INERT until S10: a boss kill never reaches spawnDrops.
//
// ON CONFLICT DO NOTHING throughout: an admin's later edits are never reverted.
exports.shorthands = undefined;

const AURAS = [
  { name: 'ossuary_dread', target_side: 'allies', radius: 320, damage_mult: 1, defense_mult: 1.3,
    speed_mult: 1, shape: 'ring', color: '#cfc8b0', pulse_ms: 1600 },
  { name: 'cinder_brood', target_side: 'allies', radius: 300, damage_mult: 1.25, defense_mult: 1,
    speed_mult: 1.1, shape: 'ring', color: '#ff7a1a', pulse_ms: 900 },
  { name: 'shade_veil', target_side: 'allies', radius: 340, damage_mult: 1, defense_mult: 1.15,
    speed_mult: 1.25, shape: 'ring', color: '#7c3aed', pulse_ms: 1400 },
];

const ROWS = [
  { name: 'The Bone Regent', boss_tier: 'dungeon_end', element: 'physical', color: '#d8d2c0',
    hp: 2000, defense: 16, base_damage: 24, size: 96, xp_reward: 300, gold_min: 20, gold_max: 40,
    behavior_name: 'Apex', auras: [], resistances: { ice: 0.5, physical: 0.3 }, drop_item: 'long sword',
    prompt: 'A crowned skeletal monarch on a throne of fused bones, ruling the deepest crypt of the Catacombs.' },
  { name: 'Ossuary Warden', boss_tier: 'dungeon_elite', element: 'physical', color: '#b8b09a',
    hp: 850, defense: 15, base_damage: 14, size: 72, xp_reward: 120, gold_min: 8, gold_max: 15,
    behavior_name: 'Champion', auras: ['ossuary_dread'], resistances: { ice: 0.4, physical: 0.2 }, drop_item: 'short sword',
    prompt: 'A towering armoured skeleton keeper wrapped in burial chains, guarding the ossuary.' },
  { name: 'The Ember Queen', boss_tier: 'dungeon_end', element: 'fire', color: '#ff6b1a',
    hp: 5000, defense: 25, base_damage: 52, size: 96, xp_reward: 1200, gold_min: 75, gold_max: 150,
    behavior_name: 'Apex', auras: [], resistances: { fire: 0.8, physical: 0.3 }, drop_item: 'flame staff',
    prompt: 'A vast molten hive queen with a glowing ember abdomen and wings of smouldering ash.' },
  { name: 'Cinder Matriarch', boss_tier: 'dungeon_elite', element: 'fire', color: '#c2410c',
    hp: 2200, defense: 23, base_damage: 31, size: 72, xp_reward: 500, gold_min: 30, gold_max: 60,
    behavior_name: 'Champion', auras: ['cinder_brood'], resistances: { fire: 0.6, physical: 0.2 }, drop_item: 'flame staff',
    prompt: 'A scorched brood mother insect trailing cinders, tending the burning hive cells.' },
  { name: 'The Umbral Gatekeeper', boss_tier: 'dungeon_end', element: 'arcane', color: '#4c1d95',
    hp: 8700, defense: 37, base_damage: 88, size: 112, xp_reward: 2500, gold_min: 175, gold_max: 350,
    behavior_name: 'Apex', auras: [], resistances: { arcane: 0.6, physical: 0.4 }, drop_item: 'archmage staff',
    prompt: 'A colossal void sentinel of living shadow, its body a doorway into starless dark.' },
  { name: 'Shade Herald', boss_tier: 'dungeon_elite', element: 'arcane', color: '#6d28d9',
    hp: 4100, defense: 36, base_damage: 56, size: 80, xp_reward: 1100, gold_min: 75, gold_max: 150,
    behavior_name: 'Champion', auras: ['shade_veil'], resistances: { arcane: 0.5, physical: 0.3 }, drop_item: 'archmage staff',
    prompt: 'A hooded wraith herald with a tattered banner of shadow, announcing the Gatekeeper.' },
];

const sqlString = (s) => `'${s.replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO aura_effects (name, target_side, radius, damage_mult, defense_mult, speed_mult, shape, color, pulse_ms)
    SELECT a.name, a.target_side, a.radius, a.damage_mult, a.defense_mult, a.speed_mult, a.shape, a.color, a.pulse_ms
      FROM jsonb_to_recordset(${sqlString(JSON.stringify(AURAS))}::jsonb) AS a(
        name text, target_side text, radius real, damage_mult real, defense_mult real,
        speed_mult real, shape text, color text, pulse_ms int)
    ON CONFLICT (name) DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO entity_types
      (name, color, walkable, spawn_tiles, chance, is_creature, hp, max_hp, defense,
       resistances, faction, gold_min, gold_max, prompt, attack_element, behavior_id,
       boss_tier, element, hitbox_size, xp_reward, base_damage, display_width, display_height, auras)
    SELECT r.name, r.color, true, '[]'::jsonb, 0, true, r.hp, r.hp, r.defense,
           r.resistances, 'hostile', r.gold_min, r.gold_max, r.prompt, r.element,
           (SELECT id FROM creature_behaviors WHERE name = r.behavior_name),
           r.boss_tier, r.element, r.size, r.xp_reward, r.base_damage, r.size, r.size, r.auras
      FROM jsonb_to_recordset(${sqlString(JSON.stringify(ROWS))}::jsonb) AS r(
        name text, boss_tier text, element text, color text, hp int, defense real, base_damage real,
        size int, xp_reward int, gold_min int, gold_max int, behavior_name text, auras jsonb,
        resistances jsonb, drop_item text, prompt text)
    ON CONFLICT (name) DO NOTHING
  `);
  for (const r of ROWS) {
    pgm.sql(`
      INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty)
      SELECT et.id, it.id, 0.2, 1, 1
        FROM entity_types et, item_types it
       WHERE et.name = ${sqlString(r.name)} AND it.name = ${sqlString(r.drop_item)}
         AND NOT EXISTS (SELECT 1 FROM creature_drops cd WHERE cd.entity_type_id = et.id AND cd.item_type_id = it.id)
    `);
  }
};

exports.down = (pgm) => {
  const names = ROWS.map((r) => sqlString(r.name)).join(', ');
  const auras = AURAS.map((a) => sqlString(a.name)).join(', ');
  pgm.sql(`
    DELETE FROM creature_drops WHERE entity_type_id IN (SELECT id FROM entity_types WHERE name IN (${names}));
    DELETE FROM entity_types WHERE name IN (${names});
    DELETE FROM aura_effects WHERE name IN (${auras});
  `);
};

// Read by dungeon_boss_data_parity.test.js only; node-pg-migrate reads up/down.
exports.ROWS = ROWS;
exports.AURAS = AURAS;
