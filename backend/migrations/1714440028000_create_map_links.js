exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('map_links', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    from_world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    edge: { type: 'text', notNull: true, check: "edge IN ('N','E','S','W')" },
    to_world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('map_links', 'map_links_from_edge_unique', { unique: ['from_world_id', 'edge'] });
  pgm.createIndex('map_links', 'from_world_id');
};

exports.down = (pgm) => pgm.dropTable('map_links');
