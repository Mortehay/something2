const test = require('node:test');
const assert = require('node:assert');
const {
  worldConfig, collectPathCells, generateRegion,
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
  assert.equal(region[0][0], 'grass_road');
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
