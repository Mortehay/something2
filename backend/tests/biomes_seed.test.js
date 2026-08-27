const test = require('node:test');
const assert = require('node:assert');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { HOSTILE_CREATURES } = require('../seeds/data/entityTypes.js');
const { BESTIARY_P4_CREATURES } = require('../seeds/data/bestiaryP4.js');

// Terrain tile names that exist in the catalog (migrations 1714440002000,
// 1714440027000, 1714440029000). A biome naming a tile outside this set would
// be silently filtered out by worldConfig at runtime and the biome would
// quietly fall back to global terrain — so pin the reference here.
const LIVE_TILES = new Set([
  'grass', 'highgrass', 'leafs', 'sand', 'rocks', 'earth', 'dirt',
  'snow', 'ice', 'swamp', 'water',
]);
// Decoration entity types seeded by migrations 1714440003000 and 1714440042000.
const LIVE_FLORA = new Set(['Tree', 'Stone', 'IceRock', 'bush', 'rose_bush', 'pine_tree', 'dead_tree']);
// DERIVED, not hand-listed. This used to be the literal
// `['Slime','Bat','Skeleton','Wolf']`, which made the reference check below
// vacuous in the one case that mattered: `Wolf` sat in this set AND in two
// biomes, while no migration and no seed file created the row, so the
// assertion compared the data against a restatement of itself and stayed
// green through the entire period the reference was dangling. Reading the
// creature catalog instead means deleting a creature from
// seeds/data/entityTypes.js now fails every biome that references it.
// BOTH catalogs, for the same reason this set is derived at all. The biomes
// reference creatures by name across two source files: the four legacy types
// in entityTypes.js and the 288 "{Line} {Rung}" types in bestiaryP4.js. When
// only the legacy file was read, every P4 name in a biome read as "unknown
// creature" -- which is why the 27 P3 biomes' Cave/Ember/Rime fauna was never
// checked by this test at all, and why the original five could not gain their
// P4 line without a spurious failure. Deleting a creature from EITHER file now
// fails every biome that references it.
const LIVE_CREATURES = new Set([
  ...HOSTILE_CREATURES.map((c) => c.name),
  ...BESTIARY_P4_CREATURES.map((c) => c.name),
]);

test('the five original starter biomes are still the first five, in order', () => {
  assert.deepEqual(
    STARTER_BIOMES.slice(0, 5).map((b) => b.name),
    ['Meadow', 'Deep Forest', 'Arid Dunes', 'Frozen Waste', 'Mire'],
  );
});

// P3's new biomes ship with creature_types: [] on purpose for a later sub-project to populate.
// The original five must stay fully populated; biome_catalog_integrity.test.js asserts
// that the new ones have empty fauna as designed.
const ORIGINAL_FIVE = new Set(['Meadow', 'Deep Forest', 'Arid Dunes', 'Frozen Waste', 'Mire']);
test('every ORIGINAL starter biome is fully populated and references live catalog names', () => {
  for (const b of STARTER_BIOMES.filter((x) => ORIGINAL_FIVE.has(x.name))) {
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
