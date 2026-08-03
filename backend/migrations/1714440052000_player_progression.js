exports.shorthands = undefined;

// Its own table rather than nine more columns on `users`. users.gold sets a
// precedent for game state on the auth row, but XP + level + points + six
// stats is a different order of magnitude, and the authority already joins
// per-user rows on join for equipment.
exports.up = (pgm) => {
  pgm.createTable('player_progression', {
    user_id: {
      type: 'integer',
      primaryKey: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    experience: { type: 'bigint', notNull: true, default: 0 },
    level: { type: 'integer', notNull: true, default: 1 },
    stat_points: { type: 'integer', notNull: true, default: 0 },
    strength: { type: 'integer', notNull: true, default: 5 },
    dexterity: { type: 'integer', notNull: true, default: 5 },
    constitution: { type: 'integer', notNull: true, default: 5 },
    intelligence: { type: 'integer', notNull: true, default: 5 },
    wisdom: { type: 'integer', notNull: true, default: 5 },
    charisma: { type: 'integer', notNull: true, default: 5 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Database-level floors. The service layer enforces these too, but a
  // constraint is what makes a bad UPDATE fail loudly instead of leaving a
  // character with negative XP or -3 strength that every later read trusts.
  pgm.addConstraint('player_progression', 'player_progression_experience_check',
    'CHECK (experience >= 0)');
  pgm.addConstraint('player_progression', 'player_progression_level_check',
    'CHECK (level >= 1 AND level <= 50)');
  pgm.addConstraint('player_progression', 'player_progression_points_check',
    'CHECK (stat_points >= 0)');
  // Stats can never drop below the base -- a respec resets TO the base, and
  // nothing else lowers them.
  pgm.addConstraint('player_progression', 'player_progression_stats_check',
    `CHECK (strength >= 5 AND dexterity >= 5 AND constitution >= 5
            AND intelligence >= 5 AND wisdom >= 5 AND charisma >= 5)`);

  // Backfill: every existing account gets a level-1 row, so no code path has
  // to distinguish "old account" from "new account". Accounts created after
  // this migration are covered by progressionStore.loadProgression's
  // ON CONFLICT DO NOTHING insert, not by the registration route -- one lazy
  // path serves every way a user can come into existence.
  pgm.sql(`INSERT INTO player_progression (user_id)
           SELECT id FROM users
           ON CONFLICT (user_id) DO NOTHING`);
};

exports.down = (pgm) => {
  pgm.dropTable('player_progression');
};
