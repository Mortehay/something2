// backend/migrations/1714440671000_seed_world_boss_entities.js
//
// SOMET-603 (S1, spec §3.8). The four world bosses and their four phase-minion
// types move out of worldBoss.js's hardcoded WORLD_BOSS_CATALOG into
// entity_types, so the Art/Sprite/Audio tabs see them with no special casing.
// Stats are the JS catalog's, verbatim. Minions keep the old hardcoded spawn
// stats (hp 1500, defense 15, damage 25); the old "<ELEMENT> Elemental Guard"
// type string becomes a proper name.
//
// behaviour = Line, by name: Line is byte-identical to DEFAULT_BEHAVIOR
// (400/800/charge/x1), which is what the bosses resolved to before (they
// carried no behaviour at all). creature_behaviors_seed_db requires every
// creature to have one.
//
// One elemental drop rule each, same guarded cross-join posture as
// 1714440024000_elements_creature_drops.js (a missing item inserts nothing).
// INERT until S10: boss/minion instances are never written to world_creatures,
// so commitCreatureDeath never reaches the drop roll for them. They exist so
// creature_drops_db's "every hostile creature has a drop rule" holds, and
// because spec §3.7 rolls boss loot "on top of the entity's normal drop rows".
//
// ON CONFLICT DO NOTHING: an admin's later edits to these rows are never
// reverted by a re-run, and no seed file names them (so no re-seed fights it).
exports.shorthands = undefined;

const BOSSES = [
  { name: 'Ignis, the Magma Colossus', color: '#ff4757', element: 'fire', hp: 12000, defense: 25,
    base_damage: 42, size: 96, xp_reward: 3500, gold: 500,
    prompt: 'A titan forged from molten core and obsidian armor.' },
  { name: 'Glacius, the Frost Leviathan', color: '#70a1ff', element: 'ice', hp: 14000, defense: 32,
    base_damage: 35, size: 96, xp_reward: 3800, gold: 550,
    prompt: 'An ancient dread beast encased in eternal permafrost.' },
  { name: 'Abyssor, the Voidreaver', color: '#a55eea', element: 'arcane', hp: 10000, defense: 18,
    base_damage: 55, size: 80, xp_reward: 4000, gold: 600,
    prompt: 'A harbinger of the astral void who tears reality asunder.' },
  { name: 'Gorgon, the Thunder Titan', color: '#ffd166', element: 'lightning', hp: 13000, defense: 24,
    base_damage: 45, size: 96, xp_reward: 3600, gold: 520,
    prompt: 'An electrified colossus crackling with tempest storms.' },
];

const MINIONS = [
  { name: 'Fire Elemental Guard', color: '#ff4757', element: 'fire',
    prompt: 'A hulking guardian of living flame summoned to defend a world boss.' },
  { name: 'Ice Elemental Guard', color: '#70a1ff', element: 'ice',
    prompt: 'A hulking guardian of jagged ice summoned to defend a world boss.' },
  { name: 'Arcane Elemental Guard', color: '#a55eea', element: 'arcane',
    prompt: 'A hulking guardian of swirling arcane force summoned to defend a world boss.' },
  { name: 'Lightning Elemental Guard', color: '#ffd166', element: 'lightning',
    prompt: 'A hulking guardian of crackling lightning summoned to defend a world boss.' },
];

const DROP_ITEM_BY_ELEMENT = {
  fire: 'flame staff', ice: 'frost staff', arcane: 'archmage staff', lightning: 'storm staff',
};

const ROWS = [
  ...BOSSES.map((b) => ({
    name: b.name, color: b.color, element: b.element, hp: b.hp, defense: b.defense,
    base_damage: b.base_damage, boss_tier: 'world', hitbox_size: b.size, display: b.size,
    xp_reward: b.xp_reward, gold: b.gold, prompt: b.prompt,
  })),
  ...MINIONS.map((m) => ({
    name: m.name, color: m.color, element: m.element, hp: 1500, defense: 15,
    base_damage: 25, boss_tier: null, hitbox_size: null, display: null,
    xp_reward: null, gold: 0, prompt: m.prompt,
  })),
];

const sqlString = (s) => `'${s.replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO entity_types
      (name, color, walkable, spawn_tiles, chance, is_creature, hp, max_hp, defense,
       resistances, faction, gold_min, gold_max, prompt, attack_element, behavior_id,
       boss_tier, element, hitbox_size, xp_reward, base_damage, display_width, display_height)
    SELECT r.name, r.color, true, '[]'::jsonb, 0, true, r.hp, r.hp, r.defense,
           '{}'::jsonb, 'hostile', r.gold, r.gold, r.prompt, r.element,
           (SELECT id FROM creature_behaviors WHERE name = 'Line'),
           r.boss_tier, r.element, r.hitbox_size, r.xp_reward, r.base_damage, r.display, r.display
      FROM jsonb_to_recordset(${sqlString(JSON.stringify(ROWS))}::jsonb) AS r(
        name text, color text, element text, hp int, defense real, base_damage real,
        boss_tier text, hitbox_size int, display int, xp_reward int, gold int, prompt text)
    ON CONFLICT (name) DO NOTHING
  `);
  for (const r of ROWS) {
    pgm.sql(`
      INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty)
      SELECT et.id, it.id, 0.2, 1, 1
        FROM entity_types et, item_types it
       WHERE et.name = ${sqlString(r.name)} AND it.name = ${sqlString(DROP_ITEM_BY_ELEMENT[r.element])}
         AND NOT EXISTS (SELECT 1 FROM creature_drops cd WHERE cd.entity_type_id = et.id AND cd.item_type_id = it.id)
    `);
  }
};

exports.down = (pgm) => {
  const names = ROWS.map((r) => sqlString(r.name)).join(', ');
  pgm.sql(`
    DELETE FROM creature_drops WHERE entity_type_id IN (SELECT id FROM entity_types WHERE name IN (${names}));
    DELETE FROM entity_types WHERE name IN (${names});
  `);
};
