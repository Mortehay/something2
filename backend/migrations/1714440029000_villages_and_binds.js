exports.shorthands = undefined;

const VILLAGE_TILE_TYPES = [
  { name: 'wooden_wall', color: '#6b4a2a', walkable: false, speed: 1.0 },
  { name: 'village_gate', color: '#c9a24b', walkable: true, speed: 1.0 },
];

exports.up = (pgm) => {
  pgm.createTable('villages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    min_row: { type: 'integer', notNull: true },
    min_col: { type: 'integer', notNull: true },
    width: { type: 'integer', notNull: true },
    height: { type: 'integer', notNull: true },
    gate_edge: { type: 'char(1)', notNull: true, check: "gate_edge IN ('N','E','S','W')" },
    spawn_x: { type: 'real', notNull: true },
    spawn_y: { type: 'real', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('villages', 'world_id');

  pgm.createTable('player_binds', {
    user_id: { type: 'integer', primaryKey: true, references: 'users', onDelete: 'CASCADE' },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  for (const t of VILLAGE_TILE_TYPES) {
    pgm.sql(
      `INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors)
       VALUES ('${t.name}', '${t.color}', ${t.walkable}, ${t.speed}, '', '[]')
       ON CONFLICT (name) DO NOTHING`
    );
  }
};

exports.down = (pgm) => {
  pgm.dropTable('player_binds');
  pgm.dropTable('villages');
  pgm.sql("DELETE FROM tile_types WHERE name IN ('wooden_wall','village_gate')");
};
