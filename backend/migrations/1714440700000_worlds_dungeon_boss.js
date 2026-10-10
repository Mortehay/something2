//
// SOMET-609 (S9, spec §3.5). The map spec's optional per-world `boss` block
// ({ entity, x, y, respawn_s }) is written here by applyMapSpec on EVERY seed
// (re-asserted like pens/safe_rects), and read by loadWorld for
// DungeonBossManager. The spec is the source of truth and
// `make seed-map SPEC=p5-descent` fills it; 1714440702000 backfills the six
// p5 worlds for DBs that only ever run migrations (deploy, shared dev DB).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE worlds ADD COLUMN dungeon_boss jsonb NULL;
    ALTER TABLE worlds ADD CONSTRAINT worlds_dungeon_boss_object_check
      CHECK (dungeon_boss IS NULL OR jsonb_typeof(dungeon_boss) = 'object');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE worlds DROP CONSTRAINT IF EXISTS worlds_dungeon_boss_object_check;
    ALTER TABLE worlds DROP COLUMN IF EXISTS dungeon_boss;
  `);
};
