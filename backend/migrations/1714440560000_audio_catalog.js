exports.shorthands = undefined;

// Game audio slice 1 (spec docs/superpowers/specs/2026-09-28-game-audio-design.md §1-2).
//
// MODALITY: the same ai_providers table now holds image services AND the GPU
// box's audio service. The single-active index becomes single-active PER
// MODALITY, so activating the audio profile no longer deactivates the image one.
//
// Bindings key subjects by NAME (worlds.name, biomes.name, ...), never by id,
// for the same reason catalog_art does: a reseed renumbers ids, names survive.
exports.up = (pgm) => {
  pgm.addColumns('ai_providers', {
    modality: { type: 'text', notNull: true, default: 'image' },
  });
  pgm.addConstraint('ai_providers', 'ai_providers_modality_check', {
    check: "modality IN ('image', 'audio')",
  });
  pgm.sql('DROP INDEX IF EXISTS ai_providers_single_active_index');
  pgm.sql(`
    CREATE UNIQUE INDEX ai_providers_single_active_per_modality
      ON ai_providers (modality) WHERE is_active
  `);

  pgm.createTable('audio_clips', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    kind: { type: 'text', notNull: true, check: "kind IN ('music', 'ambience', 'sfx')" },
    label: { type: 'text', notNull: true },
    storage_key: { type: 'text', notNull: true, unique: true },
    bytes: { type: 'integer', notNull: true },
    duration_ms: { type: 'integer', notNull: true },
    loopable: { type: 'boolean', notNull: true, default: false },
    loop_start_ms: { type: 'integer' },
    loop_end_ms: { type: 'integer' },
    source: { type: 'text', notNull: true, check: "source IN ('generated', 'uploaded', 'seeded')" },
    provider_id: { type: 'integer', references: 'ai_providers', onDelete: 'SET NULL' },
    prompt: { type: 'text' },
    style_or_cue: { type: 'text' },
    engine: { type: 'text' },
    seed: { type: 'bigint' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('audio_bindings', {
    id: { type: 'serial', primaryKey: true },
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    slot: { type: 'text', notNull: true },
    clip_id: { type: 'uuid', notNull: true, references: 'audio_clips', onDelete: 'CASCADE' },
    volume: { type: 'real', notNull: true, default: 1, check: 'volume >= 0 AND volume <= 1' },
    weight: { type: 'real', notNull: true, default: 1, check: 'weight > 0' },
    sort: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('audio_bindings', 'audio_bindings_unique',
    { unique: ['subject_kind', 'subject_key', 'slot', 'clip_id'] });
  pgm.createIndex('audio_bindings', ['subject_kind', 'subject_key']);

  pgm.createTable('audio_misses', {
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    slot: { type: 'text', notNull: true },
    world: { type: 'text' },
    count: { type: 'integer', notNull: true, default: 1 },
    first_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('audio_misses', 'audio_misses_pkey',
    { primaryKey: ['subject_kind', 'subject_key', 'slot'] });
};

exports.down = (pgm) => {
  pgm.dropTable('audio_misses');
  pgm.dropTable('audio_bindings');
  pgm.dropTable('audio_clips');
  pgm.sql('DROP INDEX IF EXISTS ai_providers_single_active_per_modality');
  pgm.sql(`
    CREATE UNIQUE INDEX ai_providers_single_active_index
      ON ai_providers ((true)) WHERE is_active
  `);
  pgm.dropConstraint('ai_providers', 'ai_providers_modality_check');
  pgm.dropColumns('ai_providers', ['modality']);
};
