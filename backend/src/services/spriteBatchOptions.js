const { appearancePrompt } = require('./catalogSubjects.js');

// The facings a creature, class or appearance variant is drawn in. Props
// (kind 'object') are drawn from one angle only.
//
// SOMET-669: front, right side and back only. The game draws w as the e row
// mirrored (SOMET-659 -- the box's western rows were broken anyway) and every
// diagonal as the side view, so drawing the other five rows spent 5/8 of each
// sheet's GPU time on rows nothing showed.
const SPRITE_DIRECTIONS = ['s', 'e', 'n'];

// Batch sprite jobs go to the GPU box (Qwen sheet generation). These options
// describe WHAT to draw per entity or appearance variant: subject, prompt,
// kind, frame count and facings. The box needs a flat concept image; the
// dispatcher gets it from the GPU box's own generate_core task, not this file.
function optionsForEntity(entity) {
  const directional = entity.is_creature === true || entity.is_playable === true;
  const frames = directional || entity.render_mode === 'animated' ? 4 : 1;

  return {
    entityTypeId: entity.id,
    appearanceVariant: null,
    subject: entity.name,
    prompt: String(entity.prompt || '').trim() || entity.name,
    kind: directional ? 'creature' : 'object',
    frames,
    directions: directional ? SPRITE_DIRECTIONS : ['s'],
  };
}

// A playable class's own directional sheet is the fallback every appearance
// variant renders with until it has its own (character_appearances.sprite is
// NULL at seed time -- see characters.js's COALESCE). `appearance` is one row
// from character_appearances, already joined to its class's name/prompt the
// same way catalogSubjects.SUBJECTS.character_appearance lists them, so the
// prompt here matches the one that generated that variant's portrait.
function optionsForAppearance(appearance) {
  return {
    entityTypeId: appearance.entity_type_id,
    appearanceVariant: appearance.variant,
    subject: `${appearance.class_name}:${appearance.variant}`,
    prompt: appearancePrompt(appearance),
    kind: 'creature',
    frames: 4,
    directions: SPRITE_DIRECTIONS,
  };
}

module.exports = { optionsForEntity, optionsForAppearance, SPRITE_DIRECTIONS };
