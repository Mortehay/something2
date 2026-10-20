// backend/migrations/1714440820000_sprite_sets_box_sheets.js
//
// GPU-box sprite sheets. A sprite_sets row now describes one box sheet job:
// which actions and facings were asked for, how many frames per action, the
// concept image the box drew it from, the box's own job id, and how long the
// sheet took (the next estimate is seconds-per-cell from the last done row).
// All nullable: legacy rows (sprite-gen, single-entity generators) have none.
// No CHECK constraint exists on `frames` or `backend` (see
// 1714440009000 / 1714440690000), so 'gpu-box' and frames up to 6 need no
// widening here.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE sprite_sets
      ADD COLUMN IF NOT EXISTS actions text[],
      ADD COLUMN IF NOT EXISTS directions text[],
      ADD COLUMN IF NOT EXISTS frames_per_action integer,
      ADD COLUMN IF NOT EXISTS concept_key text,
      ADD COLUMN IF NOT EXISTS box_job_id text,
      ADD COLUMN IF NOT EXISTS sheet_seconds integer
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE sprite_sets
      DROP COLUMN IF EXISTS actions,
      DROP COLUMN IF EXISTS directions,
      DROP COLUMN IF EXISTS frames_per_action,
      DROP COLUMN IF EXISTS concept_key,
      DROP COLUMN IF EXISTS box_job_id,
      DROP COLUMN IF EXISTS sheet_seconds
  `);
};
