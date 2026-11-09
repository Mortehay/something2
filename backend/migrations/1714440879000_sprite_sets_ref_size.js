/* eslint-disable camelcase */
// sprite_sets.ref_size: the reference size the box says it drew the sheet at
// (atlas engine.ref_size). NULL = unknown (built before the box reported it, i.e.
// the old 1024 default; HQ has none). Calibration uses only rows at the current
// default so a rate measured at one size never prices a sheet at another.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('sprite_sets', { ref_size: { type: 'smallint' } });
};

exports.down = (pgm) => {
  pgm.dropColumn('sprite_sets', 'ref_size');
};
