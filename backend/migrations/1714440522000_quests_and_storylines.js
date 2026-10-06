// backend/migrations/1714440522000_quests_and_storylines.js
//
// Creates tables for the 4-act open world non-mandatory story & village side quests:
//   - `quests`: authored catalog of quests, acts 1-4, rewards & NPC keys.
//   - `character_quests`: player quest status (active/completed) & progress.
//   - `legacy_choice` column on `player_progression`: Act IV permanent choice.

exports.up = (pgm) => {
  pgm.createTable('quests', {
    id: { type: 'serial', primaryKey: true },
    key: { type: 'varchar(64)', notNull: true, unique: true },
    act: { type: 'integer', notNull: true },
    title: { type: 'varchar(255)', notNull: true },
    description: { type: 'text', notNull: true },
    village_key: { type: 'varchar(64)' },
    npc_key: { type: 'varchar(64)' },
    required_level: { type: 'integer', notNull: true, default: 1 },
    exp_reward: { type: 'integer', notNull: true, default: 0 },
    gold_reward: { type: 'integer', notNull: true, default: 0 },
    passive_points_reward: { type: 'integer', notNull: true, default: 0 },
    title_reward: { type: 'varchar(64)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('character_quests', {
    character_id: {
      type: 'integer',
      notNull: true,
      references: 'characters',
      onDelete: 'CASCADE',
    },
    quest_id: {
      type: 'integer',
      notNull: true,
      references: 'quests',
      onDelete: 'CASCADE',
    },
    status: { type: 'varchar(32)', notNull: true, default: 'active' },
    progress_count: { type: 'integer', notNull: true, default: 0 },
    completed_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('character_quests', 'character_quests_pkey', {
    primaryKey: ['character_id', 'quest_id'],
  });

  pgm.addColumn('player_progression', {
    legacy_choice: { type: 'varchar(64)', default: null },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('player_progression', 'legacy_choice');
  pgm.dropTable('character_quests');
  pgm.dropTable('quests');
};
