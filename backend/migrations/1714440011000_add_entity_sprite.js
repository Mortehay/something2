exports.shorthands = undefined;

exports.up = (pgm) => {
  // Descriptor for a generated sprite set linked to this entity type:
  // { atlas_key, manifest_key, static_frame }. The game loads the atlas image
  // and crops the named frame (atlas + manifest crop) for static/animated modes.
  pgm.addColumn('entity_types', {
    sprite: { type: 'jsonb', notNull: false },
  });
};

exports.down = (pgm) => pgm.dropColumn('entity_types', 'sprite');
