// Per-biome multiplier on the creature density field (SOMET-350, Slice A).
//
// Biomes already gate WHICH creature types may spawn (biomes.creature_types);
// this gates HOW MANY. 1.0 is "no opinion", so every existing row keeps the
// behaviour it has today and the column can never silently thin a world that
// was authored before it existed.
//
// NOT NULL with a default rather than nullable: a null would have to be
// defaulted at three separate read sites, and one of them would eventually be
// forgotten.
exports.up = (pgm) => {
  pgm.addColumn('biomes', {
    creature_density: { type: 'real', notNull: true, default: 1.0 },
  });
};

exports.down = (pgm) => pgm.dropColumn('biomes', 'creature_density');
