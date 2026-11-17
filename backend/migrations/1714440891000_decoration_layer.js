/* eslint-disable camelcase */
// SOMET-772: decorations get a layer. 'main' is today's behaviour (the clump
// pass; may block). 'ground' is flat cover -- grass tufts, pebbles, leaves --
// placed by its own density pass on tiles the main pass left empty and drawn
// under actors. Ground cover must never block: that is what lets maps look
// fuller without adding obstacles, so the database refuses the combination.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('entity_types', { deco_layer: { type: 'text', notNull: true, default: 'main' } });
  pgm.addConstraint('entity_types', 'entity_types_deco_layer_check', { check: "deco_layer IN ('main', 'ground')" });
  pgm.addConstraint('entity_types', 'entity_types_ground_walkable_check', { check: "deco_layer = 'main' OR walkable = true" });
};

exports.down = (pgm) => {
  pgm.dropConstraint('entity_types', 'entity_types_ground_walkable_check');
  pgm.dropConstraint('entity_types', 'entity_types_deco_layer_check');
  pgm.dropColumns('entity_types', ['deco_layer']);
};
