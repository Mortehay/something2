exports.up = (pgm) => {
  pgm.createTable('creature_drops', {
    id: 'id',
    entity_type_id: { type: 'integer', notNull: true, references: 'entity_types', onDelete: 'CASCADE' },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    chance: { type: 'numeric', notNull: true },
    min_qty: { type: 'integer', notNull: true, default: 1 },
    max_qty: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('creature_drops', 'creature_drops_chance_check', 'CHECK (chance > 0 AND chance <= 1)');
  pgm.addConstraint('creature_drops', 'creature_drops_qty_check', 'CHECK (min_qty >= 1 AND max_qty >= min_qty)');
  pgm.createIndex('creature_drops', 'entity_type_id');

  pgm.createTable('world_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
  });
  pgm.createIndex('world_items', ['world_id', 'x', 'y']);
  pgm.createIndex('world_items', 'expires_at');

  // Demo drop so the feature is exercisable on a fresh DB. Guarded: if either
  // the Wolf entity type or the dagger item type is absent this inserts
  // nothing rather than failing the migration (same posture as
  // grantStartingLoadout skipping a missing catalog name).
  pgm.sql(`
    INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty)
    SELECT et.id, it.id, 0.5, 1, 1
    FROM entity_types et, item_types it
    WHERE et.name = 'Wolf' AND it.name = 'dagger'
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('world_items');
  pgm.dropTable('creature_drops');
};
