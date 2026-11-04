/* eslint-disable camelcase */
// sprite_sets.sheet_method: how the Sprite tab asked for this row to be drawn
// ('2d' | 'turnaround3d'), or NULL = the connector's request_template decides.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('sprite_sets', { sheet_method: { type: 'text' } });
};

exports.down = (pgm) => {
  pgm.dropColumn('sprite_sets', 'sheet_method');
};
