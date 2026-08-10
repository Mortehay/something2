exports.shorthands = undefined;

// Fog of war (SOMET-263). The player's World Map shows only the worlds THIS
// character has entered, plus anonymous stubs for their directly-linked
// neighbours -- so the graph reveals the shape of what has been explored
// without spoiling what lies past the next door.
//
// Per character, not per account: two characters on one account explore
// independently, which is the whole point of having eight of them.
exports.up = (pgm) => {
  pgm.createTable('character_visited_worlds', {
    character_id: { type: 'integer', notNull: true, references: 'characters', onDelete: 'CASCADE' },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    first_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  }, {
    constraints: { primaryKey: ['character_id', 'world_id'] },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('character_visited_worlds');
};
