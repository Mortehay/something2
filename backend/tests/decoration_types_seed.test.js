const test = require('node:test');
const assert = require('node:assert');
const { NEW_DECORATIONS, SIZE_FIXES } = require('../migrations/1714440042000_decoration_types.js');

test('new decoration types are non-creature with spawn rules and sizes', () => {
  const byName = Object.fromEntries(NEW_DECORATIONS.map((d) => [d.name, d]));
  for (const name of ['bush', 'rose_bush', 'pine_tree', 'dead_tree']) {
    const d = byName[name];
    assert.ok(d, `${name} present`);
    assert.equal(d.is_creature, false);
    assert.equal(d.render_mode, 'static');
    assert.ok(Array.isArray(d.spawn_tiles) && d.spawn_tiles.length > 0);
    assert.ok(d.display_width > 0 && d.display_height > 0);
    assert.ok(typeof d.walkable === 'boolean');
  }
  assert.equal(byName.bush.walkable, true);
  assert.equal(byName.pine_tree.walkable, false);
});

test('size fixes give existing decorations non-zero display sizes', () => {
  for (const name of ['Tree', 'Stone', 'IceRock']) {
    assert.ok(SIZE_FIXES[name].w > 0 && SIZE_FIXES[name].h > 0);
  }
});
