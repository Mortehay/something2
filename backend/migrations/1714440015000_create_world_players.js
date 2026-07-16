exports.up = (pgm) => {
  pgm.createTable('world_players', {
    world_id: {
      type: 'uuid',
      notNull: true,
      references: 'worlds',
      onDelete: 'CASCADE',
    },
    user_id: { type: 'text', notNull: true },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  }, {
    constraints: { primaryKey: ['world_id', 'user_id'] },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('world_players');
};
