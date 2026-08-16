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
//
// RE-PINNED for SOMET-350 (Task 3): the density gate consumes one extra rng()
// draw per attempt in both placers, which shifts the shared stream for every
// draw after it. This is exactly the "already-seeded worlds are unaffected,
// newly-seeded ones lay out differently" tradeoff the gate's own comment in
// mapService.js documents -- expected churn, not a regression. The invariant
// this test actually protects (radius-0 scatter/pack output is byte-for-byte
// identical whether safeRoadRadius is omitted or explicitly 0) was verified
// to still hold against the new values before pinning them.
const GOLDEN_SCATTERED_TILES = [
  [24, 31], [10, 30], [6, 10], [20, 27], [6, 40], [15, 40], [23, 28], [29, 44],
  [20, 38], [35, 8], [30, 1], [40, 32], [40, 45], [20, 16], [5, 18], [6, 9],
  [10, 3], [36, 3], [21, 12], [29, 10], [23, 21], [5, 23], [45, 34], [11, 32],
  [1, 34], [17, 37], [44, 18], [29, 24], [38, 24], [6, 3], [20, 7], [38, 32],
  [21, 16], [41, 16], [28, 35], [24, 39], [8, 21], [39, 29], [33, 36], [44, 26],
];
const GOLDEN_PACKED_TILES = [
  [31, 25], [27, 27], [28, 23], [28, 22], [30, 27], [28, 27],
  [14, 18], [10, 17], [15, 15], [12, 21], [15, 19], [15, 17],
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
  //
  // Checks the same radius-2 neighbourhood the scatter test above checks, not
  // merely the exact cell -- a weaker assertion here would let a pack member
  // land one or two tiles off a road while the scatter test's stronger check
  // caught the identical placement. Tightened for symmetry (fix wave, Minor
  // 5): the stronger assertion already passed (12 packs, 0 violations), so
  // this is not a bug fix, just closing the gap between the two tests.
  const world = { ...WORLD, safeRoadRadius: 2 };
  const roads = roadCells(world);
  const placed = placeCreaturePacks(world, [{ size: 6 }, { size: 6 }], TYPES, 4242);
  assert.ok(placed.length > 0, 'fixture placed nothing — this test would assert nothing');
  for (const c of placed) {
    const [row, col] = tileOf(c);
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        assert.ok(!roads.has(`${row + dr},${col + dc}`),
          `packed creature at (${row},${col}) is within 2 tiles of road cell (${row + dr},${col + dc})`);
      }
    }
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

// SOMET-288 review, finding 4. Regression, with the exact shape confirmed
// live: a config whose safeRects came straight off the `worlds` jsonb column
// (snake_case, never converted by buildWorldGenConfig) placed 80 of 80
// creatures with the rectangle having zero effect, because inBox compared
// every coordinate against `undefined`.
//
// Driven through placeMapCreatures rather than buildSafeContext directly:
// worldConfig() sits between them and used to coerce a bad value away before
// the validator saw it, so a unit test on the validator alone would have gone
// green while this path stayed silent.
test('a malformed safe rect makes placement throw instead of quietly placing everywhere', () => {
  const world = { ...WORLD, safeRects: [{ min_row: 20, min_col: 20, width: 8, height: 8 }] };
  assert.throws(() => placeMapCreatures(world, 80, TYPES, 4242),
    /safeRects\[0\]\.minRow must be an integer/);
  // The pack placer is the second caller of creatureTileCandidates and must
  // not be the one path where a malformed rect still passes.
  assert.throws(() => placeCreaturePacks(world, [{ size: 6 }], TYPES, 4242),
    /safeRects\[0\]\.minRow must be an integer/);

  // Non-vacuous: the SAME rectangle spelled correctly places creatures and
  // keeps them out of the box, so the throw above is about the spelling and
  // not about this fixture being unplaceable.
  const fixed = { ...WORLD, safeRects: [{ minRow: 20, minCol: 20, width: 8, height: 8 }] };
  assert.ok(placeMapCreatures(fixed, 80, TYPES, 4242).length > 0);
});

test('a non-array safeRects throws rather than being flattened to "no rectangles"', () => {
  // The one-object-instead-of-a-list typo. worldConfig used to turn this into
  // [], so the world came out with no safe territory and no complaint.
  const world = { ...WORLD, safeRects: { minRow: 20, minCol: 20, width: 8, height: 8 } };
  assert.throws(() => placeMapCreatures(world, 80, TYPES, 4242), /safeRects must be an array/);
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
