// backend/migrations/1714440827000_quests_objective_types.js
//
// Quest objectives were free text ("Slay 50 Weak Slimes"), so nothing could
// count them and no quest with target_count > 1 was completable in play.
// objective_type says HOW progress is earned; target_key says WHAT counts.
//
//   kill      a creature whose type name equals target_key (case-insensitive)
//   kill_any  any creature kill
//   boss      any boss-tier kill (target_key unused)
//   manual    no in-game tracker exists yet (gather / reach / choose / floors);
//             the quest is turned in at the quest giver and its progress is
//             treated as met. Retire this type as each tracker is built.
//
// IF NOT EXISTS: same convention as 1714440812000.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE quests
      ADD COLUMN IF NOT EXISTS objective_type varchar(16) NOT NULL DEFAULT 'manual',
      ADD COLUMN IF NOT EXISTS target_key varchar(64)
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE quests
      DROP COLUMN IF EXISTS objective_type,
      DROP COLUMN IF EXISTS target_key
  `);
};
