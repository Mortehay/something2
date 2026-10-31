// backend/migrations/1714440834000_quests_objective_retarget.js
//
// Re-applies the authored objective type / target / count / text for every
// quest. Needed because 1714440831000 had already run when the catalogue was
// corrected: "Cultist" is a PLAYABLE CLASS (no such creature exists, so those
// kill quests could never finish) and no Wolf is placed in any world. They are
// now kill_any quests. Idempotent: it only rewrites authored values.
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

exports.down = () => {};

function lit(v) {
  return v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
}
