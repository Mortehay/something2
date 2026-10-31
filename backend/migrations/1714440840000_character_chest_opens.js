// backend/migrations/1714440840000_character_chest_opens.js
//
// Vault chests are per CHARACTER: opening one records it here, and it stays
// "looted" for THAT character until reopen_at, then can be opened again. Before
// this a vault chest had one global state, so the first player to open it
// emptied it for everyone, for ever (the lone chest in Vale Crossing).
// Field chests (loot maps) keep their global state and respawn timer.
exports.shorthands = undefined;

exports.up = (pgm) => {
  // A vault chest an older build left 'opened' for everyone is unlocked again; the
  // per-character table below now decides who has looted it.
  pgm.sql("UPDATE world_chests SET state = 'unlocked' WHERE kind = 'vault' AND state = 'opened'");
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS character_chest_opens (
      character_id integer NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      chest_id uuid NOT NULL REFERENCES world_chests(id) ON DELETE CASCADE,
      opened_at timestamptz NOT NULL DEFAULT now(),
      reopen_at timestamptz NOT NULL,
      PRIMARY KEY (character_id, chest_id)
    )
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS character_chest_opens');
};
