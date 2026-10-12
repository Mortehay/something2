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
    subject: entity.name,
    prompt: String(entity.prompt || '').trim() || entity.name,
    kind: directional ? 'creature' : 'object',
    frames,
  };
}

module.exports = { optionsForEntity };
