/* eslint-disable camelcase */
// SOMET-773: generated ruin sites, stored on the world row as RESOLVED stamps
// ({ type, minRow, minCol, width, height, wallTile, floorTile, gaps, source }).
// A column rather than a table because every generator call site (/chunk, the
// authority, seed-map's guard, population, the scanners) already loads the
// world row -- six new fetches would be six chances to drift out of parity.
// Resolved, so editing seeds/data/structureTypes.js never moves a live ruin.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('worlds', { structures: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") } });
};

exports.down = (pgm) => {
  pgm.dropColumns('worlds', ['structures']);
};
