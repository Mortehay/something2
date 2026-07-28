exports.shorthands = undefined;

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

exports.up = (pgm) => {
  for (const [name, { w, h }] of Object.entries(SIZE_FIXES)) {
    pgm.sql(`UPDATE entity_types SET display_width = ${w}, display_height = ${h} WHERE name = '${name}'`);
  }
  for (const d of NEW_DECORATIONS) {
    pgm.sql(`INSERT INTO entity_types
      (name, is_creature, walkable, render_mode, spawn_tiles, chance, display_width, display_height, color)
      VALUES ('${d.name}', ${d.is_creature}, ${d.walkable}, '${d.render_mode}',
        '${JSON.stringify(d.spawn_tiles)}'::jsonb, ${d.chance}, ${d.display_width}, ${d.display_height}, '${d.color}')
      ON CONFLICT (name) DO NOTHING`);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM entity_types WHERE name IN ('bush','rose_bush','pine_tree','dead_tree')`);
  for (const name of Object.keys(SIZE_FIXES)) {
    pgm.sql(`UPDATE entity_types SET display_width = 0, display_height = 0 WHERE name = '${name}'`);
  }
};

exports.NEW_DECORATIONS = NEW_DECORATIONS;
exports.SIZE_FIXES = SIZE_FIXES;
