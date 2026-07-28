const test = require('node:test');
const assert = require('node:assert');
const {
  worldConfig, sampleBiomeRegion, sampleTerrain, generateRegion,
} = require('../src/services/mapService');
const GOLDEN = require('./fixtures/terrain-golden-preBiome.json');

// Raw biome records in the shape services/biomes.js returns.
const DUNES = {
  name: 'Arid Dunes', terrain_tiles: ['sand', 'rocks'],
  flora_types: ['dead_tree'], creature_types: ['Skeleton'],
};
const WASTE = {
  name: 'Frozen Waste', terrain_tiles: ['snow', 'ice'],
  flora_types: ['IceRock'], creature_types: ['Bat'],
};

const TILE_TYPES = {
  grass: { walkable: true, speed: 1 },
  sand: { walkable: true, speed: 1 },
  rocks: { walkable: true, speed: 1 },
  snow: { walkable: true, speed: 1 },
  ice: { walkable: true, speed: 1 },
  map_wall: { walkable: false, speed: 1 },
};

function biomeWorld(over = {}) {
  return {
    seed: 4242, chunkSize: 16, cellSize: 8, pathTile: null,
    tileTypes: TILE_TYPES, biomes: [DUNES, WASTE], biomeCell: 12,
    ...over,
  };
}

test('BACK-COMPAT: a world with no biomes generates byte-identically to before', () => {
  // The fixture was produced by the pre-biome generator. Any change to the
  // legacy sampling path shows up here.
  const grid = generateRegion(GOLDEN.world, 0, 0, GOLDEN.grid.length, GOLDEN.grid[0].length);
  assert.deepEqual(grid, GOLDEN.grid);
});

test('worldConfig exposes terrainNames (biomeNames is gone)', () => {
  const cfg = worldConfig(biomeWorld({ biomes: [] }));
  assert.ok(Array.isArray(cfg.terrainNames));
  assert.ok(cfg.terrainNames.includes('grass'));
  assert.equal(cfg.biomeNames, undefined, 'the old name must not linger as an alias');
});

test('worldConfig normalizes biome records and filters their terrain lists', () => {
  const cfg = worldConfig(biomeWorld({
    biomes: [{ ...DUNES, terrain_tiles: ['sand', 'map_wall', 'atlantis'] }],
  }));
  assert.equal(cfg.biomes.length, 1);
  assert.deepEqual(cfg.biomes[0].terrainNames, ['sand'],
    'structural and unknown tiles are dropped');
  assert.deepEqual(cfg.biomes[0].floraTypes, ['dead_tree']);
  assert.deepEqual(cfg.biomes[0].creatureTypes, ['Skeleton']);
});

test('worldConfig drops the path tile from a biome terrain list', () => {
  const cfg = worldConfig(biomeWorld({
    pathTile: 'sand', biomes: [{ ...DUNES, terrain_tiles: ['sand', 'rocks'] }],
  }));
  assert.deepEqual(cfg.biomes[0].terrainNames, ['rocks']);
});

test('EXCLUSION: every generated tile belongs to the biome that owns its cell', () => {
  const world = biomeWorld();
  const cfg = worldConfig(world);
  const grid = generateRegion(world, 0, 0, 48, 48);
  let checked = 0;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const region = sampleBiomeRegion(cfg, r, c);
      assert.ok(region, 'a world with biomes must always resolve a region');
      assert.ok(region.terrainNames.includes(grid[r][c]),
        `tile ${grid[r][c]} at (${r},${c}) is not in ${region.name}`);
      checked++;
    }
  }
  assert.equal(checked, 48 * 48);
});

test('EXCLUSION is real: both biomes actually occur in the sampled window', () => {
  // Without this, the test above would pass trivially if one biome swallowed
  // the whole window.
  const cfg = worldConfig(biomeWorld());
  const seen = new Set();
  for (let r = 0; r < 48; r++) for (let c = 0; c < 48; c++) seen.add(sampleBiomeRegion(cfg, r, c).name);
  assert.deepEqual([...seen].sort(), ['Arid Dunes', 'Frozen Waste']);
});

