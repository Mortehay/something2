exports.shorthands = undefined;

// The biome art context a tile's texture was generated with, remembered.
//
// THE BUG THIS FIXES is a usability one, not a data one. The tile editor's
// generation panel offers "Biome art context (optional)", which steers the
// generated art toward a biome's palette, style and exclusions. It was React
// state initialised to '' and nothing else -- the choice reached the
// generation request and was then forgotten. Pressing "Save Changes" did not
// save it, because there was nowhere to put it.
//
// That is the same shape as the provider pin's problem, but with one
// difference that matters: "Generate with" at least had a saved counterpart
// (ai_provider_mode/ai_provider_id) to fall back on, so the fix there was
// wiring. This one had no column at all, so remembering it needs one.
//
// ONE BIOME PER TILE IS NOT LOSSY, which is the obvious objection -- a tile
// can appear in many biomes. But a tile carries ONE image shared by every
// biome that lists it (see the note in seeds/data/tileTypes.js and
// services/biomePrompt.js): biomes deliberately cannot be told apart by
// reusing `rocks` under a different palette. Since the image is single
// already, the art context that produced it is single too.
//
// DELIBERATELY NOT SEEDED. Unlike `prompt`, which seeds/data/tileTypes.js now
// owns because a bad prompt makes a tile ungeneratable, this is an optional
// styling choice with no catalog-wide right answer. It stays UI-owned, and
// seed-catalogs.js does not list the column, so a re-seed leaves it alone.
//
// '' rather than NULL for "no context", matching how `prompt` and `image`
// already spell empty on this table.

exports.up = (pgm) => {
  pgm.addColumns('tile_types', {
    art_biome: { type: 'text', notNull: true, default: '' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('tile_types', ['art_biome']);
};
