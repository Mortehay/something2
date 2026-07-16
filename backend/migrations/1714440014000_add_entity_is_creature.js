exports.up = (pgm) => {
  pgm.addColumn('entity_types', {
    is_creature: { type: 'boolean', notNull: true, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('entity_types', 'is_creature');
};
