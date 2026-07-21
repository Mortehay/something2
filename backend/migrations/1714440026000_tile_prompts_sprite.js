exports.shorthands = undefined;

// Base prompts per seeded tile — human-readable descriptions only. The sprite-gen
// tile branch (Slice B) appends the "seamless top-down iso tile" styling, so
// these stay editable and readable.
const TILE_PROMPTS = {
  grass: 'lush green meadow grass',
  highgrass: 'tall dense green grass',
  leafs: 'dark green forest leaf litter',
  sand: 'fine golden beach sand',
  rocks: 'grey rocky stone ground',
  earth: 'bare brown earth soil',
  dirt: 'dark packed dirt ground',
  snow: 'fresh white snow',
  ice: 'pale blue cracked ice',
  swamp: 'murky green swamp mud',
  water: 'clear blue rippling water',
};

exports.up = (pgm) => {
  // Mirror the entity image/sprite/render_mode pattern on tile_types.
  // render_mode defaults to 'color' so every existing tile renders exactly as
  // today until a texture is generated and approved (Slices B/C).
  pgm.addColumns('tile_types', {
    prompt: { type: 'text', notNull: true, default: '' },
    sprite: { type: 'jsonb', notNull: false },
    render_mode: { type: 'text', notNull: true, default: 'color' },
  });

  // Seed a base prompt for each stock tile. None of these strings contain a
  // single quote, so direct interpolation is safe here.
  for (const [name, prompt] of Object.entries(TILE_PROMPTS)) {
    pgm.sql(`UPDATE tile_types SET prompt = '${prompt}' WHERE name = '${name}'`);
  }
};

exports.down = (pgm) => {
  pgm.dropColumns('tile_types', ['prompt', 'sprite', 'render_mode']);
};

// Exported for unit testing the seed values.
exports.TILE_PROMPTS = TILE_PROMPTS;
