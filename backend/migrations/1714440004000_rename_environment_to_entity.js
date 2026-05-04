exports.shorthands = undefined;

exports.up = (pgm) => {
  // Rename environment_types to entity_types
  pgm.renameTable('environment_types', 'entity_types');
  
  // Rename map_environments to map_entities
  pgm.renameTable('map_environments', 'map_entities');
};

exports.down = (pgm) => {
  pgm.renameTable('entity_types', 'environment_types');
  pgm.renameTable('map_entities', 'map_environments');
};
