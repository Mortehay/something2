/* eslint-disable camelcase */
// Sprite prompt regeneration: flags on the sprite queues, regenerated concepts,
// and where a prompt description came from.
//  - sprite_sets.regenerate_concept / needs_prompt, effect_sprite_jobs.needs_prompt
//  - sprite_concepts.regenerated / prompt: the concept was drawn from a regenerated or
//    Sprite-tab prompt (not the approved art), and the base_prompt it was drawn from
//  - art_prompt_descriptions.origin: NULL or 'sprite' (written from the Sprite tab)
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('sprite_sets', {
    regenerate_concept: { type: 'boolean', notNull: true, default: false },
    needs_prompt: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addColumn('effect_sprite_jobs', { needs_prompt: { type: 'boolean', notNull: true, default: false } });
  pgm.addColumns('sprite_concepts', {
    regenerated: { type: 'boolean', notNull: true, default: false },
    prompt: { type: 'text' },
  });
  pgm.addColumn('art_prompt_descriptions', { origin: { type: 'text' } });
  pgm.addConstraint('art_prompt_descriptions', 'art_prompt_descriptions_origin_check',
    { check: "origin IS NULL OR origin = 'sprite'" });
};

exports.down = (pgm) => {
  pgm.dropConstraint('art_prompt_descriptions', 'art_prompt_descriptions_origin_check');
  pgm.dropColumn('art_prompt_descriptions', 'origin');
  pgm.dropColumns('sprite_concepts', ['regenerated', 'prompt']);
  pgm.dropColumn('effect_sprite_jobs', 'needs_prompt');
  pgm.dropColumns('sprite_sets', ['regenerate_concept', 'needs_prompt']);
};
