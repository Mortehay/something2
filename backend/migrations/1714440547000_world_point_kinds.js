exports.shorthands = undefined;

// Kinds live in seeds/data/pointTypes.js so this migration and
// `make seed-catalogs` read one list (same discipline as decoration_types).
const { POINT_KINDS } = require('../seeds/data/pointTypes.js');

exports.up = (pgm) => {
  pgm.createTable('world_point_kinds', {
    kind: { type: 'text', primaryKey: true },
    // NULL until seed-catalogs (or an admin) picks a default; a NULL default
    // means "draw the placeholder shape", never an error.
    default_entity_type_id: {
      type: 'integer', notNull: false, references: 'entity_types', onDelete: 'SET NULL',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  for (const kind of POINT_KINDS) {
    pgm.sql(`INSERT INTO world_point_kinds (kind) VALUES ('${kind}') ON CONFLICT (kind) DO NOTHING`);
  }
  // Marks an entity type as art for ONE kind. FK rather than CHECK so a new
  // kind is a row, not a migration.
  pgm.addColumn('entity_types', {
    point_kind: { type: 'text', notNull: false, references: 'world_point_kinds', onDelete: 'SET NULL' },
  });
  pgm.createIndex('entity_types', 'point_kind', { where: 'point_kind IS NOT NULL' });
};

exports.down = (pgm) => {
  pgm.dropColumn('entity_types', 'point_kind');
  pgm.dropTable('world_point_kinds');
};
