// SOMET-624 (S11, spec grilled 2026-10-11). A new boss_tier value for the
// ~40-entity miniboss roster: lighter than a dungeon_elite, scattered through
// the regular open world via the ordinary biome creature_types spawn path
// (not a singular-encounter manager like WorldBossManager/DungeonBossManager).
//
// Widening the CHECK, not replacing it: 'world', 'dungeon_end', 'dungeon_elite'
// are untouched, so no existing row needs rewriting.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE entity_types DROP CONSTRAINT entity_types_boss_tier_check;
    ALTER TABLE entity_types ADD CONSTRAINT entity_types_boss_tier_check
      CHECK (boss_tier IN ('world', 'dungeon_end', 'dungeon_elite', 'miniboss'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE entity_types SET boss_tier = NULL WHERE boss_tier = 'miniboss';
    ALTER TABLE entity_types DROP CONSTRAINT entity_types_boss_tier_check;
    ALTER TABLE entity_types ADD CONSTRAINT entity_types_boss_tier_check
      CHECK (boss_tier IN ('world', 'dungeon_end', 'dungeon_elite'));
  `);
};
