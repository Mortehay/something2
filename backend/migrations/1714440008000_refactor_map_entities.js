/* eslint-disable no-undef */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Drop the old JSONB-blob table; data is regenerable via /api/maps/:id/generate-entities.
  pgm.dropTable('map_entities', { ifExists: true });

  pgm.createTable('map_entities', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    map_id: {
      type: 'uuid',
      notNull: true,
      references: 'maps(id)',
      onDelete: 'CASCADE',
    },
    type: {
      type: 'varchar(16)',
      notNull: true,                     // 'player' | 'mob' | 'obstacle'
    },
    entity_type_id: {
      type: 'integer',
      references: 'entity_types(id)',
      onDelete: 'SET NULL',
    },
    external_id: { type: 'varchar(64)' },
    x: { type: 'double precision', notNull: true },
    y: { type: 'double precision', notNull: true },
    hp: { type: 'integer' },
    data: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.addConstraint('map_entities', 'map_entities_unique_per_external', {
    unique: ['map_id', 'type', 'external_id'],
  });
  pgm.createIndex('map_entities', ['map_id', 'type']);
};

exports.down = (pgm) => {
  pgm.dropTable('map_entities');

  // Restore the JSONB-blob shape for downgrade safety.
  pgm.createTable('map_entities', {
    map_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'maps(id)',
      onDelete: 'CASCADE',
    },
    data: { type: 'jsonb', notNull: true },
  });
};
