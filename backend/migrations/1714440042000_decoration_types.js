exports.shorthands = undefined;

// Data moved to backend/seeds/data/decorationTypes.js so `make seed-catalogs`
// and this migration cannot drift apart. Re-exported because the seeder both
// reads it. Migration behaviour is unchanged: the arrays are byte-identical
// and migrations only ever run once.
const { NEW_DECORATIONS, SIZE_FIXES } = require('../seeds/data/decorationTypes.js');

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
