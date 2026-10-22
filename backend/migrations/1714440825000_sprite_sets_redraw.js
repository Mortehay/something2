exports.shorthands = undefined;

// A "redraw" row re-draws chosen frames of a finished sheet on the GPU box.
//   redraw_of      the sheet row it was made from (SET NULL if that row is deleted)
//   redraw_frames  [{action, direction, frame}] to redraw
//   box_task_id    the box's redraw task, so a restart resumes polling it
// All NULL on ordinary sheet rows.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE sprite_sets
      ADD COLUMN IF NOT EXISTS redraw_of uuid REFERENCES sprite_sets(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS redraw_frames jsonb,
      ADD COLUMN IF NOT EXISTS box_task_id text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE sprite_sets
      DROP COLUMN IF EXISTS redraw_of,
      DROP COLUMN IF EXISTS redraw_frames,
      DROP COLUMN IF EXISTS box_task_id;
  `);
};
