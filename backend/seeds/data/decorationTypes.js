// Real on-screen sizes for the pre-existing decorations (they were seeded 0×0).
const SIZE_FIXES = {
  Tree: { w: 64, h: 96 },
  Stone: { w: 48, h: 48 },
  IceRock: { w: 48, h: 48 },
};

// New decoration types. image/sprite are left null — the user generates sprites
// locally; each renders once its image exists, and is skipped (no hole) until then.
const NEW_DECORATIONS = [
  { name: 'bush',      is_creature: false, walkable: true,  render_mode: 'static', spawn_tiles: ['grass', 'highgrass'],        chance: 0.30, display_width: 40, display_height: 40, color: '#3a7d34' },
  { name: 'rose_bush', is_creature: false, walkable: true,  render_mode: 'static', spawn_tiles: ['grass', 'highgrass'],        chance: 0.10, display_width: 40, display_height: 44, color: '#a83254' },
  { name: 'pine_tree', is_creature: false, walkable: false, render_mode: 'static', spawn_tiles: ['leafs', 'grass', 'snow'],    chance: 0.30, display_width: 64, display_height: 104, color: '#1f5c2e' },
  { name: 'dead_tree', is_creature: false, walkable: false, render_mode: 'static', spawn_tiles: ['earth', 'dirt', 'sand'],     chance: 0.15, display_width: 56, display_height: 92, color: '#6b5a45' },
];

module.exports = { NEW_DECORATIONS, SIZE_FIXES };
