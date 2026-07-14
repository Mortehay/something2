exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('sprite_sets', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    creature: { type: 'text', notNull: true },
    entity_type_id: { type: 'integer', references: 'entity_types', onDelete: 'SET NULL' },
    backend: { type: 'text', notNull: true },
    seed: { type: 'integer', notNull: true, default: 0 },
    frames: { type: 'integer', notNull: true, default: 4 },
    job_id: { type: 'text' },
    atlas_key: { type: 'text' },
    manifest_key: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'queued' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => pgm.dropTable('sprite_sets');
