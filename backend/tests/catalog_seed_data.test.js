const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { NEW_DECORATIONS } = require('../seeds/data/decorationTypes.js');

// Tile names inserted by the three migrations that seed tile_types:
//   1714440002000_create_tile_types.js  (the defaultTileTypes object)
//   1714440027000_bounded_worlds.js     (map_wall, map_doorway)
//   1714440029000_villages_and_binds.js (wooden_wall, village_gate)
// The seeder upserts by name and therefore becomes authoritative on a fresh
// database. If it is missing a tile the migrations create, a `make
// seed-catalogs` run would leave a gap that only shows up as an invisible
// fallback colour in a rendered world -- so pin the superset relationship.
const MIGRATION_TILE_NAMES = [
  'grass', 'highgrass', 'leafs', 'sand', 'rocks', 'earth', 'dirt',
  'snow', 'ice', 'swamp', 'water',
  'map_wall', 'map_doorway',
  'wooden_wall', 'village_gate',
];

test('the tile seed file is a superset of every migration-seeded tile', () => {
  const seeded = new Set(DEFAULT_TILE_TYPES.map((t) => t.name));
  const missing = MIGRATION_TILE_NAMES.filter((n) => !seeded.has(n));
  assert.deepEqual(missing, [], `tile seed file is missing: ${missing.join(', ')}`);
});

test('every tile seed row is fully formed', () => {
  assert.ok(DEFAULT_TILE_TYPES.length > 0, 'no tiles — this test would assert nothing');
  for (const t of DEFAULT_TILE_TYPES) {
    assert.ok(t.name, 'tile has no name');
    // 6-digit RRGGBB, or 8-digit RRGGBBAA (highgrass/leafs/dirt carry a
    // trailing alpha channel in the original migration — verbatim, not a typo).
    assert.match(t.color, /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, `${t.name} colour is not a valid hex string`);
    assert.equal(typeof t.walkable, 'boolean', `${t.name} walkable must be boolean`);
    assert.equal(typeof t.speed, 'number', `${t.name} speed must be a number`);
    assert.ok(Array.isArray(t.valid_neighbors), `${t.name} valid_neighbors must be an array`);
  }
});

test('the moved catalog arrays are still intact', () => {
  assert.equal(STARTER_BIOMES.length, 5);
  assert.ok(NEW_DECORATIONS.length > 0);
});
