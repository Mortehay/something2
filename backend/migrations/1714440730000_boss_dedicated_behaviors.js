// backend/migrations/1714440730000_boss_dedicated_behaviors.js
//
// SOMET-610 (S7). Pre-work for skill kits. Today all 10 bosses -- and the 4
// world-boss phase minions -- resolve their behaviour through one of three
// SHARED rows: the 4 world bosses + all 4 Elemental Guards use 'Line' (same
// row as Slime/Wolf/Bat/every starter-biome Line creature, 44 entities
// total); the 3 dungeon_end bosses use 'Apex' (35 entities, every biome's
// own Apex mob included); the 3 dungeon_elite bosses use 'Champion' (44
// entities). Live-queried on 2026-10-12, not assumed.
//
// S6's `creature_behavior_skills` binds a skill to a BEHAVIOUR, not an
// entity type. Binding a boss's signature slam to 'Line' would hand it to
// every Slime in the game; binding it to 'Apex'/'Champion' would hand the
// SAME skill, identically, to all three dungeon bosses of that tier at
// once -- there would be no way to give The Bone Regent and The Ember Queen
// different kits. Each of the 11 entities below (10 bosses + Fire Elemental
// Guard, the one ordinary-creature scaled-kit example this slice adds) gets
// its own dedicated behaviour row instead, copied VALUE-FOR-VALUE (including
// its ability set) from the shared row it used a moment ago -- so every
// existing creature on 'Line'/'Apex'/'Champion' is completely unaffected,
// and these 11 behave identically to before until S7's own seed migration
// (1714440731000) actually binds a skill to the new row.
//
// Idempotent: behaviour insert is ON CONFLICT DO NOTHING (a re-run or a
// name collision with an admin's own row leaves it alone), the ability copy
// is guarded by NOT EXISTS, and the entity_types repoint only touches a row
// still pointing at the OLD shared id -- so re-running after an admin has
// since retuned one of these 11 by hand never reverts their edit.
exports.shorthands = undefined;

// [entity name (also becomes the new behaviour's name -- unique, traceable
// back to exactly which creature owns it), source behaviour it shared until now]
const TARGETS = [
  ['Ignis, the Magma Colossus', 'Line'],
  ['Glacius, the Frost Leviathan', 'Line'],
  ['Abyssor, the Voidreaver', 'Line'],
  ['Gorgon, the Thunder Titan', 'Line'],
  ['The Bone Regent', 'Apex'],
  ['The Ember Queen', 'Apex'],
  ['The Umbral Gatekeeper', 'Apex'],
  ['Ossuary Warden', 'Champion'],
  ['Cinder Matriarch', 'Champion'],
  ['Shade Herald', 'Champion'],
  // The one ordinary-creature example this slice gives a scaled-down kit
  // (spec: "e.g. Fire Elemental with ignis_slam @0.4") -- "Fire Elemental"
  // itself does not exist as an entity_types row; "Fire Elemental Guard"
  // (a real, spawnable world-boss phase minion) is the closest real match
  // and shares the same 'Line' leak risk the bosses do.
  ['Fire Elemental Guard', 'Line'],
];

// Same manual escape 1714440671000_seed_world_boss_entities.js uses --
// pgm has no escapeLiteral helper in this project's node-pg-migrate version.
const sqlString = (s) => `'${s.replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  const values = TARGETS.map(([name, src]) => `(${sqlString(name)}, ${sqlString(src)})`).join(',\n      ');

  pgm.sql(`
    WITH targets(entity_name, source_behavior) AS (VALUES
      ${values}
    )
    INSERT INTO creature_behaviors
      (name, aggro_radius, leash_radius, chase_style, preferred_range, move_speed_mult, damage_override, gold_min, gold_max)
    SELECT t.entity_name, b.aggro_radius, b.leash_radius, b.chase_style,
           b.preferred_range, b.move_speed_mult, b.damage_override, b.gold_min, b.gold_max
      FROM targets t JOIN creature_behaviors b ON b.name = t.source_behavior
    ON CONFLICT (name) DO NOTHING
  `);

  pgm.sql(`
    WITH targets(entity_name, source_behavior) AS (VALUES
      ${values}
    )
    INSERT INTO creature_abilities
      (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown,
       projectile_speed, projectile_radius, element, damage_mult, knockback)
    SELECT nb.id, a.slot, a.name, a.attack_kind, a.attack_range, a.attack_cooldown,
           a.projectile_speed, a.projectile_radius, a.element, a.damage_mult, a.knockback
      FROM targets t
      JOIN creature_behaviors sb ON sb.name = t.source_behavior
      JOIN creature_behaviors nb ON nb.name = t.entity_name
      JOIN creature_abilities a ON a.behavior_id = sb.id
     WHERE NOT EXISTS (
       SELECT 1 FROM creature_abilities ex WHERE ex.behavior_id = nb.id AND ex.slot = a.slot
     )
  `);

  // Only an entity STILL pointing at the shared row is repointed -- an
  // admin who has since moved one of these 11 onto a different profile by
  // hand is left alone, same "the Entities tab owns it after the first
  // insert" posture 1714440671000's own comment states for the boss rows
  // themselves.
  pgm.sql(`
    WITH targets(entity_name, source_behavior) AS (VALUES
      ${values}
    )
    UPDATE entity_types e
       SET behavior_id = nb.id
      FROM targets t
      JOIN creature_behaviors sb ON sb.name = t.source_behavior
      JOIN creature_behaviors nb ON nb.name = t.entity_name
     WHERE e.name = t.entity_name AND e.behavior_id = sb.id
  `);
};

exports.down = (pgm) => {
  const values = TARGETS.map(([name, src]) => `(${sqlString(name)}, ${sqlString(src)})`).join(',\n      ');
  // Repoint back to the shared row FIRST -- creature_abilities cascades away
  // with its behaviour (ON DELETE CASCADE), so the delete below is enough to
  // clean up the copied abilities; nothing references the dedicated
  // behaviour by the time it goes.
  pgm.sql(`
    WITH targets(entity_name, source_behavior) AS (VALUES
      ${values}
    )
    UPDATE entity_types e
       SET behavior_id = sb.id
      FROM targets t
      JOIN creature_behaviors sb ON sb.name = t.source_behavior
      JOIN creature_behaviors nb ON nb.name = t.entity_name
     WHERE e.name = t.entity_name AND e.behavior_id = nb.id
  `);
  pgm.sql(`
    DELETE FROM creature_behaviors WHERE name IN (${TARGETS.map(([name]) => sqlString(name)).join(', ')})
  `);
};

exports.TARGETS = TARGETS;
