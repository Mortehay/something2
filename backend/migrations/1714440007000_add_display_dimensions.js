exports.up = (pgm) => {
  pgm.addColumns('entity_types', {
    display_width: { type: 'integer' },
    display_height: { type: 'integer' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('entity_types', ['display_width', 'display_height']);
};
