const test = require('node:test');
const assert = require('node:assert');
const { graphPosition, GRID_SPACING } = require('../scripts/seed-map.js');

// No database needed: graphPosition is the pure piece of the applier that
// decides where a world lands on the World Map tab's canvas. It has to agree
// with TWO other tables that encode the same compass convention but can never
// be imported directly here (one is ESM/frontend, the other is this file's
// sibling seeds/mapSpec.js -- imported below so the three cannot drift without
// a test noticing):
//   - seeds/mapSpec.js EDGE_DELTA: N:[0,-1] S:[0,1] E:[1,0] W:[-1,0]
//   - frontend/src/games/something2/mapGraphLayout.js:10 STEP (byte-identical,
//     "y grows downward, so South is +y" -- cannot be required from CJS here).
// An applier that negated grid[1] (or grid[0]) would still pass every
// idempotency/round-trip check in seed_map_db.test.js, because it would be
// self-consistent -- it would just draw every seeded map mirrored against its
// own links. These assertions are what would actually catch that flip.
const { EDGE_DELTA } = require('../seeds/mapSpec.js');

test('GRID_SPACING matches the World Map tab default cell size', () => {
  // frontend/src/games/something2/mapGraphLayout.js:35 seedPositions defaults
  // to `cell = 220`. Keeping the seeded spacing identical to that fallback
  // means a mix of seeded and hand-placed worlds lines up on the same grid
  // instead of the seeded ones looking cramped or sparse next to the rest.
  assert.equal(GRID_SPACING, 220);
});

test('graphPosition moves along +x for East, -x for West, matching EDGE_DELTA', () => {
  const east = graphPosition(EDGE_DELTA.E); // [1, 0]
  const west = graphPosition(EDGE_DELTA.W); // [-1, 0]
  assert.equal(east.x, GRID_SPACING);
  assert.equal(east.y, 0);
  assert.equal(west.x, -GRID_SPACING);
  assert.equal(west.y, 0);
});

test('graphPosition moves along +y for South, -y for North, matching EDGE_DELTA', () => {
  // This is the assertion a sign flip would trip. Screen convention is
  // y-down, so South (grid[1] += 1) must increase graph_y and North
  // (grid[1] -= 1) must decrease it -- exactly what EDGE_DELTA already
  // encodes for S/N, and what STEP encodes on the frontend side.
  const south = graphPosition(EDGE_DELTA.S); // [0, 1]
  const north = graphPosition(EDGE_DELTA.N); // [0, -1]
  assert.equal(south.x, 0);
  assert.equal(south.y, GRID_SPACING);
  assert.equal(north.x, 0);
  assert.equal(north.y, -GRID_SPACING);
  assert.ok(south.y > north.y, 'South must land BELOW North on the canvas, not above it');
});

test('graphPosition of the origin cell is the canvas origin', () => {
  const origin = graphPosition([0, 0]);
  assert.deepEqual(origin, { x: 0, y: 0 });
});

test('graphPosition scales linearly, not just for unit steps', () => {
  const far = graphPosition([3, -2]);
  assert.deepEqual(far, { x: 3 * GRID_SPACING, y: -2 * GRID_SPACING });
});

// --- requiredTilesFor: what the navigability guard is actually asked ------
//
// This is the function that made the guard vacuous. It required only the
// doorway GAP, which stampBounds stamps `map_doorway` on the ring -- walkable
// by construction. For a world with one doorway and no entry_spawn that was
// the ONLY required tile, so assertNavigable flood-filled from it, had nothing
// to compare against, and returned clean however sealed the world was. Nine of
// the twenty shipped worlds are in that shape, and Blackfen Sinks shipped
// sealed through it.
//
// The tile that can actually generate as water / cave_wall / chasm is the
// ARRIVAL point one tile inward -- literally where mapService.arrivalPoint
// puts an inbound player. arrivalPoint is IMPORTED rather than restated so the
// two cannot drift: a test that hard-coded `row: 1` would keep passing if
// arrivalPoint were later changed to land somewhere else, which is exactly the
// divergence that would re-open this hole.
const { requiredTilesFor } = require('../scripts/seed-map.js');
const { arrivalPoint, CREATURE_TILE_PX } = require('../src/services/mapService.js');

const bareSpec = { links: [] };
const bareRow = (w = 64, h = 64) => ({ width: w, height: h, entry_spawn: null });
const find = (tiles, what) => tiles.find((t) => t.what === what);

test('every doorway contributes BOTH its gap and the arrival tile one step inward', () => {
  for (const edge of ['N', 'S', 'W', 'E']) {
    const tiles = requiredTilesFor({ key: 'w' }, bareSpec, bareRow(), [edge]);
    assert.equal(tiles.length, 2, `${edge} must require the gap AND the arrival tile`);
    assert.ok(find(tiles, `doorway ${edge}`), `${edge} gap missing`);
    assert.ok(find(tiles, `arrival via doorway ${edge}`), `${edge} arrival missing`);
  }
});

test('the arrival tile is exactly the tile arrivalPoint drops an inbound player on', () => {
  const HALF = CREATURE_TILE_PX / 2 - 32; // arrivalPoint's own centre-to-top-left offset
  for (const edge of ['N', 'S', 'W', 'E']) {
    const req = find(requiredTilesFor({ key: 'w' }, bareSpec, bareRow(), [edge]),
      `arrival via doorway ${edge}`);
    const p = arrivalPoint(64, 64, edge); // player TOP-LEFT pixel
    assert.equal(req.row, Math.floor((p.y + HALF) / CREATURE_TILE_PX), `${edge} arrival row`);
    assert.equal(req.col, Math.floor((p.x + HALF) / CREATURE_TILE_PX), `${edge} arrival col`);
  }
});

test('a doorway GAP still anchors the fill, never an arrival tile', () => {
  // assertNavigable starts from the FIRST entry and early-returns blaming
  // every other tile if that entry is unwalkable. Only a gap is walkable by
  // construction, so an arrival tile must never sort to the front -- not with
  // an entry_spawn present, and not with several doorways.
  const row = { width: 64, height: 64, entry_spawn: { x: 3250, y: 3250 } };
  const tiles = requiredTilesFor({ key: 'w' }, bareSpec, row, ['S', 'N', 'E']);
  assert.ok(tiles[0].what.startsWith('doorway '), `first required tile was "${tiles[0].what}"`);
  const firstArrival = tiles.findIndex((t) => t.what.startsWith('arrival'));
  const lastGap = tiles.map((t) => t.what.startsWith('doorway ')).lastIndexOf(true);
  assert.ok(firstArrival > lastGap, 'every doorway gap must sort ahead of every arrival tile');
});

test('the arrival tile sits inside the interior, never on the wall ring', () => {
  // The off-by-one this rules out: an "arrival" left on the ring, which
  // stampBounds writes as map_doorway/map_wall by construction -- making the
  // new requirement exactly as vacuous as the old one it replaced.
  for (const [w, h] of [[64, 64], [96, 96], [16, 40]]) {
    for (const edge of ['N', 'S', 'W', 'E']) {
      const req = find(requiredTilesFor({ key: 'w' }, bareSpec, bareRow(w, h), [edge]),
        `arrival via doorway ${edge}`);
      assert.ok(req.row > 0 && req.row < h - 1, `${edge} ${w}x${h}: row ${req.row} is on the ring`);
      assert.ok(req.col > 0 && req.col < w - 1, `${edge} ${w}x${h}: col ${req.col} is on the ring`);
    }
  }
});
