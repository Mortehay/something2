exports.shorthands = undefined;

// NOT NULL with a default, unlike world_creatures.defense (1714440051000)
// which was deliberately nullable. The distinction is real: a NULL defense
// means "predates level scaling, fall back to the entity type", but there is
// no sensible "no density" -- every world holds some number of creatures, and
// a nullable column would just push a `?? 'normal'` fallback into every
// reader. Existing worlds take 'normal', which on a 64x64 map resolves to
// ~12 scattered creatures against the 2-9 they were authored with.
//
// The CHECK duplicates DENSITY_TIERS' key set in services/densityTiers.js on
// purpose: `make reseed-map` clears every world BEFORE seeding, so a tier
// rejected only in JS would fail after the destruction. Same reasoning as
// worlds_level_band_check and the level_band validation in seeds/mapSpec.js.
exports.up = (pgm) => {
  pgm.addColumns('worlds', {
    density: { type: 'text', notNull: true, default: 'normal' },
  });
  pgm.addConstraint(
    'worlds',
    'worlds_density_check',
    "CHECK (density IN ('dead','sparse','normal','dense','horde','swarm'))",
  );
};

exports.down = (pgm) => {
  pgm.dropConstraint('worlds', 'worlds_density_check');
  pgm.dropColumns('worlds', ['density']);
};
