exports.shorthands = undefined;

// Game audio slice 2 (spec §1 audio_jobs, §2 Dispatcher). Modelled on art_jobs
// (1714440530000 + 540000): a job is one (subject, slot) generation; the
// partial unique index makes enqueue idempotent while a slot is queued or
// running; drain_group is what the dispatcher orders by so the GPU box
// switches model at most once per group (music, then ambience; slice 3 adds
// sfx_realistic and sfx_retro).
exports.up = (pgm) => {
  pgm.createTable('audio_jobs', {
    id: 'bigserial',
    batch_id: { type: 'uuid', notNull: true },
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    slot: { type: 'text', notNull: true },
    clip_kind: { type: 'text', notNull: true, check: "clip_kind IN ('music', 'ambience', 'sfx')" },
    drain_group: {
      type: 'text', notNull: true,
      check: "drain_group IN ('music', 'ambience', 'sfx_realistic', 'sfx_retro')",
    },
    style: { type: 'text' },
    prompt: { type: 'text' },
    slots: { type: 'jsonb' },
    provider_id: { type: 'integer', references: 'ai_providers', onDelete: 'SET NULL' },
    seed: { type: 'bigint' },
    state: {
      type: 'text', notNull: true, default: 'queued',
      check: "state IN ('queued', 'running', 'done', 'failed')",
    },
    attempts: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
    not_before: { type: 'timestamptz' },
    claimed_at: { type: 'timestamptz' },
    clip_id: { type: 'uuid', references: 'audio_clips', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    CREATE UNIQUE INDEX audio_jobs_one_live_per_slot
      ON audio_jobs (subject_kind, subject_key, slot) WHERE state IN ('queued', 'running')
  `);
  pgm.createIndex('audio_jobs', ['state', 'drain_group', 'id'], { name: 'audio_jobs_claim_idx' });
};

exports.down = (pgm) => {
  pgm.dropTable('audio_jobs');
};
