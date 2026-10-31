// backend/migrations/1714440838000_quest_wolfpack_wolves.js
//
// "Hunt of the Dire Wolves" counted ANY kill while no Wolf stood in any world.
// Thornbriar Reach now allows Wolf (vale-region spec), so the quest can name its
// real target again.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE quests
       SET objective_type = 'kill', target_key = 'Wolf', target_count = 10,
           objective = 'Slay 10 Wolves in Thornbriar Reach to draw out the Alpha Packmaster'
     WHERE key = 'act1_dire_wolfpack'
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE quests
       SET objective_type = 'kill_any', target_key = NULL, target_count = 10,
           objective = 'Hunt 10 wild creatures to draw out the Alpha Packmaster'
     WHERE key = 'act1_dire_wolfpack'
  `);
};
