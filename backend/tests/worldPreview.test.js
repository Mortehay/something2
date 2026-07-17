const test = require('node:test');
const assert = require('node:assert');
const { generateWorldPreview, worldConfig } = require('../src/services/mapService');

// Two biomes + a path tile (path excluded from biome sampling).
const tileTypes = { grass: {}, water: {}, path: {} };
const world = { seed: 7, chunkSize: 64, tileTypes };

test('generateWorldPreview returns a dim x dim grid of biome names', () => {
  const grid = generateWorldPreview(world, 64, 8);
  assert.equal(grid.length, 64);
  assert.ok(grid.every((row) => row.length === 64));
  const biomeNames = worldConfig(world).biomeNames; // ['grass','water']
  for (const row of grid) {
    for (const cell of row) assert.ok(biomeNames.includes(cell), `unexpected cell ${cell}`);
  }
});

test('generateWorldPreview is deterministic for the same seed', () => {
  const a = generateWorldPreview(world, 32, 8);
  const b = generateWorldPreview(world, 32, 8);
  assert.deepEqual(a, b);
});

test('a different seed generally yields a different grid', () => {
  const a = generateWorldPreview({ ...world, seed: 1 }, 32, 8);
  const b = generateWorldPreview({ ...world, seed: 2 }, 32, 8);
  assert.notDeepEqual(a, b);
});

test('the middle cell samples global tile 0,0', () => {
  // dim=8 → start=-Math.floor(8/2)*8=-32; middle cell pr=pc=4 → gRow=gCol=-32+4*8=0.
  const cfg = worldConfig(world);
  const grid = generateWorldPreview(world, 8, 8);
  const { sampleBiome } = require('../src/services/mapService');
  assert.equal(grid[4][4], sampleBiome(cfg, 0, 0));
});
