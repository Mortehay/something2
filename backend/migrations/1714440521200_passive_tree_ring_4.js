exports.up = (pgm) => {
  pgm.dropConstraint('passive_nodes', 'passive_nodes_ring_check', { ifExists: true });
  pgm.addConstraint('passive_nodes', 'passive_nodes_ring_check', 'CHECK (ring BETWEEN 0 AND 4)');
};

exports.down = (pgm) => {
  pgm.dropConstraint('passive_nodes', 'passive_nodes_ring_check', { ifExists: true });
  pgm.addConstraint('passive_nodes', 'passive_nodes_ring_check', 'CHECK (ring BETWEEN 0 AND 3)');
};
