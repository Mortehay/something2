exports.shorthands = undefined;

exports.up = (pgm) => {
  // Live player position snapshots written by the Go engine's flush ticker.
  // map_id is uuid because maps.id is uuid (see 1714440000000_create-maps.js).
  pgm.createTable('engine_players', {
    user_id: { type: 'integer', primaryKey: true },
    map_id: { type: 'uuid', notNull: true, references: 'maps(id)', onDelete: 'CASCADE' },
    x: { type: 'double precision', notNull: true, default: 0 },
    y: { type: 'double precision', notNull: true, default: 0 },
    hp: { type: 'integer', notNull: true, default: 100 },
    last_seen: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('engine_players', 'map_id');

  // Live mob/NPC snapshots. id is engine-assigned and stable across flushes.
  pgm.createTable('engine_mobs', {
    id: { type: 'bigint', primaryKey: true },
    entity_type_id: { type: 'integer', notNull: true, references: 'entity_types(id)', onDelete: 'CASCADE' },
    map_id: { type: 'uuid', notNull: true, references: 'maps(id)', onDelete: 'CASCADE' },
    x: { type: 'double precision', notNull: true, default: 0 },
    y: { type: 'double precision', notNull: true, default: 0 },
    hp: { type: 'integer', notNull: true, default: 0 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('engine_mobs', 'map_id');
  pgm.createIndex('engine_mobs', 'entity_type_id');
};

exports.down = (pgm) => {
  pgm.dropTable('engine_mobs');
  pgm.dropTable('engine_players');
};
