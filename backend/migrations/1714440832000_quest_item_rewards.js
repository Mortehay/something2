// backend/migrations/1714440832000_quest_item_rewards.js
//
// Item rewards. quests.item_reward is an item_types NAME (resolved at delivery,
// the behavior_drops / chest_loot convention, so a catalog rebuild cannot
// strand an id). character_quests.reward_item_pending is the delivery ledger:
// set when the quest completes, cleared when the item has been dropped at the
// player's feet. A player who is not in a world at that moment (or a drop that
// failed) is paid at their next join instead of losing the item.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE quests ADD COLUMN IF NOT EXISTS item_reward varchar(64);
    ALTER TABLE character_quests
      ADD COLUMN IF NOT EXISTS reward_item_pending boolean NOT NULL DEFAULT false;
  `);
  const { QUESTS } = require('../seeds/data/questsData.js');
  for (const q of QUESTS) {
    if (!q.item_reward) continue;
    pgm.sql(`UPDATE quests SET item_reward = '${String(q.item_reward).replace(/'/g, "''")}'
              WHERE key = '${String(q.key).replace(/'/g, "''")}'`);
  }
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE character_quests DROP COLUMN IF EXISTS reward_item_pending;
    ALTER TABLE quests DROP COLUMN IF EXISTS item_reward;
  `);
};
