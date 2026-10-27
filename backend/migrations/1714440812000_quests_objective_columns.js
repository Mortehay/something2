// backend/migrations/1714440812000_quests_objective_columns.js
//
// SOMET-647. quests.objective / target_count / prerequisite_key are read by
// questsService and defined in seeds/data/questsData.js, but no migration ever
// created them: scripts/seed-quests.js added them itself with ALTER TABLE, so
// a database that was never quest-seeded (the dev DB) had a quests table the
// service could not query. The schema belongs here; the seeder no longer
// touches it.
//
// IF NOT EXISTS: every database that DID run the seeder already has the
// columns, with exactly these types and defaults.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE quests
      ADD COLUMN IF NOT EXISTS objective text,
      ADD COLUMN IF NOT EXISTS target_count integer NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS prerequisite_key varchar(64)
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE quests
      DROP COLUMN IF EXISTS objective,
      DROP COLUMN IF EXISTS target_count,
      DROP COLUMN IF EXISTS prerequisite_key
  `);
};
