// backend/migrations/1714440504000_passive_tree.js
//
// Contract slot 1714440504000 (T6). The passive tree's three tables.
//
// passive_edges is UNDIRECTED and stored once, with a_id < b_id enforced by a
// CHECK rather than by convention -- a convention that lives only in the
// seeder is a convention the admin API can break, and a duplicated edge in the
// other direction would double every node's apparent degree in the client.
exports.up = (pgm) => {
  pgm.createTable('passive_nodes', {
    id: 'id',
    key: { type: 'text', notNull: true },
    sector: { type: 'text', notNull: true },
    // 0 = the core disc and the six start nodes, 1..3 = the ring bands.
    ring: { type: 'smallint', notNull: true },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    kind: { type: 'text', notNull: true },
    label: { type: 'text', notNull: true },
    grants: { type: 'jsonb', notNull: true, default: '[]' },
    start_class: { type: 'text', notNull: false, default: null },
  });
  // The generator keys every node stably, and the seeder upserts on this --
  // that is what stops a regeneration orphaning anyone's character_passives.
  pgm.addConstraint('passive_nodes', 'passive_nodes_key_unique', { unique: ['key'] });
  pgm.addConstraint('passive_nodes', 'passive_nodes_kind_check',
    "CHECK (kind IN ('minor','notable','keystone','start'))");
  pgm.addConstraint('passive_nodes', 'passive_nodes_sector_check',
    "CHECK (sector IN ('core','strength','dexterity','constitution','intelligence','wisdom','charisma'))");
  pgm.addConstraint('passive_nodes', 'passive_nodes_ring_check', 'CHECK (ring BETWEEN 0 AND 3)');
  // start_class and kind='start' are the same fact. Letting them disagree
  // would give a class a start node the allocatability walk cannot find, or a
  // start node no class can use -- both silently unplayable.
  pgm.addConstraint('passive_nodes', 'passive_nodes_start_class_check',
    "CHECK ((kind = 'start') = (start_class IS NOT NULL))");
  pgm.createIndex('passive_nodes', 'sector');
  pgm.createIndex('passive_nodes', 'start_class',
    { unique: true, where: 'start_class IS NOT NULL', name: 'passive_nodes_one_start_per_class' });

  pgm.createTable('passive_edges', {
    a_id: { type: 'integer', notNull: true, references: 'passive_nodes', onDelete: 'CASCADE' },
    b_id: { type: 'integer', notNull: true, references: 'passive_nodes', onDelete: 'CASCADE' },
  });
  pgm.addConstraint('passive_edges', 'passive_edges_pkey', { primaryKey: ['a_id', 'b_id'] });
  pgm.addConstraint('passive_edges', 'passive_edges_ordered', 'CHECK (a_id < b_id)');
  // The primary key indexes a_id; the reverse direction needs its own index
  // because every adjacency read walks the edge list in both directions.
  pgm.createIndex('passive_edges', 'b_id');

  pgm.createTable('character_passives', {
    character_id: { type: 'integer', notNull: true, references: 'characters', onDelete: 'CASCADE' },
    node_id: { type: 'integer', notNull: true, references: 'passive_nodes', onDelete: 'CASCADE' },
    allocated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // One point per node, no multi-rank nodes (spec §5.4) -- expressed as the
  // primary key so a double-submit cannot spend two points on one node.
  pgm.addConstraint('character_passives', 'character_passives_pkey',
    { primaryKey: ['character_id', 'node_id'] });
};

exports.down = (pgm) => {
  pgm.dropTable('character_passives');
  pgm.dropTable('passive_edges');
  pgm.dropTable('passive_nodes');
};
