// backend/tests/bounded_worlds_migration.test.js
const test = require('node:test');
const assert = require('node:assert');
const { MAP_TILE_TYPES } = require('../migrations/1714440027000_bounded_worlds.js');

test('seeds a non-walkable map_wall and a walkable map_doorway tile type', () => {
  const byName = Object.fromEntries(MAP_TILE_TYPES.map((t) => [t.name, t]));
  assert.ok(byName.map_wall, 'map_wall must be seeded');
  assert.equal(byName.map_wall.walkable, false, 'map_wall must block movement');
  assert.ok(byName.map_doorway, 'map_doorway must be seeded');
  assert.equal(byName.map_doorway.walkable, true, 'map_doorway must be passable');
});
