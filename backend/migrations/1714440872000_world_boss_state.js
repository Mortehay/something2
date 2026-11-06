// backend/migrations/1714440872000_world_boss_state.js
//
// The world boss's spawn schedule, so a server restart no longer resets the countdown
// to a fresh 30 minutes. One row (id is pinned to 1). Only the NEXT spawn time is kept:
// a boss that is already on the field is not persisted -- creatures live in memory --
// and is lost on restart; the event returns with the next scheduled spawn.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS world_boss_state (
      id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      next_spawn_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS world_boss_state');
};
