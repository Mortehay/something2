/* eslint-disable camelcase */
// Achievements journal.
//   character_counters      running totals / high-water marks the game feeds
//                           (services/achievements.js COUNTERS)
//   character_achievements  which milestones a character has unlocked, once
//   characters.active_title the title the character currently wears (a title
//                           they own: an achievement's or a quest's title_reward)
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS character_counters (
      character_id integer NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      key          varchar(48) NOT NULL,
      value        bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (character_id, key)
    );
    CREATE TABLE IF NOT EXISTS character_achievements (
      character_id    integer NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      achievement_key varchar(64) NOT NULL,
      unlocked_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (character_id, achievement_key)
    );
    ALTER TABLE characters ADD COLUMN IF NOT EXISTS active_title varchar(64);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE characters DROP COLUMN IF EXISTS active_title;
    DROP TABLE IF EXISTS character_achievements;
    DROP TABLE IF EXISTS character_counters;
  `);
};
