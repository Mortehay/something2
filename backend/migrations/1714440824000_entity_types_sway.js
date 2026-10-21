exports.shorthands = undefined;

// Props v2: a GPU-box prop is one clean static image; the game renderer sways
// it procedurally when this is true (set by sprite approve from the row's
// queued actions -- 'sway' among them).
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE entity_types ADD COLUMN IF NOT EXISTS sway boolean NOT NULL DEFAULT false');
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE entity_types DROP COLUMN IF EXISTS sway');
};
