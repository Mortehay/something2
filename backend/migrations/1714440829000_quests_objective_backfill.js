// backend/migrations/1714440829000_quests_objective_backfill.js
//
// BUG FIX for 1714440827000. That migration added quests.objective_type with
// DEFAULT 'manual', and 'manual' means "turning the quest in is the proof".
// Every quest row that existed before the seeder was re-run therefore became
// manual and was marked 50/50 the moment it was accepted.
//
//   1. Backfill the real objective types from the authored catalog, so a
//      database that has not been re-seeded is correct anyway.
//   2. Drop the default. A new row must now say what it tracks (the seeder
//      always does); the column stays NOT NULL, so a forgotten value fails
//      loudly instead of silently granting free completions.
//
// is_side / repeat_kind exist only after 1714440828000, so they are written
// only when present.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  const { QUESTS } = require('../seeds/data/questsData.js');
  for (const q of QUESTS) {
    pgm.sql(
      `UPDATE quests SET objective_type = ${lit(q.objective_type)}, target_key = ${lit(q.target_key)}
        WHERE key = ${lit(q.key)}`,
    );
  }
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'quests' AND column_name = 'is_side') THEN
        ${QUESTS.map((q) => `UPDATE quests SET is_side = ${q.is_side ? 'true' : 'false'}, repeat_kind = ${lit(q.repeat_kind || 'none')} WHERE key = ${lit(q.key)};`).join('\n        ')}
      END IF;
    END $$;
  `);
  pgm.sql('ALTER TABLE quests ALTER COLUMN objective_type DROP DEFAULT');
};

exports.down = (pgm) => {
  pgm.sql("ALTER TABLE quests ALTER COLUMN objective_type SET DEFAULT 'manual'");
};

// Seed values are authored constants, but quote them properly regardless.
function lit(v) {
  return v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
}
