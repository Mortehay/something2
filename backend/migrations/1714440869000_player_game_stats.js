// backend/migrations/1714440869000_player_game_stats.js
//
// SOMET-720. Lifetime play statistics per character, shown on the Orange Pi tab.
// The authority keeps counters in memory and flushes deltas here in batches
// (authority/gameStats.js), never per kill. A player table: excluded from seed
// export (services/seedSync/coverage.js) and from every board seed group.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('player_game_stats', {
    character_id: { type: 'integer', primaryKey: true, references: 'characters', onDelete: 'CASCADE' },
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    mob_kills: { type: 'bigint', notNull: true, default: 0 },
    pvp_kills: { type: 'bigint', notNull: true, default: 0 },
    deaths: { type: 'bigint', notNull: true, default: 0 },
    boss_kills: { type: 'bigint', notNull: true, default: 0 },
    play_seconds: { type: 'bigint', notNull: true, default: 0 },
    sessions: { type: 'integer', notNull: true, default: 0 },
    last_seen_at: { type: 'timestamptz', notNull: false, default: null },
  });
  pgm.createIndex('player_game_stats', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropTable('player_game_stats');
};
