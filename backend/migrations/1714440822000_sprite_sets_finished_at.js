exports.shorthands = undefined;

// When a sheet finished generating. updated_at is bumped by approve, so the
// "newest measured sheet" estimate cannot order by it; finished_at is set only
// in spriteJobQueue.complete. Existing finished gpu-box rows are backfilled
// from updated_at (the best available approximation).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE sprite_sets ADD COLUMN IF NOT EXISTS finished_at timestamptz;
    UPDATE sprite_sets SET finished_at = updated_at
     WHERE finished_at IS NULL AND status IN ('done','approved') AND sheet_seconds IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE sprite_sets DROP COLUMN IF EXISTS finished_at');
};
