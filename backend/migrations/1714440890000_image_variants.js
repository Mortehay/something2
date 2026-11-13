/* eslint-disable camelcase */
// Image shrink: WebP "web copies" of game art. image_variants holds one row per
// (table, key, column) subject -- the original stays in place and untouched; the
// row records the web copy that is served instead while `active`. A sprite sheet
// has an atlas + manifest pair (web_sprite) instead of a single web_key.
// image_operations is the append-only log behind the admin tab's history/undo.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('image_variants', {
    id: 'id',
    sync_uuid: { type: 'uuid', notNull: true, unique: true, default: pgm.func('gen_random_uuid()') },
    subject_table: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    subject_column: { type: 'text', notNull: true },
    original_key: { type: 'text' },
    original_etag: { type: 'text' },
    web_key: { type: 'text' },
    web_sprite: { type: 'jsonb' }, // { atlas_key, manifest_key }
    active: { type: 'boolean', notNull: true, default: true },
    params: { type: 'jsonb', notNull: true },
    original_bytes: { type: 'integer' },
    web_bytes: { type: 'integer' },
    original_width: { type: 'integer' },
    original_height: { type: 'integer' },
    web_width: { type: 'integer' },
    web_height: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('image_variants', 'image_variants_subject_unique',
    { unique: ['subject_table', 'subject_key', 'subject_column'] });
  pgm.addConstraint('image_variants', 'image_variants_web_one_check',
    { check: '(web_key IS NULL) <> (web_sprite IS NULL)' });

  pgm.createTable('image_operations', {
    id: { type: 'bigserial', primaryKey: true },
    op: { type: 'text', notNull: true },
    subject_table: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    subject_column: { type: 'text', notNull: true },
    original_key: { type: 'text' },
    web_key: { type: 'text' },
    params: { type: 'jsonb' },
    bytes_before: { type: 'integer' },
    bytes_after: { type: 'integer' },
    actor: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    batch_id: { type: 'uuid' },
    status: { type: 'text', notNull: true },
    error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('image_operations', 'image_operations_op_check',
    { check: "op IN ('shrink','undo','reactivate')" });
  pgm.addConstraint('image_operations', 'image_operations_status_check',
    { check: "status IN ('ok','failed')" });
  pgm.createIndex('image_operations', [{ name: 'created_at', sort: 'DESC' }]);
  pgm.createIndex('image_operations', 'batch_id');
};

exports.down = (pgm) => {
  pgm.dropTable('image_operations');
  pgm.dropTable('image_variants');
};
