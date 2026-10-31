/* eslint-disable camelcase */

exports.shorthands = undefined;

// SOMET-677: a fourth prop idle effect, 'drift' -- the sprite floats a few
// pixels left/right and up/down in slow motion (frontend systems/drift.js).
// Additive only: the CHECKs from 1714440824000 widen, no row changes, and
// every prop keeps the effect it has.
const WITH_DRIFT = "('none','sway','shine','drift')";
const WITHOUT_DRIFT = "('none','sway','shine')";

function setChecks(pgm, values) {
  pgm.sql(`ALTER TABLE entity_types DROP CONSTRAINT IF EXISTS entity_types_idle_fx_check`);
  pgm.sql(`ALTER TABLE entity_types ADD CONSTRAINT entity_types_idle_fx_check CHECK (idle_fx IN ${values})`);
  pgm.sql(`ALTER TABLE sprite_sets DROP CONSTRAINT IF EXISTS sprite_sets_prop_fx_check`);
  pgm.sql(`ALTER TABLE sprite_sets ADD CONSTRAINT sprite_sets_prop_fx_check CHECK (prop_fx IN ${values})`);
}

exports.up = (pgm) => setChecks(pgm, WITH_DRIFT);

// Down cannot keep a drift row under the narrower CHECK; it falls back to the
// plain image ('none'), which is what a renderer without drift would draw.
exports.down = (pgm) => {
  pgm.sql(`UPDATE entity_types SET idle_fx = 'none' WHERE idle_fx = 'drift'`);
  pgm.sql(`UPDATE sprite_sets SET prop_fx = 'none' WHERE prop_fx = 'drift'`);
  setChecks(pgm, WITHOUT_DRIFT);
};
