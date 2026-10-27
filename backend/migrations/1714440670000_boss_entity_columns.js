//
// SOMET-603 (S1, spec 2026-10-10-boss-entities-auras-design.md §3.1).
// Bosses become catalog creatures. One boss flag (boss_tier) drives render,
// audio, HUD and spawn; element feeds the procedural fallback and audio
// prompts; hitbox_size is the SERVER box (NULL -> CREATURE_SIZE 48);
// xp_reward and base_damage carry the stats the old JS WORLD_BOSS_CATALOG held.
//
// base_damage: entity_types has no damage column (ordinary creatures take
// theirs from world_creatures.damage, scaled at placement), and boss
// instances are never persisted, so the per-boss damage lives here.
//
// auras is ALSO created by S3 (aura library). Both use IF NOT EXISTS, and this
// migration's down does not drop it, so whichever lands first owns it.
//
// attack_element gains 'arcane': Abyssor attacks arcane today (in memory, via
// the JS catalog). damage.js ELEMENTS and the elements table already include
// it, so this only stops the CHECK from rejecting what the sim already does.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE entity_types
      ADD COLUMN boss_tier text NULL
        CONSTRAINT entity_types_boss_tier_check
        CHECK (boss_tier IN ('world', 'dungeon_end', 'dungeon_elite')),
      ADD COLUMN element text NULL
        CONSTRAINT entity_types_element_fkey
        REFERENCES elements(name) ON UPDATE CASCADE ON DELETE SET NULL,
      ADD COLUMN hitbox_size integer NULL
        CONSTRAINT entity_types_hitbox_size_check CHECK (hitbox_size BETWEEN 1 AND 400),
      ADD COLUMN xp_reward integer NULL
        CONSTRAINT entity_types_xp_reward_check CHECK (xp_reward >= 0),
      ADD COLUMN base_damage real NULL
        CONSTRAINT entity_types_base_damage_check CHECK (base_damage >= 0);
    ALTER TABLE entity_types ADD COLUMN IF NOT EXISTS auras jsonb NULL;
    ALTER TABLE entity_types DROP CONSTRAINT entity_types_attack_element_check;
    ALTER TABLE entity_types ADD CONSTRAINT entity_types_attack_element_check
      CHECK (attack_element IN ('physical', 'arcane', 'fire', 'ice', 'lightning'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE entity_types SET attack_element = 'physical' WHERE attack_element = 'arcane';
    ALTER TABLE entity_types DROP CONSTRAINT entity_types_attack_element_check;
    ALTER TABLE entity_types ADD CONSTRAINT entity_types_attack_element_check
      CHECK (attack_element IN ('physical', 'fire', 'ice', 'lightning'));
    ALTER TABLE entity_types
      DROP COLUMN base_damage, DROP COLUMN xp_reward, DROP COLUMN hitbox_size,
      DROP COLUMN element, DROP COLUMN boss_tier;
  `);
};
