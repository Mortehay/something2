/* eslint-disable camelcase */
// sprite_sets.real_western: true only when the admin explicitly chose a western
// direction (w, nw or sw) for the sheet, so the game may draw that row instead
// of mirroring east. Pre-SOMET-669 rows also list w/nw/sw in `directions`, but
// those rows are broken (SOMET-659), so the list alone cannot be trusted.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('sprite_sets', { real_western: { type: 'boolean', notNull: true, default: false } });
};

exports.down = (pgm) => {
  pgm.dropColumn('sprite_sets', 'real_western');
};
