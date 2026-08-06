const test = require('node:test');
const assert = require('node:assert');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');

const ORIGINAL = new Set(['Meadow', 'Deep Forest', 'Arid Dunes', 'Frozen Waste', 'Mire']);
const added = () => STARTER_BIOMES.filter((b) => !ORIGINAL.has(b.name));

test('the catalog gained exactly 27 biomes', () => {
  assert.equal(added().length, 27);
  assert.equal(STARTER_BIOMES.length, 32);
});

// The failure this repo has already had: STARTER_BIOMES listing a creature
// that no longer existed made `make seed-catalogs` rewrite a dangling
// reference on every run. The same shape applies to terrain.
test("every biome's terrain_tiles exist in the tile catalog", () => {
  const tiles = new Set(DEFAULT_TILE_TYPES.map((t) => t.name));
  const dangling = [];
  for (const b of STARTER_BIOMES) {
    for (const t of b.terrain_tiles) if (!tiles.has(t)) dangling.push(`${b.name}->${t}`);
  }
  assert.deepEqual(dangling, []);
});

// P3's boundary with P4, asserted rather than trusted. P4 deletes this test
// when it fills the lists.
test('every new biome ships with empty fauna for P4 to fill', () => {
  const populated = added().filter((b) => (b.creature_types ?? []).length > 0);
  assert.deepEqual(populated.map((b) => b.name), []);
});

test('every new biome carries palette, art_style, exclusions and a colour', () => {
  for (const b of added()) {
    assert.ok(Array.isArray(b.palette) && b.palette.length >= 2, `${b.name} palette`);
    assert.ok(b.art_style && b.art_style.trim(), `${b.name} art_style`);
    assert.ok(b.exclusions && b.exclusions.trim(), `${b.name} exclusions`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(b.color || ''), `${b.name} color`);
  }
});

test('biome names are unique', () => {
  const names = STARTER_BIOMES.map((b) => b.name);
  assert.equal(new Set(names).size, names.length);
});

// The design's rule is about the three tiles THIS sub-project adds, not about
// impassable terrain in general -- `water` is pre-existing and `Mire` has
// always banded it. Deriving the set from every walkable:false tile would
// sweep in Storm Coast and Sunken Cistern, which band water on purpose: a
// coast needs a sea and a flooded cistern needs standing water.
//
// An explicit list, deliberately NOT a tier rule: a tier rule would sweep in
// Crystal Hollows and Hive Warrens, which sit at bands 4-6 where sealed
// terrain is least acceptable.
test('exactly ten biomes band one of the three new impassable tiles', () => {
  const NEW_IMPASSABLE = new Set(['cave_wall', 'rubble', 'chasm']);
  const withBlocked = STARTER_BIOMES
    .filter((b) => b.terrain_tiles.some((t) => NEW_IMPASSABLE.has(t)))
    .map((b) => b.name).sort();
  assert.deepEqual(withBlocked, [
    'Abyssal Rift', 'Deepvault', 'Dreaming Dark', 'Fallen Sanctum',
    'Infernal Gate', 'Pestilent Deep', 'Shattered Vault', 'The Maw',
    "Titan's Grave", 'Umbral Warren',
  ].sort());
});
