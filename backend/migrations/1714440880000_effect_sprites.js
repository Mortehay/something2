/* eslint-disable camelcase */
// Generated effect sprites. vfx_effects gains loop / fps / stretch next to its existing sprite_*
// columns; aura_effects gets the same sprite columns (none before); effect_sprite_jobs is the
// machine-local queue of draws, one active job per subject.
exports.shorthands = undefined;

const FPS = 'sprite_fps IS NULL OR (sprite_fps > 0 AND sprite_fps <= 60)';

exports.up = (pgm) => {
  pgm.addColumns('vfx_effects', {
    sprite_loop: { type: 'boolean', notNull: true, default: false },
    sprite_fps: { type: 'real', notNull: false },
    // The strip stretches from origin to reach instead of travelling (chain_lightning is a bolt).
    sprite_stretch: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addConstraint('vfx_effects', 'vfx_effects_sprite_fps_check', `CHECK (${FPS})`);

  pgm.addColumns('aura_effects', {
    sprite_image: { type: 'text', notNull: false },
    sprite_frames: { type: 'integer', notNull: true, default: 1 },
    sprite_additive: { type: 'boolean', notNull: true, default: false },
    sprite_fps: { type: 'real', notNull: false },
  });
  pgm.addConstraint('aura_effects', 'aura_effects_sprite_frames_check', 'CHECK (sprite_frames BETWEEN 1 AND 64)');
  pgm.addConstraint('aura_effects', 'aura_effects_sprite_fps_check', `CHECK (${FPS})`);

  pgm.createTable('effect_sprite_jobs', {
    id: 'id',
    subject_kind: { type: 'text', notNull: true, check: "subject_kind IN ('vfx','aura')" },
    subject_name: { type: 'text', notNull: true },
    prompt: { type: 'text', notNull: true, check: 'length(btrim(prompt)) BETWEEN 1 AND 1000' },
    kind: { type: 'text', notNull: true, check: "kind IN ('projectile','burst','aura','beam')" },
    frames: { type: 'integer', notNull: true, check: 'frames BETWEEN 1 AND 64' },
    size: { type: 'integer', notNull: true, check: 'size BETWEEN 16 AND 512' },
    loop: { type: 'boolean', notNull: true },
    blend: { type: 'text', notNull: true, check: "blend IN ('additive','alpha')" },
    seed: { type: 'bigint', notNull: true },
    status: {
      type: 'text', notNull: true, default: 'queued',
      check: "status IN ('queued','running','done','failed','approved')",
    },
    box_job_id: { type: 'text' },
    image_key: { type: 'text' },
    atlas: { type: 'jsonb' },
    predicted_seconds: { type: 'integer', check: 'predicted_seconds IS NULL OR predicted_seconds > 0' },
    sheet_seconds: { type: 'integer', check: 'sheet_seconds IS NULL OR sheet_seconds >= 0' },
    running_since: { type: 'timestamptz' },
    error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    finished_at: { type: 'timestamptz' },
  });
  pgm.createIndex('effect_sprite_jobs', ['subject_kind', 'subject_name', { name: 'created_at', sort: 'DESC' }],
    { name: 'effect_sprite_jobs_subject_idx' });
  pgm.createIndex('effect_sprite_jobs', ['subject_kind', 'subject_name'], {
    name: 'effect_sprite_jobs_one_active', unique: true, where: "status IN ('queued','running')",
  });
};

exports.down = (pgm) => {
  pgm.dropTable('effect_sprite_jobs');
  pgm.dropConstraint('aura_effects', 'aura_effects_sprite_fps_check');
  pgm.dropConstraint('aura_effects', 'aura_effects_sprite_frames_check');
  pgm.dropColumns('aura_effects', ['sprite_image', 'sprite_frames', 'sprite_additive', 'sprite_fps']);
  pgm.dropConstraint('vfx_effects', 'vfx_effects_sprite_fps_check');
  pgm.dropColumns('vfx_effects', ['sprite_loop', 'sprite_fps', 'sprite_stretch']);
};
