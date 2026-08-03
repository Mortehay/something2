exports.shorthands = undefined;

exports.up = (pgm) => {
  // Difficulty is authored per world as a band; a creature rolls its level
  // inside it at spawn. Default 1/1 means every existing world keeps exactly
  // the behaviour it has today -- a band of [1,1] scales nothing.
  pgm.addColumns('worlds', {
    level_min: { type: 'integer', notNull: true, default: 1 },
    level_max: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('worlds', 'worlds_level_band_check',
    'CHECK (level_min >= 1 AND level_max >= level_min)');

  // Level is per-INSTANCE, not per-type: the same Wolf is level 2 in a starter
  // meadow and level 14 three floors down.
  pgm.addColumns('world_creatures', {
    level: { type: 'integer', notNull: true, default: 1 },
    // Creature attack damage is currently the flat constant CREATURE_DAMAGE
    // (authority/creatures.js:22) and lives nowhere in the schema, so scaling
    // it needs somewhere to put the result. Persisted at spawn alongside hp so
    // the authority never rescales at runtime.
    damage: { type: 'real', notNull: true, default: 5 },
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('worlds', 'worlds_level_band_check');
  pgm.dropColumns('worlds', ['level_min', 'level_max']);
  pgm.dropColumns('world_creatures', ['level', 'damage']);
};
