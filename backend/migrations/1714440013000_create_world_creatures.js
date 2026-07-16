exports.up = (pgm) => {
  pgm.createTable('world_creatures', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    type: { type: 'text', notNull: true },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    hp: { type: 'integer', notNull: true, default: 10 },
    facing: { type: 'text', notNull: true, default: 'S' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('world_creatures', 'world_id');
};

exports.down = (pgm) => pgm.dropTable('world_creatures');
