exports.shorthands = undefined;

exports.up = (pgm) => {
  // Per-object render mode. 'rect' is the default so maps render fast and
  // images/sprites are opt-in per entity type. Existing rows that already
  // reference an image are migrated to 'static' so their sprites keep showing.
  pgm.addColumn('entity_types', {
    render_mode: { type: 'text', notNull: true, default: 'rect' },
  });
  pgm.sql("UPDATE entity_types SET render_mode = 'static' WHERE image IS NOT NULL AND image <> ''");
};

exports.down = (pgm) => pgm.dropColumn('entity_types', 'render_mode');
