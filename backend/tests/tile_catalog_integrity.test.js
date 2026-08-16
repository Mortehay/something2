const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { detectPathTile, isStructuralTile } = require('../src/services/mapService.js');

// Copied deliberately, not imported: this test's whole job is to fail if the
// catalog ever drifts into the pattern, and importing the live regex would
// make the test follow a change to it rather than catch one.
const PATH_NAME_RE = /path|dirt|road|trail|earth|sand/i;
const ORIGINAL = new Set(['grass', 'highgrass', 'leafs', 'sand', 'rocks', 'earth',
  'dirt', 'snow', 'ice', 'swamp', 'water', 'map_wall', 'map_doorway',
  'wooden_wall', 'village_gate']);
const added = () => DEFAULT_TILE_TYPES.filter((t) => !ORIGINAL.has(t.name));

test('the catalog gained exactly 35 tiles', () => {
  assert.equal(added().length, 35);
  assert.equal(DEFAULT_TILE_TYPES.length, 50);
});

// detectPathTile returns the FIRST PATH_NAME_RE match in catalog id order, so
// `sand` (id 4) is the AMBIENT path tile for every world. A new name matching
// the pattern is harmless only because it sorts later -- one reordering away
// from moving every world's paths. Keep the catalog clean of them.
//
// The `road_*` tiles are the one deliberate exception: they match "road", and
// are made safe by detectPathTile skipping the prefix outright rather than by
// where they sort. They are excluded here and pinned by their own tests below.
test('no new NON-ROAD tile name matches the path-tile pattern', () => {
  const offenders = added()
    .filter((t) => !t.name.startsWith('road_'))
    .filter((t) => PATH_NAME_RE.test(t.name));
  assert.deepEqual(offenders.map((t) => t.name), []);
});

// The two properties that keep the road tiles from changing anything that was
// already on the map. Both are asserted against the LIVE mapService functions,
// not restatements of them: the whole risk is that the catalog and the
// generator drift apart.
test('detectPathTile never picks a road tile, whatever the catalog order', () => {
  const names = DEFAULT_TILE_TYPES.map((t) => t.name);
  assert.equal(detectPathTile(names), 'sand');
  // Road tiles first: still `sand`, because the prefix is skipped, not outsorted.
  const roadsFirst = [...names.filter((n) => n.startsWith('road_')),
    ...names.filter((n) => !n.startsWith('road_'))];
  assert.equal(detectPathTile(roadsFirst), 'sand');
  // A catalog of NOTHING but road tiles has no ambient path tile at all,
  // rather than falling back to stamping roads everywhere.
  assert.equal(detectPathTile(names.filter((n) => n.startsWith('road_'))), null);
});

test('road tiles are structural, so they are never sampled as terrain', () => {
  const roads = DEFAULT_TILE_TYPES.filter((t) => t.name.startsWith('road_'));
  assert.ok(roads.length >= 5, 'the catalog carries road tiles');
  for (const t of roads) {
    assert.ok(isStructuralTile(t.name), `${t.name} must be structural`);
    assert.deepEqual(t.valid_neighbors, [], `${t.name} is stamped, not WFC-placed`);
    assert.equal(t.walkable, true, `${t.name} must be walkable`);
  }
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

// The seed data's half of the contract. A biome pointing at a road tile that
// does not exist is not a loud failure anywhere downstream -- biomeRoadTile
// drops it and roads quietly go back to the ambient tile -- so it has to be
// caught here.
test('every biome names a road tile, and every one of them exists', () => {
  const names = new Set(DEFAULT_TILE_TYPES.map((t) => t.name));
  const missing = STARTER_BIOMES.filter((b) => !b.path_tile);
  assert.deepEqual(missing.map((b) => b.name), []);
  const dangling = STARTER_BIOMES.filter((b) => !names.has(b.path_tile));
  assert.deepEqual(dangling.map((b) => `${b.name}->${b.path_tile}`), []);
});

test('a biome never stamps its roads in one of its own terrain tiles', () => {
  const blending = STARTER_BIOMES.filter((b) => (b.terrain_tiles || []).includes(b.path_tile));
  assert.deepEqual(blending.map((b) => `${b.name}->${b.path_tile}`), []);
});

test("every tile's valid_neighbors reference tiles that exist", () => {
  const names = new Set(DEFAULT_TILE_TYPES.map((t) => t.name));
  const dangling = [];
  for (const t of DEFAULT_TILE_TYPES) {
    for (const n of t.valid_neighbors ?? []) if (!names.has(n)) dangling.push(`${t.name}->${n}`);
  }
  assert.deepEqual(dangling, []);
});
