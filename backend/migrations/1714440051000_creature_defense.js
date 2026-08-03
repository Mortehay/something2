exports.shorthands = undefined;

exports.up = (pgm) => {
  // NULLABLE with no default, deliberately. NULL means "this row predates
  // level scaling -- fall back to the entity type's base defense", which is
  // exactly today's behaviour, so existing creatures are untouched. A default
  // of 0 would instead strip defense from every creature already in the world.
  pgm.addColumns('world_creatures', {
    defense: { type: 'real' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('world_creatures', ['defense']);
};
