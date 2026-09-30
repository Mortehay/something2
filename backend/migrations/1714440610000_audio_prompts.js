exports.shorthands = undefined;

// Audio prompt writer (spec 2026-09-30 §3.2, §4). Two things:
//   1. ai_providers gains the 'text' modality -- the GPU box's /api/text,
//      one active per modality like image and audio.
//   2. audio_prompts: the stored, versioned prompt per audio slot. One ACTIVE
//      row per (kind, key, slot); an edit deactivates the old row and inserts
//      a new one, so history is kept.
exports.up = (pgm) => {
  pgm.dropConstraint('ai_providers', 'ai_providers_modality_check');
  pgm.addConstraint('ai_providers', 'ai_providers_modality_check', {
    check: "modality IN ('image', 'audio', 'text')",
  });

  pgm.createTable('audio_prompts', {
    id: { type: 'bigserial', primaryKey: true },
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    slot: { type: 'text', notNull: true },
    // music/ambience only: one of the box's style values for that clip kind.
    style: { type: 'text' },
    // The prompt (music/ambience) or the entity phrase (sfx). '' is legal and
    // means someone cleared it on purpose -- generation then falls through.
    text: { type: 'text', notNull: true },
    // Exactly what the model was given. Null for a hand-written row, which is
    // therefore never stale.
    source_input: { type: 'text' },
    hint: { type: 'text' },
    model: { type: 'text' },
    // 'box' | 'fallback'; null when a person wrote it.
    via: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('audio_prompts', ['subject_kind', 'subject_key', 'slot'], {
    name: 'audio_prompts_one_active', unique: true, where: 'active',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('audio_prompts');
  pgm.sql("DELETE FROM ai_providers WHERE modality = 'text'");
  pgm.dropConstraint('ai_providers', 'ai_providers_modality_check');
  pgm.addConstraint('ai_providers', 'ai_providers_modality_check', {
    check: "modality IN ('image', 'audio')",
  });
};
