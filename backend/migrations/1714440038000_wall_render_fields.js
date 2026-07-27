exports.shorthands = undefined;

// Wall rendering: wall_height > 0 makes a tile render as a raised block that
// occludes; place_order is a manual draw-order override (default 0 => pure iso
// depth sort, i.e. today's behavior). Defaults keep every existing tile flat.
exports.up = (pgm) => {
  pgm.addColumns('tile_types', {
    wall_height: { type: 'integer', notNull: true, default: 0 },
    place_order: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addColumns('entity_types', {
    place_order: { type: 'integer', notNull: true, default: 0 },
  });
  // Seed structural tile heights (idempotent — keyed by name).
  pgm.sql(`UPDATE tile_types SET wall_height = 48 WHERE name IN ('map_wall', 'wooden_wall')`);
  pgm.sql(`UPDATE tile_types SET wall_height = 24 WHERE name IN ('village_gate', 'map_doorway')`);
};

exports.down = (pgm) => {
  pgm.dropColumns('tile_types', ['wall_height', 'place_order']);
  pgm.dropColumns('entity_types', ['place_order']);
};
