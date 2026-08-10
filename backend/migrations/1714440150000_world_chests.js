exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('world_chests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    kind: { type: 'text', notNull: true },
    guard_entity_type_id: { type: 'integer', notNull: true, references: 'entity_types', onDelete: 'CASCADE' },
    guard_level: { type: 'integer', notNull: true },
    guard_creature_ids: { type: 'jsonb', notNull: true, default: '[]' },
    state: { type: 'text', notNull: true, default: 'locked' },
    opened_at: { type: 'timestamptz' },
    respawn_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('world_chests', 'world_chests_kind_check', "CHECK (kind IN ('vault','field'))");
  pgm.addConstraint('world_chests', 'world_chests_state_check',
    "CHECK (state IN ('locked','unlocked','opened'))");
  pgm.addConstraint('world_chests', 'world_chests_level_check', 'CHECK (guard_level >= 1)');
  pgm.createIndex('world_chests', ['world_id', 'state']);
};

exports.down = (pgm) => {
  pgm.dropTable('world_chests');
};
