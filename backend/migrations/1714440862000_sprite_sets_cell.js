/* eslint-disable camelcase */
// sprite_sets.cell (SOMET-706): the sheet's cell size the admin asked the GPU
// box for, 'WxH' text. NULL means 48x64, today's size, so existing rows and
// every request that omits the option are unchanged.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('sprite_sets', { cell: { type: 'text' } });
};

exports.down = (pgm) => {
  pgm.dropColumn('sprite_sets', 'cell');
};
