const test = require('node:test');
const assert = require('node:assert');

const {
  generateWorld,
  detectPathTile,
  valueNoise,
  makeRng,
} = require('../src/services/mapService');

// Tiles with NO path-like name -> pure biomes (no path carving), so we can
// measure biome cohesion cleanly.
const BIOME_TILES = {
  grass: { validNeighbors: [] },
  forest: { validNeighbors: [] },
  water: { validNeighbors: [] },
  meadow: { validNeighbors: [] },
};

// Fraction of horizontal neighbors that share the same tile type.
function neighborSameness(grid) {
  let same = 0, total = 0;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 1; c < grid[r].length; c++) {
      total++;
      if (grid[r][c] === grid[r][c - 1]) same++;
    }
  }
  return same / total;
}

test('generateWorld returns a rows x cols grid of valid tile names', () => {
  const grid = generateWorld(30, 40, BIOME_TILES, { seed: 1 });
  assert.equal(grid.length, 30);
  assert.equal(grid[0].length, 40);
  const names = Object.keys(BIOME_TILES);
  for (const row of grid) for (const cell of row) assert.ok(names.includes(cell));
});

test('generateWorld is deterministic per seed', () => {
  const a = generateWorld(25, 25, BIOME_TILES, { seed: 42 });
  const b = generateWorld(25, 25, BIOME_TILES, { seed: 42 });
  assert.deepEqual(a, b);
});

test('different seeds produce different maps', () => {
  const a = generateWorld(25, 25, BIOME_TILES, { seed: 42 });
  const b = generateWorld(25, 25, BIOME_TILES, { seed: 99 });
  assert.notDeepEqual(a, b);
});

test('biomes are cohesive, not per-tile noise', () => {
  const grid = generateWorld(60, 60, BIOME_TILES, { seed: 7 });
  // Random assignment over 4 tiles ~ 0.25 sameness; cohesive regions >> that.
  assert.ok(neighborSameness(grid) > 0.6, `sameness ${neighborSameness(grid)}`);
});

test('paths are carved when a path-like tile exists', () => {
  const tiles = { grass: {}, forest: {}, dirt: {}, water: {} };
  const grid = generateWorld(50, 50, tiles, { seed: 3, anchors: 5 });
  let dirt = 0;
  for (const row of grid) for (const cell of row) if (cell === 'dirt') dirt++;
  assert.ok(dirt > 0, 'expected carved dirt path tiles');
});

test('detectPathTile prefers a path-like name, honors override, else null', () => {
  assert.equal(detectPathTile(['grass', 'dirt', 'water']), 'dirt');
  assert.equal(detectPathTile(['grass', 'road']), 'road');
  assert.equal(detectPathTile(['grass', 'dirt'], 'grass'), 'grass'); // override wins
  assert.equal(detectPathTile(['grass', 'forest']), null);           // none path-like
});

test('valueNoise is smooth (adjacent samples stay close)', () => {
  const rng = makeRng(5);
  const f = valueNoise(40, 40, 8, rng);
  let maxJump = 0;
  for (let r = 0; r < 40; r++) {
    for (let c = 1; c < 40; c++) maxJump = Math.max(maxJump, Math.abs(f[r][c] - f[r][c - 1]));
  }
  assert.ok(maxJump < 0.35, `noise not smooth, maxJump ${maxJump}`);
});

test('empty tileTypes falls back to a grass grid', () => {
  const grid = generateWorld(5, 5, {}, { seed: 1 });
  assert.equal(grid.length, 5);
  assert.ok(grid.every((row) => row.every((c) => c === 'grass')));
});
