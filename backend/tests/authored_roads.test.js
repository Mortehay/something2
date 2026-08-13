const test = require('node:test');
const assert = require('node:assert');
const {
  worldConfig, collectPathCells, generateRegion, normalizeAuthoredRoads,
} = require('../src/services/mapService.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');

// `dirt` matters: PATH_NAME_RE auto-detects a tile named path/dirt/road/trail/
// earth/sand as THE path tile. A fixture whose only tile is `grass` has
// cfg.pathTile === null, collectPathCells returns an empty Set, and every
// assertion below would pass vacuously.
const TILE_TYPES = { grass: { walkable: true }, dirt: { walkable: true } };
const WORLD = {
  seed: 4242, chunkSize: 16, width: 48, height: 48, tileTypes: TILE_TYPES,
};

const cellsOf = (world) => collectPathCells(worldConfig(world), 0, 0, world.height, world.width);

test('the fixture already has a derived lattice — otherwise "union" proves nothing', () => {
  // Every test below distinguishes authored cells from lattice cells. If the
  // lattice were empty the union would be indistinguishable from a replacement.
  assert.ok(cellsOf(WORLD).size > 0, 'no derived path cells in the fixture');
});

test('an authored polyline adds exactly the cells between its points', () => {
  const bare = cellsOf(WORLD);
  const withRoad = cellsOf({ ...WORLD, authoredRoads: [[[10, 5], [10, 9]]] });
  for (let c = 5; c <= 9; c++) {
    assert.ok(withRoad.has(`10,${c}`), `authored cell (10,${c}) missing`);
  }
  // And nothing else: the difference is precisely the five authored cells.
  const added = [...withRoad].filter((k) => !bare.has(k));
  assert.deepEqual(added.sort(), ['10,5', '10,6', '10,7', '10,8', '10,9'].filter((k) => !bare.has(k)).sort());
});

test('a multi-segment polyline turns corners without dropping the joint', () => {
  // The corner cell belongs to both segments. A walker that emitted only the
  // interior of each segment would leave a one-tile hole exactly where the road
  // bends -- which is where every authored road in the home region bends around
  // a village.
  const cells = cellsOf({ ...WORLD, authoredRoads: [[[4, 4], [4, 8], [7, 8]]] });
  for (const key of ['4,4', '4,5', '4,6', '4,7', '4,8', '5,8', '6,8', '7,8']) {
    assert.ok(cells.has(key), `missing ${key}`);
  }
});

test('a polyline is walked in either direction', () => {
  const forward = cellsOf({ ...WORLD, authoredRoads: [[[3, 2], [3, 6]]] });
  const backward = cellsOf({ ...WORLD, authoredRoads: [[[3, 6], [3, 2]]] });
  assert.deepEqual([...backward].sort(), [...forward].sort());
});

test('authored cells outside the requested window are clipped away', () => {
  // collectPathCells is called per CHUNK by generateRegion, so a road crossing
  // the whole map must not leak cells into a window that does not contain them
  // -- the caller uses membership to decide what to draw at a given coordinate.
  const cfg = worldConfig({ ...WORLD, authoredRoads: [[[10, 0], [10, 47]]] });
  const window = collectPathCells(cfg, 8, 4, 4, 4);   // rows 8..11, cols 4..7
  for (const key of window) {
    const [r, c] = key.split(',').map(Number);
    assert.ok(r >= 8 && r < 12 && c >= 4 && c < 8, `cell ${key} escaped the window`);
  }
  for (let c = 4; c < 8; c++) assert.ok(window.has(`10,${c}`), `missing 10,${c}`);
});

test('no authored roads leaves the derived lattice byte-for-byte unchanged', () => {
  // The compatibility guarantee for all 86 existing worlds, stated as a test.
  const bare = [...cellsOf(WORLD)].sort();
  for (const empty of [undefined, null, []]) {
    assert.deepEqual([...cellsOf({ ...WORLD, authoredRoads: empty })].sort(), bare,
      `authoredRoads ${JSON.stringify(empty)} changed the lattice`);
  }
});

test('an authored road is DRAWN, not merely marked safe', () => {
  // The whole reason the union happens in collectPathCells rather than in
  // safeRegion: generateRegion stamps cfg.pathTile on whatever that returns, so
  // the corridor the player is safe on is the corridor the player can see. A
  // road that is safe but invisible reads as an arbitrary monster-free blob.
  const world = { ...WORLD, authoredRoads: [[[20, 10], [20, 14]]] };
  const grid = generateRegion(world, 20, 10, 1, 5);
  assert.deepEqual(grid[0], ['dirt', 'dirt', 'dirt', 'dirt', 'dirt']);

  // Without the authored road the same five tiles are not all path -- otherwise
  // the assertion above would hold for reasons unrelated to this feature.
  const bare = generateRegion(WORLD, 20, 10, 1, 5);
  assert.notDeepEqual(bare[0], ['dirt', 'dirt', 'dirt', 'dirt', 'dirt']);
});

test('a world with no path tile draws no authored road either', () => {
  // An authored road on a world the generator cannot draw a path on would be a
  // safe corridor with nothing on screen to explain it.
  const cfg = worldConfig({
    ...WORLD, tileTypes: { grass: { walkable: true }, stone: { walkable: true } },
    authoredRoads: [[[10, 5], [10, 9]]],
  });
  assert.equal(cfg.pathTile, null);
  assert.equal(collectPathCells(cfg, 0, 0, 48, 48).size, 0);
});

test('a malformed authored road throws rather than silently not existing', () => {
  const cases = [
    [[[[0, 0], [2, 2]]], /not axis-aligned/],          // diagonal segment
    [[[[0, 0], [0, '3']]], /pair of integers/],         // a string coordinate
    [[[[0, 0], [0]]], /pair of integers/],              // a one-element point
    [[[]], /non-empty array/],                          // an empty polyline
    [['10,5'], /non-empty array/],                      // a string instead of a line
    ['nope', /must be an array/],                       // not an array at all
  ];
  for (const [roads, re] of cases) {
    assert.throws(() => normalizeAuthoredRoads(roads), re, `accepted ${JSON.stringify(roads)}`);
    // And through the real door the generator uses, not just the helper.
    assert.throws(() => worldConfig({ ...WORLD, authoredRoads: roads }), re,
      `worldConfig accepted ${JSON.stringify(roads)}`);
  }
});

test('buildWorldGenConfig carries authored_roads from the row to the generator', () => {
  // The silent client/server divergence buildWorldGenConfig's header warns
  // about: a column mapped in neither the chunk endpoint nor the authority is a
  // road the client draws and the server does not, or the reverse.
  const row = {
    seed: 4242, chunk_size: 16, width: 48, height: 48,
    level_min: 1, level_max: 2, biome_cell: null,
    authored_roads: [[[10, 5], [10, 9]]],
  };
  const cfg = buildWorldGenConfig({ row, tileTypes: TILE_TYPES, doorways: [], villages: [], biomes: [] });
  assert.deepEqual(cfg.authoredRoads, [[[10, 5], [10, 9]]]);
  assert.ok(collectPathCells(worldConfig(cfg), 0, 0, 48, 48).has('10,7'));

  // A row from before the migration must come out opted OUT, never undefined.
  const bare = buildWorldGenConfig({
    row: { ...row, authored_roads: undefined },
    tileTypes: TILE_TYPES, doorways: [], villages: [], biomes: [],
  });
  assert.deepEqual(bare.authoredRoads, []);
});
