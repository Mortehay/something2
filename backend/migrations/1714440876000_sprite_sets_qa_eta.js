/* eslint-disable camelcase */
// sprite_sets.quality_checks / predicted_seconds: the QA choice the row was
// queued with (NULL = legacy, the box's own default, which is on; HQ and prop
// rows also NULL) and the ETA the queue predicted for it, in seconds.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('sprite_sets', {
    quality_checks: { type: 'boolean' },
    predicted_seconds: { type: 'integer', check: 'predicted_seconds IS NULL OR predicted_seconds > 0' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('sprite_sets', ['quality_checks', 'predicted_seconds']);
};
