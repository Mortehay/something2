const test = require('node:test');
const assert = require('node:assert');
const {
  generateWorldPreview,
  generateRegion,
  worldConfig,
} = require('../src/services/mapService');

// Two biomes + a path tile (path IS carved into the preview window now).
const tileTypes = { grass: {}, water: {}, path: {} };
const world = { seed: 7, chunkSize: 64, tileTypes };

test('generateWorldPreview returns a dim x dim grid of biome or path names', () => {
  const grid = generateWorldPreview(world, 64);
  assert.equal(grid.length, 64);
  assert.ok(grid.every((row) => row.length === 64));
  const cfg = worldConfig(world);
  const allowed = new Set([...cfg.biomeNames, cfg.pathTile]); // ['grass','water','path']
  for (const row of grid) {
    for (const cell of row) assert.ok(allowed.has(cell), `unexpected cell ${cell}`);
  }
});

test('generateWorldPreview is the contiguous origin-centered region', () => {
  // The preview must be a real window of the world, not a resampling — so it
  // equals generateRegion over the same [-dim/2 .. dim/2) span.
  const grid = generateWorldPreview(world, 32);
  const origin = -Math.floor(32 / 2);
  const region = generateRegion(world, origin, origin, 32, 32);
  assert.deepEqual(grid, region);
});

test('generateWorldPreview is deterministic for the same seed', () => {
  const a = generateWorldPreview(world, 32);
  const b = generateWorldPreview(world, 32);
  assert.deepEqual(a, b);
});

test('a different seed generally yields a different grid', () => {
  const a = generateWorldPreview({ ...world, seed: 1 }, 32);
  const b = generateWorldPreview({ ...world, seed: 2 }, 32);
  assert.notDeepEqual(a, b);
});

// Regression for the aliasing bug: the old preview point-sampled one biome per
// noise cell, producing per-tile confetti where horizontally-adjacent cells
// were near-independent (~random equality). A coherent window is dominated by
// contiguous biome bands, so the vast majority of adjacent pairs match. This
// assertion FAILS on the aliased implementation and passes on the windowed one.
test('adjacent cells are coherent (not per-tile noise)', () => {
  const grid = generateWorldPreview(world, 64);
  let equal = 0, total = 0;
  for (const row of grid) {
    for (let c = 1; c < row.length; c++) {
      total += 1;
      if (row[c] === row[c - 1]) equal += 1;
    }
  }
  const ratio = equal / total;
  assert.ok(ratio > 0.7, `expected coherent bands (>0.7 adjacent-equal), got ${ratio.toFixed(3)}`);
});
