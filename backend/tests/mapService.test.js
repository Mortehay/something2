const test = require('node:test');
const assert = require('node:assert');

const {
  generateWorld,
  detectPathTile,
  valueNoise,
  makeRng,
  placeEntities,
} = require('../src/services/mapService');

// Build a rows x cols grid filled with `tile`.
function fillGrid(rows, cols, tile) {
  return Array.from({ length: rows }, () => Array(cols).fill(tile));
}

// Fraction of placed cells that have an orthogonal neighbor also placed.
function clumpiness(placed, rows, cols) {
  const set = new Set(placed.map((p) => p.row * cols + p.col));
  let clumped = 0;
  for (const p of placed) {
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => {
      const r = p.row + dr, c = p.col + dc;
      return r >= 0 && r < rows && c >= 0 && c < cols && set.has(r * cols + c);
    });
    if (n) clumped++;
  }
  return placed.length ? clumped / placed.length : 0;
}

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

// --- placeEntities --------------------------------------------------------

const TREE = { name: 'Tree', chance: 0.2, spawnTiles: ['grass'] };

test('placeEntities clusters objects instead of scattering them', () => {
  const tiles = fillGrid(50, 50, 'grass');
  const { placed } = placeEntities(tiles, [TREE], { seed: 4, clearings: 0, landmarks: 0 });
  assert.ok(placed.length > 0, 'expected some placements');
  // Clustered placement neighbors itself far more than uniform 0.2-density scatter.
  assert.ok(clumpiness(placed, 50, 50) > 0.6, `clumpiness ${clumpiness(placed, 50, 50)}`);
});

test('placeEntities is deterministic per seed', () => {
  const tiles = fillGrid(30, 30, 'grass');
  const a = placeEntities(tiles, [TREE], { seed: 9 }).placed.map((p) => `${p.row},${p.col}`);
  const b = placeEntities(tiles, [TREE], { seed: 9 }).placed.map((p) => `${p.row},${p.col}`);
  assert.deepEqual(a, b);
});

test('placeEntities never places on path tiles', () => {
  const tiles = fillGrid(30, 30, 'grass');
  for (let r = 0; r < 30; r++) tiles[r][10] = 'dirt'; // a dirt column = a path
  const treeAnywhere = { name: 'Tree', chance: 0.9, spawnTiles: ['grass', 'dirt'] };
  const { placed } = placeEntities(tiles, [treeAnywhere], { seed: 2, pathTiles: ['dirt'] });
  assert.ok(placed.every((p) => p.col !== 10), 'no object should land on the dirt path');
});

test('placeEntities respects spawnTiles', () => {
  const tiles = fillGrid(30, 30, 'grass');
  for (let r = 0; r < 30; r++) for (let c = 15; c < 30; c++) tiles[r][c] = 'water';
  const { placed } = placeEntities(tiles, [TREE], { seed: 1, clearings: 0 });
  assert.ok(placed.every((p) => tiles[p.row][p.col] === 'grass'), 'only spawns on grass');
});

test('placeEntities clearings carve out empty regions', () => {
  const tiles = fillGrid(40, 40, 'grass');
  const dense = { name: 'Tree', chance: 0.6, spawnTiles: ['grass'] };
  const { placed, clearings } = placeEntities(tiles, [dense], { seed: 6, clearings: 2, landmarks: 0 });
  // The immediate center of each clearing must be object-free.
  const set = new Set(placed.map((p) => `${p.row},${p.col}`));
  for (const [cr, cc] of clearings) assert.ok(!set.has(`${cr},${cc}`), 'clearing center is open');
});
