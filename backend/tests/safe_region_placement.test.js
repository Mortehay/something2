const test = require('node:test');
const assert = require('node:assert');
const {
  placeMapCreatures, placeCreaturePacks, worldConfig, collectPathCells,
  CREATURE_TILE_PX,
} = require('../src/services/mapService.js');

const TYPES = [
  { name: 'Wolf', hp: 12, defense: 0, resistances: {} },
  { name: 'Bat', hp: 8, defense: 0, resistances: {} },
];

// `dirt` matters: PATH_NAME_RE in mapService.js auto-detects a tile named
// path/dirt/road/trail/earth/sand as THE path tile. A fixture whose only tile
// is `grass` has cfg.pathTile === null, collectPathCells returns an empty Set,
// and every road assertion below would pass vacuously.
const WORLD = {
  seed: 999, chunkSize: 16, width: 48, height: 48,
  levelMin: 1, levelMax: 2,
  tileTypes: { grass: { walkable: true }, dirt: { walkable: true } },
};

const tileOf = (c) => [
  Math.floor(c.y / CREATURE_TILE_PX),
  Math.floor(c.x / CREATURE_TILE_PX),
];

function roadCells(world) {
  const cfg = worldConfig(world);
  return collectPathCells(cfg, 0, 0, world.height, world.width);
}

test('the fixture actually has roads — otherwise every road test below is vacuous', () => {
  assert.ok(roadCells(WORLD).size > 0, 'no carved path cells in the fixture');
});

// Pinned from a run of placeMapCreatures/placeCreaturePacks against the
// mapService.js that existed BEFORE this file's production change (safe
// region generation, SOMET-288) -- captured via a throwaway script, not
// derived from any code in this repo. A same-run "before vs. after" compare
// (see below) would still pass if some future change altered BOTH calls
// identically; this pins the actual pre-existing behaviour so drift in
// either the scatter or pack RNG path at radius 0 is caught for real.
const GOLDEN_SCATTERED_TILES = [
  [26, 13], [31, 14], [16, 28], [28, 46], [40, 10], [9, 11], [6, 10], [27, 23],
  [6, 40], [32, 15], [46, 5], [36, 22], [44, 11], [5, 17], [43, 32], [37, 40],
  [6, 36], [40, 46], [44, 32], [20, 38], [32, 35], [31, 20], [27, 3], [13, 26],
  [1, 30], [1, 33], [32, 25], [20, 36], [45, 11], [22, 41], [16, 8], [5, 18],
  [30, 6], [41, 6], [25, 3], [3, 42], [21, 12], [20, 29], [3, 38], [26, 32],
];
const GOLDEN_PACKED_TILES = [
  [24, 33], [24, 31], [27, 29], [20, 30], [24, 30], [20, 32],
  [21, 10], [23, 13], [19, 9], [17, 11], [20, 14], [18, 9],
];

test('with radius 0, placement is byte-for-byte what it was before safe regions', () => {
  // The compatibility guarantee for all 86 existing worlds, stated as a test:
  // an opted-out world must not merely "avoid roads less" -- it must produce
  // the identical list, because the placement RNG stream is shared and every
  // extra rejection shifts everything after it.
  const before = placeMapCreatures({ ...WORLD }, 40, TYPES, 4242);
  const after = placeMapCreatures({ ...WORLD, safeRoadRadius: 0 }, 40, TYPES, 4242);
  assert.ok(before.length > 0, 'fixture placed nothing — this test would assert nothing');
  assert.deepEqual(after.map(tileOf), before.map(tileOf));
  assert.deepEqual(before.map(tileOf), GOLDEN_SCATTERED_TILES);

  const packedBefore = placeCreaturePacks(WORLD, [{ size: 6 }, { size: 6 }], TYPES, 4242);
  assert.deepEqual(packedBefore.map(tileOf), GOLDEN_PACKED_TILES);
});

test('no scattered creature lands within the safe road corridor', () => {
  const world = { ...WORLD, safeRoadRadius: 2 };
  const roads = roadCells(world);
  const placed = placeMapCreatures(world, 60, TYPES, 4242);
  assert.ok(placed.length > 0, 'fixture placed nothing — this test would assert nothing');
  for (const c of placed) {
    const [row, col] = tileOf(c);
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        assert.ok(!roads.has(`${row + dr},${col + dc}`),
          `creature at (${row},${col}) is within 2 tiles of road cell (${row + dr},${col + dc})`);
      }
    }
  }
});

test('no packed creature lands within the safe road corridor either', () => {
  // placeCreaturePacks is the SECOND caller of creatureTileCandidates. A fix
  // applied to the scatter path alone would leave packs spawning on roads --
  // the two-write-paths failure this repo has shipped before (SOMET-153).
  const world = { ...WORLD, safeRoadRadius: 2 };
  const roads = roadCells(world);
  const placed = placeCreaturePacks(world, [{ size: 6 }, { size: 6 }], TYPES, 4242);
  assert.ok(placed.length > 0, 'fixture placed nothing — this test would assert nothing');
  for (const c of placed) {
    const [row, col] = tileOf(c);
    assert.ok(!roads.has(`${row},${col}`), `packed creature on road cell (${row},${col})`);
  }
});

test('no creature lands inside an authored safe rectangle', () => {
  const rect = { minRow: 20, minCol: 20, width: 8, height: 8 };
  const world = { ...WORLD, safeRects: [rect] };
  const placed = placeMapCreatures(world, 80, TYPES, 4242);
  assert.ok(placed.length > 0, 'fixture placed nothing — this test would assert nothing');
  for (const c of placed) {
    const [row, col] = tileOf(c);
    const inside = row >= rect.minRow && row <= rect.minRow + rect.height - 1
                && col >= rect.minCol && col <= rect.minCol + rect.width - 1;
    assert.ok(!inside, `creature at (${row},${col}) is inside the safe rectangle`);
  }
});

test('the village exclusion that existed before still holds', () => {
  // isSafeTile subsumes villageContaining; this pins that the replacement did
  // not quietly drop the older rule.
  const village = { minRow: 10, minCol: 10, width: 6, height: 4 };
  const world = { ...WORLD, villages: [village] };
  const placed = placeMapCreatures(world, 80, TYPES, 4242);
  assert.ok(placed.length > 0, 'fixture placed nothing — this test would assert nothing');
  for (const c of placed) {
    const [row, col] = tileOf(c);
    const inside = row >= village.minRow && row <= village.minRow + village.height - 1
                && col >= village.minCol && col <= village.minCol + village.width - 1;
    assert.ok(!inside, `creature at (${row},${col}) is inside the village`);
  }
});
