const test = require('node:test');
const assert = require('node:assert');

const {
  hash2,
  globalValueNoise,
} = require('../src/services/mapService');

test('hash2 is deterministic and in [0,1)', () => {
  const a = hash2(1234, 7, -3);
  const b = hash2(1234, 7, -3);
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 1, `out of range: ${a}`);
});

test('hash2 varies with each argument (incl. negatives)', () => {
  assert.notEqual(hash2(1, 0, 0), hash2(2, 0, 0));       // seed
  assert.notEqual(hash2(1, 0, 0), hash2(1, 1, 0));       // x
  assert.notEqual(hash2(1, 0, 0), hash2(1, 0, 1));       // y
  assert.notEqual(hash2(1, -1, 0), hash2(1, 1, 0));      // negative vs positive x
});

test('globalValueNoise is deterministic and in [0,1]', () => {
  const a = globalValueNoise(9, 100, 250, 8);
  const b = globalValueNoise(9, 100, 250, 8);
  assert.equal(a, b);
  assert.ok(a >= 0 && a <= 1, `out of range: ${a}`);
});

test('globalValueNoise is smooth (adjacent samples stay close)', () => {
  let maxJump = 0;
  for (let gc = 1; gc < 200; gc++) {
    maxJump = Math.max(
      maxJump,
      Math.abs(globalValueNoise(5, 40, gc, 8) - globalValueNoise(5, 40, gc - 1, 8)),
    );
  }
  assert.ok(maxJump < 0.35, `noise not smooth, maxJump ${maxJump}`);
});

test('globalValueNoise agrees at negative coordinates too', () => {
  const a = globalValueNoise(3, -64, -64, 8);
  const b = globalValueNoise(3, -64, -64, 8);
  assert.equal(a, b);
});

const {
  generateRegion,
  generateChunk,
  sampleBiome,
  worldConfig,
} = require('../src/services/mapService');

// Pure biomes (no path-like name) so this task's output is biome-only.
const BIOMES = { grass: {}, forest: {}, water: {}, meadow: {} };

test('worldConfig fills defaults and rejects empty tileTypes', () => {
  const cfg = worldConfig({ seed: 1, tileTypes: BIOMES });
  assert.equal(cfg.chunkSize, 64);
  assert.equal(cfg.cellSize, 8);
  assert.deepEqual(cfg.biomeNames.sort(), ['forest', 'grass', 'meadow', 'water']);
  assert.throws(() => worldConfig({ seed: 1, tileTypes: {} }));
});

test('generateChunk returns an N x N grid of valid biome names', () => {
  const world = { seed: 1, chunkSize: 16, tileTypes: BIOMES };
  const grid = generateChunk(world, 0, 0);
  assert.equal(grid.length, 16);
  assert.equal(grid[0].length, 16);
  const names = Object.keys(BIOMES);
  for (const row of grid) for (const cell of row) assert.ok(names.includes(cell));
});

test('generateChunk is deterministic per seed and coordinate', () => {
  const world = { seed: 42, chunkSize: 16, tileTypes: BIOMES };
  assert.deepEqual(generateChunk(world, 2, -3), generateChunk(world, 2, -3));
});

test('generateChunk equals the matching window of generateRegion', () => {
  const world = { seed: 7, chunkSize: 16, tileTypes: BIOMES };
  const chunk = generateChunk(world, 1, 2);              // cx=1, cy=2
  const region = generateRegion(world, 2 * 16, 1 * 16, 16, 16); // rMin=cy*N, cMin=cx*N
  assert.deepEqual(chunk, region);
});

// THE SEAM INVARIANT: two horizontally-adjacent chunks are exactly the left and
// right halves of one directly-generated 2N-wide region -> the boundary is
// continuous (terrain same by connected side).
test('horizontally-adjacent chunks match a directly-generated region', () => {
  const world = { seed: 11, chunkSize: 16, tileTypes: BIOMES };
  const N = 16;
  const left = generateChunk(world, 0, 0);
  const right = generateChunk(world, 1, 0);
  const direct = generateRegion(world, 0, 0, N, 2 * N); // rows=N, cols=2N
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      assert.equal(left[r][c], direct[r][c], `left seam mismatch @${r},${c}`);
      assert.equal(right[r][c], direct[r][c + N], `right seam mismatch @${r},${c}`);
    }
  }
});

// The same invariant vertically (north/south seam).
test('vertically-adjacent chunks match a directly-generated region', () => {
  const world = { seed: 13, chunkSize: 16, tileTypes: BIOMES };
  const N = 16;
  const top = generateChunk(world, 0, 0);
  const bottom = generateChunk(world, 0, 1);
  const direct = generateRegion(world, 0, 0, 2 * N, N); // rows=2N, cols=N
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      assert.equal(top[r][c], direct[r][c], `top seam mismatch @${r},${c}`);
      assert.equal(bottom[r][c], direct[r + N][c], `bottom seam mismatch @${r},${c}`);
    }
  }
});

test('biomes are cohesive, not per-tile noise', () => {
  const world = { seed: 3, chunkSize: 60, tileTypes: BIOMES };
  const grid = generateChunk(world, 0, 0);
  let same = 0, total = 0;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 1; c < grid[r].length; c++) { total++; if (grid[r][c] === grid[r][c - 1]) same++; }
  }
  assert.ok(same / total > 0.6, `sameness ${same / total}`);
});
