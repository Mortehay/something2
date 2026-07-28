const test = require('node:test');
const assert = require('node:assert');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig');
const { worldConfig, generateRegion } = require('../src/services/mapService');

const ROW = {
  id: 'w1', seed: '777', chunk_size: 16, width: 30, height: 30,
  entry_spawn: { x: 1500, y: 1500 }, biome_cell: null,
};
const TILE_TYPES = {
  grass: { walkable: true, speed: 1 },
  // Deliberately not "sand": PATH_NAME_RE in mapService.js treats any tile
  // name matching /path|dirt|road|trail|earth|sand/i as the auto-detected
  // path tile (see biomeSampler.test.js's `pathTile: 'sand'` case), and
  // buildWorldGenConfig doesn't pass a pathTile override through. "sand"
  // here would get carved as a path tile regardless of biome, breaking the
  // "belongs to no biome" assertion below for a reason unrelated to biomes.
  stone: { walkable: true, speed: 1 },
  snow: { walkable: true, speed: 1 },
};
const BIOMES = [
  { name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'], creature_types: ['Slime'] },
  { name: 'Frozen Waste', terrain_tiles: ['snow'], flora_types: [], creature_types: ['Bat'] },
];

function cfgArgs(over = {}) {
  return { row: ROW, tileTypes: TILE_TYPES, doorways: [], villages: [], biomes: BIOMES, ...over };
}

test('coerces the seed to a number (the column is bigint -> string)', () => {
  const c = buildWorldGenConfig(cfgArgs());
  assert.strictEqual(c.seed, 777);
});

test('carries every field the generator reads', () => {
  const c = buildWorldGenConfig(cfgArgs());
  assert.deepEqual(Object.keys(c).sort(), [
    'biomeCell', 'biomes', 'chunkSize', 'doorways', 'entry_spawn',
    'height', 'seed', 'tileTypes', 'villages', 'width',
  ]);
  assert.equal(c.chunkSize, 16);
  assert.equal(c.width, 30);
  assert.equal(c.height, 30);
  assert.deepEqual(c.entry_spawn, { x: 1500, y: 1500 });
  assert.deepEqual(c.biomes, BIOMES);
});

test('a null biome_cell reaches worldConfig as null so it derives from bounds', () => {
  const c = buildWorldGenConfig(cfgArgs());
  assert.equal(c.biomeCell, null);
  assert.equal(worldConfig(c).biomeCell, 10); // floor(min(30,30)/3)
});

test('an explicit biome_cell is passed through', () => {
  const c = buildWorldGenConfig(cfgArgs({ row: { ...ROW, biome_cell: 15 } }));
  assert.equal(c.biomeCell, 15);
  assert.equal(worldConfig(c).biomeCell, 15);
});

test('the built config generates real biome-restricted terrain', () => {
  const c = buildWorldGenConfig(cfgArgs());
  const grid = generateRegion(c, 2, 2, 20, 20);
  const seen = new Set(grid.flat());
  assert.ok(!seen.has('stone'), 'stone belongs to no biome here and must not appear');
  assert.ok(seen.has('grass') || seen.has('snow'));
});

test('a missing biome_cell field produces exactly null, not undefined', () => {
  // assert.equal (loose ==) treats null and undefined as equal, so the tests
  // above alone don't pin this: a `biomeCell: row.biome_cell` passthrough
  // (dropping the Number.isFinite guard entirely) still satisfies
  // `assert.equal(c.biomeCell, null)` above because `undefined == null`, yet
  // would hand worldConfig `undefined` -- the two are NOT equivalent inputs
  // to worldConfig's `Number.isFinite(world.biomeCell)` check, they just
  // happen to both fail it the same way here. Pin the exact value with
  // assert.strictEqual so removing the guard fails loudly.
  const { biome_cell, ...rowWithoutBiomeCell } = ROW;
  const c = buildWorldGenConfig(cfgArgs({ row: rowWithoutBiomeCell }));
  assert.strictEqual(c.biomeCell, null);
  assert.strictEqual(worldConfig(c).biomeCell, 10); // floor(min(30,30)/3)
});

test('a world with no biomes builds an empty biome list, not undefined', () => {
  const c = buildWorldGenConfig(cfgArgs({ biomes: [] }));
  assert.deepEqual(c.biomes, []);
  assert.deepEqual(worldConfig(c).biomes, []);
});
