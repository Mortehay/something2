/* eslint-disable camelcase */
// sprite_sets.sampling: the Sprite tab's sampling preset for this row (a key of
// spriteSampling.SAMPLING_PRESETS), or NULL = the box engine's default steps/cfg.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('sprite_sets', { sampling: { type: 'text' } });
};

exports.down = (pgm) => {
  pgm.dropColumn('sprite_sets', 'sampling');
};
