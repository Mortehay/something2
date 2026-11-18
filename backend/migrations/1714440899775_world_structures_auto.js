/* eslint-disable camelcase */
// SOMET-775: a map spec may turn automatic ruin/monument sites off for a world
// (`structures_auto: false`). Stored on the world row so every later
// ensureStructures run -- seed-structures, the admin regenerate route,
// invalidateWorld -- honours it, not only the seed-map run that read the spec.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('worlds', { structures_auto: { type: 'boolean', notNull: true, default: true } });
};

exports.down = (pgm) => {
  pgm.dropColumns('worlds', ['structures_auto']);
};
