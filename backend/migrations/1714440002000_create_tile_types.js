exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('tile_types', {
    id: 'id',
    name: { type: 'varchar(255)', notNull: true, unique: true },
    color: { type: 'varchar(50)', notNull: true },
    walkable: { type: 'boolean', notNull: true, default: true },
    speed: { type: 'float', notNull: true, default: 1.0 },
    image: { type: 'text', notNull: false, default: '' },
    valid_neighbors: { type: 'jsonb', notNull: true, default: '[]' },
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

  // Seed default tile types
  const defaultTileTypes = {
    grass: {
      color: "#00FF00",
      walkable: true,
      speed: 1,
      image: "",
      validNeighbors: ['grass', 'highgrass', 'leafs', 'sand', 'earth']
    },
    highgrass: {
      color: "#035c03ff",
      walkable: true,
      speed: 0.8,
      image: "",
      validNeighbors: ['highgrass', 'grass', 'leafs', 'swamp']
    },
    leafs: {
      color: "#023b02ff",
      walkable: true,
      speed: 0.8,
      image: "",
      validNeighbors: ['leafs', 'highgrass', 'grass', 'dirt']
    },
    sand: {
      color: "#FFFF00",
      walkable: true,
      speed: 0.6,
      image: "",
      validNeighbors: ['sand', 'grass', 'earth', 'water']
    },
    rocks: {
      color: "#808080",
      walkable: true,
      speed: 0.8,
      image: "",
      validNeighbors: ['rocks', 'earth', 'snow', 'dirt']
    },
    earth: {
      color: "#8B4513",
      walkable: true,
      speed: 1,
      image: "",
      validNeighbors: ['earth', 'grass', 'sand', 'rocks', 'dirt', 'swamp']
    },
    dirt: {
      color: "#301604ff",
      walkable: true,
      speed: 0.6,
      image: "",
      validNeighbors: ['dirt', 'earth', 'rocks', 'leafs', 'swamp']
    },
    snow: {
      color: "#FFFFFF",
      walkable: true,
      speed: 0.5,
      image: "",
      validNeighbors: ['snow', 'rocks', 'ice']
    },
    ice: {
      color: "#bae6fd",
      walkable: true,
      speed: 0.2,
      image: "",
      validNeighbors: ['ice', 'snow', 'water']
    },
    swamp: {
      color: "#4d7c0f",
      walkable: true,
      speed: 0.1,
      image: "",
      validNeighbors: ['swamp', 'earth', 'dirt', 'water', 'highgrass']
    },
    water: {
      color: "#3b82f6",
      walkable: false,
      speed: 0,
      image: "",
      validNeighbors: ['water', 'sand', 'ice', 'swamp']
    },
  };

  Object.entries(defaultTileTypes).forEach(([name, data]) => {
    pgm.sql(`
      INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors)
      VALUES ('${name}', '${data.color}', ${data.walkable}, ${data.speed}, '${data.image}', '${JSON.stringify(data.validNeighbors)}')
    `);
  });
};

exports.down = (pgm) => {
  pgm.dropTable('tile_types');
};