test('regions are coherent, not per-tile confetti', () => {
  const cfg = worldConfig(biomeWorld());
  let same = 0, total = 0;
  for (let r = 0; r < 48; r++) {
    for (let c = 0; c < 47; c++) {
      if (sampleBiomeRegion(cfg, r, c).name === sampleBiomeRegion(cfg, r, c + 1).name) same++;
      total++;
    }
  }
  assert.ok(same / total > 0.9, `horizontal neighbours agree only ${(same / total * 100).toFixed(1)}% of the time`);
});

test('seamless: the same absolute cell samples identically from any window', () => {
  const world = biomeWorld();
  const cfg = worldConfig(world);
  // Absolute cell (20, 31), reached from two different generation windows.
  const fromA = generateRegion(world, 16, 16, 16, 16)[4][15];
  const fromB = generateRegion(world, 20, 31, 1, 1)[0][0];
  assert.equal(fromA, fromB);
  assert.equal(sampleTerrain(cfg, 20, 31), fromA);
});

test('deterministic: same seed, same output; different seed, different output', () => {
  const a = generateRegion(biomeWorld(), 0, 0, 16, 16);
  const b = generateRegion(biomeWorld(), 0, 0, 16, 16);
  assert.deepEqual(a, b);
  const c = generateRegion(biomeWorld({ seed: 999 }), 0, 0, 16, 16);
  assert.notDeepEqual(a, c);
});

test('DEGENERATE: a biome whose tiles are all unknown falls back to global terrain', () => {
  const world = biomeWorld({ biomes: [{ name: 'Void', terrain_tiles: ['nope', 'map_wall'], flora_types: [], creature_types: [] }] });
  const cfg = worldConfig(world);
  const grid = generateRegion(world, 0, 0, 8, 8);
  for (const row of grid) {
    for (const t of row) {
      assert.ok(typeof t === 'string' && t.length > 0, 'never undefined');
      assert.ok(cfg.terrainNames.includes(t), `${t} should come from the global fallback list`);
    }
  }
});

test('sampleBiomeRegion returns null when the world declares no biomes', () => {
  const cfg = worldConfig(biomeWorld({ biomes: [] }));
  assert.equal(sampleBiomeRegion(cfg, 3, 7), null);
});

test('biomeCell: explicit value wins', () => {
  assert.equal(worldConfig(biomeWorld({ biomeCell: 17 })).biomeCell, 17);
});

test('biomeCell: derived from bounds when null, so a small world still shows regions', () => {
  const cfg = worldConfig(biomeWorld({ biomeCell: null, width: 30, height: 30 }));
  assert.equal(cfg.biomeCell, 10); // floor(min(30,30)/3)
});

test('biomeCell: derived value never drops below 8', () => {
  const cfg = worldConfig(biomeWorld({ biomeCell: null, width: 12, height: 9 }));
  assert.equal(cfg.biomeCell, 8);
});

test('biomeCell: unbounded worlds fall back to 24', () => {
  const cfg = worldConfig(biomeWorld({ biomeCell: null }));
  assert.equal(cfg.biomeCell, 24);
});

test('the biome field is decorrelated from the terrain field', () => {
  // If both fields used the same seed, region borders would sit exactly on
  // terrain-band borders and the two-level sampler would collapse to one level.
  const cfg = worldConfig(biomeWorld({ biomeCell: 8 })); // same cell size as terrain
  let agree = 0, total = 0;
  for (let r = 0; r < 40; r++) {
    for (let c = 0; c < 40; c++) {
      const regionIdx = cfg.biomes.indexOf(sampleBiomeRegion(cfg, r, c));
      const tile = sampleTerrain(cfg, r, c);
      const tileIdx = cfg.biomes[regionIdx].terrainNames.indexOf(tile);
      if (regionIdx === tileIdx) agree++;
      total++;
    }
  }
  assert.ok(agree / total < 0.95, 'biome and terrain fields look like the same field');
});
