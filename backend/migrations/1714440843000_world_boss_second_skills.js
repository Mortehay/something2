// backend/migrations/1714440843000_world_boss_second_skills.js
//
// A second signature skill for each world boss, so the four fights stop reading
// alike (they all had one slam/nova/bolt on a timer):
//   Ignis    Cinder Brood   summons two Ember Skirmishers every 30s    (adds to clear)
//   Glacius  Glacial Lance  a long-range ice bolt with a long wind-up   (punishes standing off)
//   Gorgon   Static Pulse   a huge nova with a 2.2s warning             (leave the circle)
//   Abyssor  Rift Collapse  a wide slam with only 0.6s warning          (react fast)
// Slot 2 beside each boss's original slot-1 skill. Idempotent.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO creature_skills
      (name, kind, telegraph_ms, cooldown_ms, radius, range, damage_mult, element,
       summon_entity, summon_count, vfx, sync_uuid)
    VALUES
    ('Cinder Brood', 'summon', 1500, 30000, 0, 350, 1, 'fire', 'Ember Skirmisher', 2, '{"cast":"fireball_blast","telegraph":"fireball_blast"}'::jsonb, '3f5a442a-b828-52d8-a1d5-fca1083e2bb0'),
    ('Glacial Lance', 'projectile', 1500, 9000, 20, 700, 2.6, 'ice', NULL, 1, '{"cast":"frost_nova","impact":"ice_shard","telegraph":"frost_nova"}'::jsonb, '78f84aa6-1d1d-5d75-8879-bcd66ec07ac8'),
    ('Static Pulse', 'nova', 2200, 14000, 380, 300, 2.4, 'lightning', NULL, 1, '{"cast":"ball_lightning","impact":"thunder_clap","telegraph":"ball_lightning"}'::jsonb, 'e3d34ce7-47df-5724-b720-4a8506c97031'),
    ('Rift Collapse', 'slam', 600, 9000, 300, 350, 2, 'arcane', NULL, 1, '{"cast":"void_bolt","impact":"curse_blast","telegraph":"void_bolt"}'::jsonb, '3d799976-e067-53a5-89ee-541b82af57cd')
    ON CONFLICT (name) DO NOTHING
  `);
  const BINDINGS = [
  ['Ignis, the Magma Colossus', 'Cinder Brood', 'a488f6d8-4881-5514-9d25-a0f53106f894'],
  ['Glacius, the Frost Leviathan', 'Glacial Lance', 'a2609fc5-7b6c-5a90-b1c2-1601be8323e4'],
  ['Gorgon, the Thunder Titan', 'Static Pulse', 'bdedb6d0-78da-53d1-b405-4f1ce0eb988f'],
  ['Abyssor, the Voidreaver', 'Rift Collapse', '6e3dcc61-6ca8-5eef-9c36-5088c8ca0cdc'],
  ];
  for (const [boss, skill, uuid] of BINDINGS) {
    pgm.sql(`
      INSERT INTO creature_behavior_skills (behavior_id, skill_id, slot, power_scale, sync_uuid)
      SELECT e.behavior_id, s.id, 2, 1, '${uuid}'
        FROM entity_types e, creature_skills s
       WHERE e.name = '${boss.replace(/'/g, "''")}' AND e.boss_tier = 'world' AND s.name = '${skill}'
         AND e.behavior_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM creature_behavior_skills x WHERE x.behavior_id = e.behavior_id AND x.skill_id = s.id)
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM creature_behavior_skills WHERE skill_id IN (SELECT id FROM creature_skills WHERE name IN ('Cinder Brood','Glacial Lance','Static Pulse','Rift Collapse'))");
  pgm.sql("DELETE FROM creature_skills WHERE name IN ('Cinder Brood','Glacial Lance','Static Pulse','Rift Collapse')");
};
