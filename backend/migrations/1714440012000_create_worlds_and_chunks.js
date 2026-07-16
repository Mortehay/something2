exports.up = (pgm) => {
  pgm.createTable('worlds', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    seed: { type: 'bigint', notNull: true },
    chunk_size: { type: 'integer', notNull: true, default: 64 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTable('world_chunks', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    cx: { type: 'integer', notNull: true },
    cy: { type: 'integer', notNull: true },
    data: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('world_chunks', 'world_chunks_world_cx_cy_unique', {
    unique: ['world_id', 'cx', 'cy'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('world_chunks');
  pgm.dropTable('worlds');
};
