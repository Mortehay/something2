// backend/migrations/1714440841000_power_tinders.js
//
// "power-tinders": boots that are strong when you start, ordinary in the middle
// of the game and weak at the end. They are a flat 3.6 defense from level 1,
// while the boots ladder (generateGearLadder) only reaches that at level ~55
// (runed-boots 3.2) and tops out at 10.1 / 17.4 (mythic boots / greaves):
//   level 1     3.6 vs 1.2  best ladder feet piece  -> 3x as good
//   level 40    3.6 vs 4.1                          -> on par
//   level 150   3.6 vs 17.4                         -> a fifth
// Nothing scales: the ladder simply outgrows them, which is the whole design.
// No stat or level requirement beyond level 1, so a new character can wear them
// at once; the first quest hands them out (quests.item_reward).
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO item_types (name, damage, cooldown, category, slot, defense, value,
                            req_level, item_level, tier, sync_uuid)
    VALUES ('power-tinders', 0, 0, 'armor', 'feet', 3.6, 120, 1, 1, 1,
            '29a089de-31d1-54fb-b52e-3b5cc693c8af')
    ON CONFLICT (name) DO NOTHING
  `);
  pgm.sql("UPDATE quests SET item_reward = 'power-tinders' WHERE key = 'act1_core_whisper'");
};

exports.down = (pgm) => {
  pgm.sql("UPDATE quests SET item_reward = NULL WHERE key = 'act1_core_whisper' AND item_reward = 'power-tinders'");
  pgm.sql("DELETE FROM item_types WHERE name = 'power-tinders'");
};
