exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('map_links', {
    from_x: { type: 'real' },
    from_y: { type: 'real' },
    to_x: { type: 'real' },
    to_y: { type: 'real' },
  });

  // Widen the edge check to admit PORTAL alongside the four compass values.
  pgm.dropConstraint('map_links', 'map_links_edge_check');
  pgm.addConstraint('map_links', 'map_links_edge_check',
    "CHECK (edge IN ('N','E','S','W','PORTAL'))");

  // Compass rows keep from_x/from_y/to_x/to_y NULL; portal rows require all
  // four. This is what stops a portal from silently missing its arrival
  // point, and stops a compass row from silently carrying meaningless
  // coordinates that some future reader might mistake for real data.
  pgm.addConstraint('map_links', 'map_links_portal_coords_check', `CHECK (
    (edge = 'PORTAL' AND from_x IS NOT NULL AND from_y IS NOT NULL
                     AND to_x   IS NOT NULL AND to_y   IS NOT NULL)
    OR
    (edge != 'PORTAL' AND from_x IS NULL AND from_y IS NULL
                      AND to_x   IS NULL AND to_y   IS NULL)
  )`);

  // UNIQUE(from_world_id, edge) cannot survive branching -- one world can now
  // have many outgoing PORTAL rows. Split into two partial indexes instead
  // of reshaping the constraint: the compass one is byte-for-byte the
  // guarantee that existed before (at most one N/E/S/W per world), untouched
  // by anything portal-related. The portal one is the analogous guarantee at
  // tile granularity: at most one destination wired to any given source
  // tile -- you cannot wire two rooms to the same staircase.
  pgm.dropConstraint('map_links', 'map_links_from_edge_unique');
  pgm.createIndex('map_links', ['from_world_id', 'edge'], {
    name: 'map_links_compass_unique', unique: true, where: "edge != 'PORTAL'",
  });
  pgm.createIndex('map_links', ['from_world_id', 'from_x', 'from_y'], {
    name: 'map_links_portal_source_unique', unique: true, where: "edge = 'PORTAL'",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('map_links', ['from_world_id', 'from_x', 'from_y'],
    { name: 'map_links_portal_source_unique' });
  pgm.dropIndex('map_links', ['from_world_id', 'edge'], { name: 'map_links_compass_unique' });
  pgm.addConstraint('map_links', 'map_links_from_edge_unique', { unique: ['from_world_id', 'edge'] });
  pgm.dropConstraint('map_links', 'map_links_portal_coords_check');
  pgm.dropConstraint('map_links', 'map_links_edge_check');
  pgm.addConstraint('map_links', 'map_links_edge_check', "CHECK (edge IN ('N','E','S','W'))");
  pgm.dropColumns('map_links', ['from_x', 'from_y', 'to_x', 'to_y']);
};
