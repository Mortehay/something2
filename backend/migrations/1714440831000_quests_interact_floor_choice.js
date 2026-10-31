// backend/migrations/1714440831000_quests_interact_floor_choice.js
//
// Moves the quests that were 'manual' (turn-in-only) onto real trackers:
//   interact  a quest node (character_quest_nodes), target_key = node group
//   floor     deepest Spire of Trials floor reached
//   choice    the Act IV legacy choice made at turn-in
// and applies the authored target_count / objective text that go with them.
// Idempotent: it rewrites the same authored values every run.
exports.shorthands = undefined;

exports.up = (pgm) => {
  const { QUESTS } = require('../seeds/data/questsData.js');
  for (const q of QUESTS) {
    pgm.sql(
      `UPDATE quests SET objective_type = ${lit(q.objective_type)}, target_key = ${lit(q.target_key)},
              target_count = ${Number(q.target_count) || 1}, objective = ${lit(q.objective)}
        WHERE key = ${lit(q.key)}`,
    );
  }
};

// The previous values are not recoverable per row (they were authored data);
// the old behaviour is restored by re-running the earlier seed.
exports.down = () => {};

function lit(v) {
  return v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
}
