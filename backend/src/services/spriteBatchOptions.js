const { appearancePrompt } = require('./catalogSubjects.js');

// Every sprite batch job goes to the local sprite-gen service, whatever the
// entity's provider pin says. Registered providers return one flat txt2img
// image: they cannot draw a directional or multi-frame sheet, and their flat
// image is opaque RGB, which only the Art Generation console's cutout, alpha
// and size guards make safe to write into entity_types.image. A remote flat
// image belongs there; this console is for the sheets only sprite-gen draws.
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
  };
}

module.exports = { optionsForEntity, optionsForAppearance };
