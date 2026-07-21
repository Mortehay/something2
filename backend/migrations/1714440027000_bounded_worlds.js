exports.shorthands = undefined;

// Two tile types that make a world's boundary: a solid wall and a passable
// doorway. Colors are plain hex; no single quotes so direct SQL interpolation
// is safe (matches the create_tile_types seed style).
const MAP_TILE_TYPES = [
  { name: 'map_wall', color: '#2b2b2b', walkable: false, speed: 1.0 },
  { name: 'map_doorway', color: '#6b4f2a', walkable: true, speed: 1.0 },
];

exports.up = (pgm) => {
  pgm.addColumns('worlds', {
    width: { type: 'integer', notNull: false },
    height: { type: 'integer', notNull: false },
    creature_count: { type: 'integer', notNull: true, default: 0 },
    allowed_creature_types: { type: 'jsonb', notNull: true, default: '[]' },
    is_entry: { type: 'boolean', notNull: true, default: false },
    entry_spawn: { type: 'jsonb', notNull: false },
  });

  // Idempotent seed: skip a name that already exists (ON CONFLICT on the unique
  // `name`). valid_neighbors is '[]' — these tiles are stamped, not WFC-placed.
  for (const t of MAP_TILE_TYPES) {
    pgm.sql(
      `INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors)
       VALUES ('${t.name}', '${t.color}', ${t.walkable}, ${t.speed}, '', '[]')
       ON CONFLICT (name) DO NOTHING`
    );
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM tile_types WHERE name IN ('map_wall', 'map_doorway')`);
  pgm.dropColumns('worlds', [
    'width', 'height', 'creature_count', 'allowed_creature_types', 'is_entry', 'entry_spawn',
  ]);
};

exports.MAP_TILE_TYPES = MAP_TILE_TYPES;
