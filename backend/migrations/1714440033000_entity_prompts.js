exports.shorthands = undefined;

// Base prompts per seeded entity — human-readable descriptions only. The
// sprite-gen object branch appends the "single isometric object" styling, the
// same way TILE_PROMPTS feed the tile branch.
const ENTITY_PROMPTS = {
  Tree: 'a tall broadleaf tree with a thick trunk',
  Stone: 'a mossy grey boulder',
  IceRock: 'a jagged pale blue ice boulder',
  Player: 'a human adventurer in leather armour',
  Wolf: 'a grey forest wolf',
  Slime: 'a translucent green slime blob',
  Skeleton: 'an undead skeleton warrior',
  Bat: 'a small brown cave bat',
};

exports.up = (pgm) => {
  // Mirrors tile_types.prompt (migration 1714440026000): the editable base
  // description the AI generator styles into a full prompt. Entities already
  // have image/sprite/render_mode, so only the prompt column is missing.
  pgm.addColumn('entity_types', {
    prompt: { type: 'text', notNull: true, default: '' },
  });

  // Seed a base prompt for each stock entity. None of these strings contain a
  // single quote, so direct interpolation is safe here.
  for (const [name, prompt] of Object.entries(ENTITY_PROMPTS)) {
    pgm.sql(`UPDATE entity_types SET prompt = '${prompt}' WHERE name = '${name}'`);
  }
};

exports.down = (pgm) => {
  pgm.dropColumns('entity_types', ['prompt']);
};

// Exported for unit testing the seed values.
exports.ENTITY_PROMPTS = ENTITY_PROMPTS;
