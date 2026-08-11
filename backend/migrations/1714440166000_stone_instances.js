exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('stone_instances', {
    player_item_id: { type: 'uuid', primaryKey: true, references: 'player_items', onDelete: 'CASCADE' },
    xp: { type: 'bigint', notNull: true, default: 0 },
    level: { type: 'integer', notNull: true, default: 1 },
    socketed_into_id: { type: 'uuid', notNull: false, references: 'player_items', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('stone_instances', 'stone_instances_xp_check', 'CHECK (xp >= 0)');
  pgm.addConstraint('stone_instances', 'stone_instances_level_check', 'CHECK (level >= 1)');
  // Partial unique index: at most one stone per host. NULLs (unsocketed
  // stones) are excluded by Postgres from a partial unique index's
  // uniqueness check by construction, so many loose stones can coexist.
  pgm.createIndex('stone_instances', 'socketed_into_id', {
    unique: true,
    where: 'socketed_into_id IS NOT NULL',
    name: 'stone_instances_socketed_into_unique',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('stone_instances');
};
