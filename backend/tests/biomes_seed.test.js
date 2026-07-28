const test = require('node:test');
const assert = require('node:assert');
const { STARTER_BIOMES } = require('../migrations/1714440043000_biomes.js');

// Terrain tile names that exist in the catalog (migrations 1714440002000,
// 1714440027000, 1714440029000). A biome naming a tile outside this set would
// be silently filtered out by worldConfig at runtime and the biome would
// quietly fall back to global terrain — so pin the reference here.
const LIVE_TILES = new Set([
  'grass', 'highgrass', 'leafs', 'sand', 'rocks', 'earth', 'dirt',
  'snow', 'ice', 'swamp', 'water',
]);
// Decoration + creature entity types seeded by migrations 1714440042000 and
// the entity seeds.
const LIVE_FLORA = new Set(['Tree', 'Stone', 'IceRock', 'bush', 'rose_bush', 'pine_tree', 'dead_tree']);
const LIVE_CREATURES = new Set(['Slime', 'Bat', 'Skeleton', 'Wolf']);

test('seeds exactly the five named starter biomes', () => {
  assert.deepEqual(
    STARTER_BIOMES.map((b) => b.name),
    ['Meadow', 'Deep Forest', 'Arid Dunes', 'Frozen Waste', 'Mire'],
  );
});

test('every starter biome is fully populated and references live catalog names', () => {
  for (const b of STARTER_BIOMES) {
    assert.ok(b.terrain_tiles.length >= 2, `${b.name} needs at least 2 terrain tiles`);
    assert.ok(b.flora_types.length >= 1, `${b.name} needs flora`);
    assert.ok(b.creature_types.length >= 1, `${b.name} needs creatures`);
    assert.ok(b.palette.length >= 2, `${b.name} needs a palette`);
    assert.ok(b.art_style.trim().length > 0, `${b.name} needs an art style`);
    assert.ok(b.exclusions.trim().length > 0, `${b.name} needs exclusions`);
    assert.match(b.color, /^#[0-9a-f]{6}$/i, `${b.name} needs a hex color`);
    for (const t of b.terrain_tiles) assert.ok(LIVE_TILES.has(t), `${b.name}: unknown tile ${t}`);
    for (const f of b.flora_types) assert.ok(LIVE_FLORA.has(f), `${b.name}: unknown flora ${f}`);
    for (const c of b.creature_types) assert.ok(LIVE_CREATURES.has(c), `${b.name}: unknown creature ${c}`);
  }
});

test('Village Guard is never a biome creature (guards are structural)', () => {
  for (const b of STARTER_BIOMES) {
    assert.ok(!b.creature_types.includes('Village Guard'), `${b.name} must not list guards`);
  }
});

test('biomes are distinguishable: no two share an identical terrain list', () => {
  const keys = STARTER_BIOMES.map((b) => b.terrain_tiles.join('|'));
  assert.equal(new Set(keys).size, keys.length);
});

test('no seed value embeds a single quote (migrations interpolate these into SQL)', () => {
  for (const b of STARTER_BIOMES) {
    const blob = JSON.stringify(b);
    assert.ok(!blob.includes("'"), `${b.name} must not contain a single quote`);
  }
});
