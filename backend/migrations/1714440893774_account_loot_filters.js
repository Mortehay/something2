exports.shorthands = undefined;

// The in-game loot filter (rules + presets) is ACCOUNT state: one row per user, the whole
// config as jsonb. It is validated on every write by authority/lootFilter.js#sanitizeConfig, so
// the column never holds anything the evaluator cannot read. A missing row means "no filter yet"
// and reads as the default (one empty preset), so no backfill is needed.

exports.up = (pgm) => {
  pgm.createTable('account_loot_filters', {
    user_id: { type: 'integer', primaryKey: true, references: 'users', onDelete: 'CASCADE' },
    config: { type: 'jsonb', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('account_loot_filters');
};
