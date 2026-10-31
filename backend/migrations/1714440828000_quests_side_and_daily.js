// backend/migrations/1714440828000_quests_side_and_daily.js
//
// Side quests sit OUTSIDE the main storyline chain, and some repeat daily.
//
//   is_side      true => no implicit "previous quest" prerequisite. Main quests
//                fall back to the previous row when prerequisite_key is null;
//                a side quest with no prerequisite is simply open (level
//                permitting).
//   repeat_kind  'none' | 'daily'. A completed daily is offered again from
//                zero once the UTC day has rolled over since completed_at.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE quests
      ADD COLUMN IF NOT EXISTS is_side boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS repeat_kind varchar(8) NOT NULL DEFAULT 'none'
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE quests
      DROP COLUMN IF EXISTS is_side,
      DROP COLUMN IF EXISTS repeat_kind
  `);
};
