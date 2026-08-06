const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');

// Copied deliberately, not imported: this test's whole job is to fail if the
// catalog ever drifts into the pattern, and importing the live regex would
// make the test follow a change to it rather than catch one.
const PATH_NAME_RE = /path|dirt|road|trail|earth|sand/i;
const ORIGINAL = new Set(['grass', 'highgrass', 'leafs', 'sand', 'rocks', 'earth',
  'dirt', 'snow', 'ice', 'swamp', 'water', 'map_wall', 'map_doorway',
  'wooden_wall', 'village_gate']);
const added = () => DEFAULT_TILE_TYPES.filter((t) => !ORIGINAL.has(t.name));

test('the catalog gained exactly 30 tiles', () => {
  assert.equal(added().length, 30);
  assert.equal(DEFAULT_TILE_TYPES.length, 45);
});

// detectPathTile returns the FIRST PATH_NAME_RE match in catalog id order, so
// `sand` (id 4) is the path tile for every world. A new name matching the
// pattern is harmless only because it sorts later -- one reordering away from
// moving every world's paths. Keep the catalog clean of them.
test('no new tile name matches the path-tile pattern', () => {
  const offenders = added().filter((t) => PATH_NAME_RE.test(t.name));
  assert.deepEqual(offenders.map((t) => t.name), []);
});

test('every new tile carries a non-empty sprite prompt', () => {
  const missing = added().filter((t) => !t.prompt || !t.prompt.trim());
  assert.deepEqual(missing.map((t) => t.name), []);
});

test('every new tile has a colour, since that is its appearance until sprites exist', () => {
  const bad = added().filter((t) => !/^#[0-9a-f]{6}$/i.test(t.color || ''));
  assert.deepEqual(bad.map((t) => t.name), []);
});

test('tile names are unique across the whole catalog', () => {
  const names = DEFAULT_TILE_TYPES.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test('exactly three new tiles are impassable, and cave_wall has wall height', () => {
  const blocked = added().filter((t) => t.walkable === false).map((t) => t.name).sort();
  assert.deepEqual(blocked, ['cave_wall', 'chasm', 'rubble']);
  assert.equal(DEFAULT_TILE_TYPES.find((t) => t.name === 'cave_wall').wall_height, 48);
});

test("every tile's valid_neighbors reference tiles that exist", () => {
  const names = new Set(DEFAULT_TILE_TYPES.map((t) => t.name));
  const dangling = [];
  for (const t of DEFAULT_TILE_TYPES) {
    for (const n of t.valid_neighbors ?? []) if (!names.has(n)) dangling.push(`${t.name}->${n}`);
  }
  assert.deepEqual(dangling, []);
});
