const test = require('node:test');
const assert = require('node:assert');
const {
  worldConfig, collectPathCells, generateRegion, sampleBiomeRegion,
} = require('../src/services/mapService.js');

const TILE_TYPES = {
  grass: { walkable: true },
  dirt: { walkable: true },
  wooden_wall: { walkable: false },
  village_gate: { walkable: true },
  map_wall: { walkable: false },
  map_doorway: { walkable: true },
};

const WORLD_MULTI_VILLAGE = {
  seed: 1234,
  chunkSize: 16,
  width: 64,
  height: 64,
  tileTypes: TILE_TYPES,
  villages: [
    {
      minRow: 10,
      minCol: 10,
      width: 6,
      height: 6,
      gateEdge: 'S',
    },
    {
      minRow: 40,
      minCol: 40,
      width: 6,
      height: 6,
      gateEdge: 'N',
    },
  ],
  doorways: ['N', 'S', 'E', 'W'],
};

test('connecting roads link two villages starting from their gate exits', () => {
  const cfg = worldConfig(WORLD_MULTI_VILLAGE);
  const paths = collectPathCells(cfg, 0, 0, 64, 64);

  // Village 1 S gate is at row 10+6-1=15, col 10+3=13 -> exit is (16, 13)
  // Village 2 N gate is at row 40, col 40+3=43 -> exit is (39, 43)
  assert.ok(paths.has('16,13'), 'village 1 gate exit tile is part of the road network');
  assert.ok(paths.has('39,43'), 'village 2 gate exit tile is part of the road network');
  assert.ok(paths.has('16,43'), 'bend tile between villages is part of the road network');

  // Verify that an intermediate village-to-village road cell is drawn
  const region = generateRegion(WORLD_MULTI_VILLAGE, 25, 43, 1, 1);
  assert.equal(region[0][0], 'dirt');
});

test('connecting roads connect villages to world doorways', () => {
  const cfg = worldConfig(WORLD_MULTI_VILLAGE);
  const paths = collectPathCells(cfg, 0, 0, 64, 64);

  // Doorway N is at (0, 32)
  // Doorway S is at (63, 32)
  // Doorway W is at (32, 0)
  // Doorway E is at (32, 63)
  assert.ok(paths.has('0,32'), 'North doorway is connected to road network');
  assert.ok(paths.has('63,32'), 'South doorway is connected to road network');
  assert.ok(paths.has('32,0'), 'West doorway is connected to road network');
  assert.ok(paths.has('32,63'), 'East doorway is connected to road network');
});

test('a world with a single village connects to available doorways without throwing', () => {
  const single = {
    ...WORLD_MULTI_VILLAGE,
    villages: [WORLD_MULTI_VILLAGE.villages[0]],
  };
  const cfg = worldConfig(single);
  const paths = collectPathCells(cfg, 0, 0, 64, 64);

  assert.ok(paths.has('0,32'), 'North doorway is connected for single village');
  assert.ok(paths.has('16,13'), 'Village gate exit is connected');
});

// --- Per-biome road tiles (SOMET-349 follow-up) ---------------------------
//
// Two biomes with DIFFERENT road tiles and no terrain in common, so a cell's
// road tile identifies which biome owns it without ambiguity.
const BIOME_TILE_TYPES = {
  ...TILE_TYPES,
  grass: { walkable: true },
  highland_rock: { walkable: true },
  road_dirt: { walkable: true },
  road_stone: { walkable: true },
};
const TWO_BIOMES = [
  { name: 'Meadow', terrain_tiles: ['grass'], path_tile: 'road_dirt' },
  { name: 'Highlands', terrain_tiles: ['highland_rock'], path_tile: 'road_stone' },
];
const WORLD_TWO_BIOMES = {
  ...WORLD_MULTI_VILLAGE,
  tileTypes: BIOME_TILE_TYPES,
  biomes: TWO_BIOMES,
  biomeCell: 8,
};

test('roads are stamped in the road tile of the biome they cross, not the ambient path tile', () => {
  const cfg = worldConfig(WORLD_TWO_BIOMES);
  const paths = collectPathCells(cfg, 0, 0, 64, 64);
  const used = new Set(paths.values());

  // The ambient carvePaths tile is still `dirt` and still appears -- only the
  // village/doorway roads move to the road tiles.
  assert.ok(used.has('road_dirt') || used.has('road_stone'), 'roads use a road tile');
  assert.ok(used.has('road_dirt'), 'the Meadow stretches are road_dirt');
  assert.ok(used.has('road_stone'), 'the Highlands stretches are road_stone');
});

test('a road cell always agrees with the biome the terrain under it belongs to', () => {
  const cfg = worldConfig(WORLD_TWO_BIOMES);
  const paths = collectPathCells(cfg, 0, 0, 64, 64);
  const expected = { Meadow: 'road_dirt', Highlands: 'road_stone' };

  const mismatches = [];
  for (const [key, tile] of paths.entries()) {
    if (!String(tile).startsWith('road_')) continue;   // ambient carvePaths cell
    const [r, c] = key.split(',').map(Number);
    const region = sampleBiomeRegion(cfg, r, c);
    if (expected[region.name] !== tile) mismatches.push(`${key} ${region.name}=${tile}`);
  }
  assert.deepEqual(mismatches, []);
});

test('a biome with no road tile falls back to the ambient path tile', () => {
  const cfg = worldConfig({
    ...WORLD_TWO_BIOMES,
    biomes: [{ name: 'Meadow', terrain_tiles: ['grass'] }],
  });
  const paths = collectPathCells(cfg, 0, 0, 64, 64);
  const used = new Set(paths.values());
  assert.deepEqual([...used], ['dirt'], 'nothing but the pre-existing ambient tile');
});

test('a biome naming a road tile the world does not carry falls back rather than stamping it', () => {
  const cfg = worldConfig({
    ...WORLD_TWO_BIOMES,
    biomes: [{ name: 'Meadow', terrain_tiles: ['grass'], path_tile: 'road_obsidian' }],
  });
  const paths = collectPathCells(cfg, 0, 0, 64, 64);
  assert.ok(!new Set(paths.values()).has('road_obsidian'), 'never stamps an absent tile');
});

test('road tiles are kept out of sampled terrain', () => {
  const cfg = worldConfig(WORLD_TWO_BIOMES);
  assert.ok(!cfg.terrainNames.some((n) => n.startsWith('road_')),
    'the global terrain band excludes road tiles');
  for (const b of cfg.biomes) {
    assert.ok(!b.terrainNames.some((n) => n.startsWith('road_')),
      `${b.name} terrain excludes road tiles`);
  }
});

test('a world without villages generates no extra connecting roads', () => {
  const noVillage = {
    seed: 1234,
    chunkSize: 16,
    width: 64,
    height: 64,
    tileTypes: TILE_TYPES,
  };
  const cfg = worldConfig(noVillage);
  assert.equal(cfg.generatedRoads.length, 0);
});
