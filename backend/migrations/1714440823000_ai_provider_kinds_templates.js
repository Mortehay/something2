exports.shorthands = undefined;

// Unified AI provider kinds: ai_providers gains the 'image_edit' modality, an
// adapter column, per-group audio models and a discovery cache; a new
// ai_provider_templates table holds the "Add provider" presets.

const MODALITIES = "('image', 'audio', 'text', 'sprite', 'image_edit')";
const ADAPTERS = "('box', 'a1111', 'openai_compatible', 'ollama', 'generic')";

// Existing audio rows keep behaving as before: the models the dispatcher used
// to hard-code become the explicit per-group choice. Exported so the DB test
// runs the real statement.
const BACKFILL_AUDIO_MODELS = { music: 'audio:ace-step', ambience: 'audio:stable-audio' };
const BACKFILL_AUDIO_SQL = `UPDATE ai_providers
  SET models_by_group = '${JSON.stringify(BACKFILL_AUDIO_MODELS)}'::jsonb
  WHERE modality = 'audio' AND models_by_group IS NULL`;

exports.BACKFILL_AUDIO_MODELS = BACKFILL_AUDIO_MODELS;
exports.BACKFILL_AUDIO_SQL = BACKFILL_AUDIO_SQL;

exports.up = (pgm) => {
  pgm.addColumns('ai_providers', {
    adapter: { type: 'text' },
    models_by_group: { type: 'jsonb' },
    discovery_cache: { type: 'jsonb' },
    discovery_fetched_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('ai_providers', 'ai_providers_adapter_check', {
    check: `adapter IS NULL OR adapter IN ${ADAPTERS}`,
  });
  pgm.dropConstraint('ai_providers', 'ai_providers_modality_check');
  pgm.addConstraint('ai_providers', 'ai_providers_modality_check', {
    check: `modality IN ${MODALITIES}`,
  });

  pgm.createTable('ai_provider_templates', {
    id: 'id',
    name: { type: 'text', notNull: true, unique: true },
    modality: { type: 'text', notNull: true },
    adapter: { type: 'text' },
    description: { type: 'text', notNull: true, default: '' },
    defaults: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    builtin: { type: 'boolean', notNull: true, default: false },
    // Same default ai_providers got in the seed_sync migration.
    sync_uuid: { type: 'uuid', notNull: true, default: pgm.func('gen_random_uuid()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('ai_provider_templates', 'ai_provider_templates_sync_uuid_key', { unique: ['sync_uuid'] });
  pgm.addConstraint('ai_provider_templates', 'ai_provider_templates_modality_check', {
    check: `modality IN ${MODALITIES}`,
  });
  pgm.addConstraint('ai_provider_templates', 'ai_provider_templates_adapter_check', {
    check: `adapter IS NULL OR adapter IN ${ADAPTERS}`,
  });

  pgm.sql(BACKFILL_AUDIO_SQL);
};

exports.down = (pgm) => {
  pgm.dropTable('ai_provider_templates');
  pgm.sql("DELETE FROM ai_providers WHERE modality = 'image_edit'");
  pgm.dropConstraint('ai_providers', 'ai_providers_modality_check');
  pgm.addConstraint('ai_providers', 'ai_providers_modality_check', {
    check: "modality IN ('image', 'audio', 'text', 'sprite')",
  });
  pgm.dropConstraint('ai_providers', 'ai_providers_adapter_check');
  pgm.dropColumns('ai_providers', ['adapter', 'models_by_group', 'discovery_cache', 'discovery_fetched_at']);
};
