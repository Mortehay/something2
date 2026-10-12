exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('sprite_sets', {
    generation_kind: { type: 'text', notNull: true, default: 'creature' },
    base_prompt: { type: 'text', notNull: true, default: '' },
    provider_id: { type: 'integer', references: 'ai_providers', onDelete: 'SET NULL' },
    image_key: { type: 'text' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
    claimed_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('sprite_sets', 'sprite_sets_generation_kind_check',
    "CHECK (generation_kind IN ('creature','object','tile'))");
  pgm.addConstraint('sprite_sets', 'sprite_sets_status_check',
    "CHECK (status IN ('queued','running','done','failed','approved'))");
  pgm.createIndex('sprite_sets', ['entity_type_id'], {
    name: 'sprite_sets_one_live_per_entity',
    unique: true,
    where: "entity_type_id IS NOT NULL AND status IN ('queued','running')",
  });
  pgm.createIndex('sprite_sets', ['status', 'created_at'], {
    name: 'sprite_sets_queue_claim_idx',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('sprite_sets', ['status', 'created_at'], { name: 'sprite_sets_queue_claim_idx' });
  pgm.dropIndex('sprite_sets', ['entity_type_id'], { name: 'sprite_sets_one_live_per_entity' });
  pgm.dropConstraint('sprite_sets', 'sprite_sets_status_check');
  pgm.dropConstraint('sprite_sets', 'sprite_sets_generation_kind_check');
  pgm.dropColumns('sprite_sets', [
    'generation_kind', 'base_prompt', 'provider_id', 'image_key', 'attempts',
    'last_error', 'claimed_at', 'updated_at',
  ]);
};
