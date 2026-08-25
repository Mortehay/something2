// Real on-screen sizes for the pre-existing decorations (they were seeded 0×0).
const SIZE_FIXES = {
  Tree: { w: 64, h: 96 },
  Stone: { w: 48, h: 48 },
  IceRock: { w: 48, h: 48 },
};

// New decoration types. image/sprite are left null until art is generated.
//
// THE COMMENT HERE USED TO CLAIM these are "skipped (no hole) until then".
// They are not: RenderSystem.drawEntity falls through to fillRect with the
// type's colour, so a decoration seeded render_mode 'static' with no image
// draws a solid coloured square on the map. That is what the flat blocks
// scattered over the world were.
//
// `prompt` is what lets `make entities-generate` draw them. Without one they
// are permanently ungeneratable -- the generator skips a promptless row rather
// than send an empty prompt and get back a plausible picture of nothing. Keep
// these as plain SUBJECTS: the framing ("isolated on a solid white
// background", which the cutout step depends on) is added by
// scripts/generate-entity-textures.js, not stored here.
const NEW_DECORATIONS = [
  { name: 'bush',      is_creature: false, walkable: true,  render_mode: 'static', spawn_tiles: ['grass', 'highgrass'],        chance: 0.30, display_width: 40, display_height: 40, color: '#3a7d34', prompt: 'a round leafy green shrub' },
  { name: 'rose_bush', is_creature: false, walkable: true,  render_mode: 'static', spawn_tiles: ['grass', 'highgrass'],        chance: 0.10, display_width: 40, display_height: 44, color: '#a83254', prompt: 'a green shrub covered in red roses' },
  { name: 'pine_tree', is_creature: false, walkable: false, render_mode: 'static', spawn_tiles: ['leafs', 'grass', 'snow'],    chance: 0.30, display_width: 64, display_height: 104, color: '#1f5c2e', prompt: 'a tall dark green pine tree with a straight trunk' },
  { name: 'dead_tree', is_creature: false, walkable: false, render_mode: 'static', spawn_tiles: ['earth', 'dirt', 'sand'],     chance: 0.15, display_width: 56, display_height: 92, color: '#6b5a45', prompt: 'a bare dead tree with broken branches' },
];

module.exports = { NEW_DECORATIONS, SIZE_FIXES };
