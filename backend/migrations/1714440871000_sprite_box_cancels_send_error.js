/* eslint-disable camelcase */
// A cancel the box never took (SOMET-695): the DELETE's error, kept apart from
// last_progress so the verifier cannot overwrite it, and so a job that simply
// is not moving is not mistaken for one that stopped.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('sprite_box_cancels', { send_error: { type: 'text' } });
};

exports.down = (pgm) => {
  pgm.dropColumn('sprite_box_cancels', 'send_error');
};
