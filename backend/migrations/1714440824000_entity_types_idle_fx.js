exports.shorthands = undefined;

// Props v2: a GPU-box prop is one clean static image; the game renderer gives
// it a procedural idle effect (frontend systems/sway.js, shine.js): 'sway' (wind shear about
// the base) or 'shine' (a glint sweeping across the opaque pixels).
// sprite_sets.prop_fx is the effect chosen when the prop was queued; approve
// copies it onto entity_types.idle_fx. NULL on creature rows (no effect).
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE entity_types ADD COLUMN IF NOT EXISTS idle_fx text NOT NULL DEFAULT 'none'
             CONSTRAINT entity_types_idle_fx_check CHECK (idle_fx IN ('none','sway','shine'))`);
  pgm.sql(`ALTER TABLE sprite_sets ADD COLUMN IF NOT EXISTS prop_fx text
             CONSTRAINT sprite_sets_prop_fx_check CHECK (prop_fx IN ('none','sway','shine'))`);
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE sprite_sets DROP COLUMN IF EXISTS prop_fx');
  pgm.sql('ALTER TABLE entity_types DROP COLUMN IF EXISTS idle_fx');
};
