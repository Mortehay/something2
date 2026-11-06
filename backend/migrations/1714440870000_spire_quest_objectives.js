// backend/migrations/1714440870000_spire_quest_objectives.js
//
// Two Act IV Spire quests promised more than they checked.
//
//   act4_primordial_cleansing  "Defeat 12 Empowered Heavy Elites in Spire of Trials"
//     was objective 'kill_any': ANY 12 kills anywhere counted. It is now
//     'kill_spire': a kill of the Spire's heavy packs (the "... Line" creatures)
//     on a Spire floor, and nothing else. Text now says what is checked.
//   act4_elemental_crucible    "... withstand consecutive waves of empowered
//     elemental bosses"
//     only ever checked the deepest floor reached. The text now says that.
//
// Idempotent, and written so a later re-run of the quests seed agrees with it.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE quests SET
      objective_type = 'kill_spire',
      objective = 'Defeat 12 heavy enemies in the Spire of Trials',
      description = 'Prove your combat dominance by vanquishing 12 of the heavy elite packs that patrol the Spire of Trials.'
    WHERE key = 'act4_primordial_cleansing'
  `);
  pgm.sql(`
    UPDATE quests SET
      description = 'Ascend to floor 25 of the Spire of Trials.'
    WHERE key = 'act4_elemental_crucible'
  `);
};

// The previous wording and objective are not recoverable per row (authored data).
exports.down = () => {};
