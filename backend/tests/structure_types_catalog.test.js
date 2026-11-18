// SOMET-773: ruin styles. Pure data checks.
const test = require('node:test');
const assert = require('node:assert');
const { STRUCTURE_TYPES } = require('../seeds/data/structureTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');

const tiles = new Map(DEFAULT_TILE_TYPES.map((t) => [t.name, t]));
const biomes = new Set(STARTER_BIOMES.map((b) => b.name));

test('styles are uniquely named and name real biomes', () => {
  assert.ok(STRUCTURE_TYPES.length >= 7);
  assert.equal(new Set(STRUCTURE_TYPES.map((s) => s.name)).size, STRUCTURE_TYPES.length);
  for (const s of STRUCTURE_TYPES) {
    assert.ok(s.biomes.length > 0, s.name);
    for (const b of s.biomes) assert.ok(biomes.has(b), `${s.name}: unknown biome ${b}`);
  }
});

test('no biome belongs to two styles', () => {
  const seen = new Map();
  for (const s of STRUCTURE_TYPES) for (const b of s.biomes) {
    assert.ok(!seen.has(b), `${b} in ${seen.get(b)} and ${s.name}`);
    seen.set(b, s.name);
  }
});

test('walls block with a height, floors are walkable', () => {
  for (const s of STRUCTURE_TYPES) {
    const w = tiles.get(s.wallTile), f = tiles.get(s.floorTile);
    assert.ok(w && w.walkable === false && w.wall_height > 0, `${s.name} wall ${s.wallTile}`);
    assert.ok(f && f.walkable === true && !f.wall_height, `${s.name} floor ${s.floorTile}`);
  }
});

test('sizes and wall keep stay in the agreed ranges', () => {
  for (const s of STRUCTURE_TYPES) {
    assert.ok(s.sizes.length > 0, s.name);
    for (const [w, h] of s.sizes) {
      assert.ok(w >= 3 && w <= 5, `${s.name} width ${w}`);
      assert.ok(h >= 3 && h <= 4, `${s.name} height ${h}`);
    }
    assert.ok(s.wallKeep >= 0.5 && s.wallKeep <= 0.7, `${s.name} wallKeep`);
    assert.ok(s.weight > 0, `${s.name} weight`);
  }
});
