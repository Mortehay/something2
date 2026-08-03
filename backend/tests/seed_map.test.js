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
