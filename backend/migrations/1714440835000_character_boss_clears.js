// backend/migrations/1714440835000_character_boss_clears.js
//
// Which gate bosses a character has defeated, per world. A Spire boss floor
// (5, 10, 15, ...) does not let a character through its east door until they
// have a row here for that floor's world (services/bossGate.js). Permanent:
// the boss respawning for others never closes the door behind someone who
// already beat it.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS character_boss_clears (
      character_id integer NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      cleared_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (character_id, world_id)
    )
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS character_boss_clears');
};
