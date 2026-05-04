exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('environment_types', {
    id: 'id',
    name: { type: 'varchar(255)', notNull: true, unique: true },
    color: { type: 'varchar(50)', notNull: true },
    walkable: { type: 'boolean', notNull: true, default: false },
    spawn_tiles: { type: 'jsonb', notNull: true, default: '[]' },
    chance: { type: 'float', notNull: true, default: 0.1 },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  // Seed default environment types
  const defaultEnvTypes = [
    {
      name: 'Tree',
      color: '#006400',
      walkable: false,
      spawn_tiles: ['earth', 'grass', 'leafs', 'dirt'],
      chance: 0.2
    },
    {
      name: 'Stone',
      color: '#A9A9A9',
      walkable: false,
      spawn_tiles: ['earth', 'rocks', 'sand'],
      chance: 0.15
    },
    {
      name: 'IceRock',
      color: '#ADD8E6',
      walkable: false,
      spawn_tiles: ['snow', 'ice'],
      chance: 0.25
    }
  ];

  defaultEnvTypes.forEach(type => {
    pgm.sql(`
      INSERT INTO environment_types (name, color, walkable, spawn_tiles, chance)
      VALUES ('${type.name}', '${type.color}', ${type.walkable}, '${JSON.stringify(type.spawn_tiles)}', ${type.chance})
    `);
  });
};

exports.down = (pgm) => {
  pgm.dropTable('environment_types');
};
