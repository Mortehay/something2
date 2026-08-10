const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { chooseSpawn } = require('../src/services/mapService');

// Pure: no database, no ServerMap. isWalkable is injected, so the whole
// fallback is testable as a function of (position, bounds, tiles, portals).
const TILE = 100;
const bounded = { width: 10, height: 10 };            // 1000 x 1000 px
const unbounded = { width: null, height: null };

// Blocks the single tile at column 4, row 4 (i.e. x 400-500, y 400-500).
const blocksTile44 = (x, y) => !(Math.floor(x / TILE) === 4 && Math.floor(y / TILE) === 4);
const allWalkable = () => true;

test('a valid saved position is used unchanged', () => {
  const s = chooseSpawn({
    persisted: { x: 250, y: 250 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 0, y: 0 }], isWalkable: allWalkable,
  });
  assert.deepEqual({ x: s.x, y: s.y }, { x: 250, y: 250 });
  assert.equal(s.viaPortalFallback, false);
});

test('a saved position outside the shrunken world falls back to the nearest portal', () => {
  const s = chooseSpawn({
    persisted: { x: 5000, y: 5000 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 900, y: 900 }, { x: 100, y: 100 }], isWalkable: allWalkable,
  });
  assert.deepEqual({ x: s.x, y: s.y }, { x: 900, y: 900 });
  assert.equal(s.viaPortalFallback, true);
});

test('a saved position on a now-blocked tile falls back to the nearest portal', () => {
  const s = chooseSpawn({
    persisted: { x: 420, y: 420 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 800, y: 800 }, { x: 500, y: 500 }], isWalkable: blocksTile44,
  });
  assert.deepEqual({ x: s.x, y: s.y }, { x: 500, y: 500 });
  assert.equal(s.viaPortalFallback, true);
});

test('the NEAREST portal wins, by hand-computed distance', () => {
  // Distances from (420,420): (500,500) -> sqrt(80^2 + 80^2) ~ 113.1
  //                           (300,420) -> 120
  //                           (420,700) -> 280
  const s = chooseSpawn({
    persisted: { x: 420, y: 420 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 420, y: 700 }, { x: 300, y: 420 }, { x: 500, y: 500 }],
    isWalkable: blocksTile44,
  });
  assert.deepEqual({ x: s.x, y: s.y }, { x: 500, y: 500 });
});

test('an invalid position in a world with no portals falls through to the old behaviour', () => {
  const s = chooseSpawn({
    persisted: { x: 420, y: 420 }, worldRow: bounded, chunkSize: 64,
    portals: [], isWalkable: blocksTile44,
  });
  // Bounded interior centre: col 5, row 5 -> 5*100 + 50 - 32.
  assert.deepEqual({ x: s.x, y: s.y }, { x: 518, y: 518 });
  assert.equal(s.viaPortalFallback, false);
});

test('a pending doorway arrival still beats everything', () => {
  const s = chooseSpawn({
    pending: { x: 10, y: 20 }, persisted: { x: 420, y: 420 },
    worldRow: bounded, chunkSize: 64,
    portals: [{ x: 500, y: 500 }], isWalkable: blocksTile44,
  });
  assert.deepEqual({ x: s.x, y: s.y, viaDoorway: s.viaDoorway }, { x: 10, y: 20, viaDoorway: true });
});

test('with no isWalkable supplied, an in-bounds position is trusted', () => {
  const s = chooseSpawn({
    persisted: { x: 420, y: 420 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 500, y: 500 }],
  });
  assert.deepEqual({ x: s.x, y: s.y }, { x: 420, y: 420 });
});

test('an unbounded world only tile-checks', () => {
  const far = chooseSpawn({
    persisted: { x: 99999, y: 99999 }, worldRow: unbounded, chunkSize: 64,
    portals: [{ x: 1, y: 1 }], isWalkable: allWalkable,
  });
  assert.deepEqual({ x: far.x, y: far.y }, { x: 99999, y: 99999 },
    'an unbounded world has no bounds to violate');
});

test('the whole player box is checked, not just its top-left corner', () => {
  // Top-left (390,390) is on the walkable tile 3,3 but the box extends to
  // (454,454), which is inside the blocked tile 4,4. A single-point check
  // would accept this position and load the player half inside a wall.
  const s = chooseSpawn({
    persisted: { x: 390, y: 390 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 700, y: 700 }], isWalkable: blocksTile44,
  });
  assert.deepEqual({ x: s.x, y: s.y }, { x: 700, y: 700 });
  assert.equal(s.viaPortalFallback, true);
});

test('a position flush against the world edge is still valid', () => {
  // x = 1000 - 64 = 936 is the last position whose box fits. Off-by-one here
  // would eject a player who logged out against the east wall.
  const s = chooseSpawn({
    persisted: { x: 936, y: 936 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 100, y: 100 }], isWalkable: allWalkable,
  });
  assert.deepEqual({ x: s.x, y: s.y }, { x: 936, y: 936 });
  const overhang = chooseSpawn({
    persisted: { x: 937, y: 936 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: 100, y: 100 }], isWalkable: allWalkable,
  });
  assert.deepEqual({ x: overhang.x, y: overhang.y }, { x: 100, y: 100 },
    'one pixel of overhang must be rejected');
});

test('a portal with non-finite coordinates is ignored, not chosen', () => {
  const s = chooseSpawn({
    persisted: { x: 420, y: 420 }, worldRow: bounded, chunkSize: 64,
    portals: [{ x: null, y: null }, { x: 700, y: 700 }], isWalkable: blocksTile44,
  });
  assert.deepEqual({ x: s.x, y: s.y }, { x: 700, y: 700 });
});

test('loadSpawn actually supplies portals and isWalkable', () => {
  // A source-text guard, deliberately. The failure this catches is inertness:
  // chooseSpawn gained two optional parameters with inert defaults, so a
  // loadSpawn that forgets to pass them keeps compiling, keeps passing every
  // other test, and silently never uses the fallback in real play.
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  const start = src.indexOf('async function loadSpawn(');
  assert.ok(start !== -1, 'could not locate loadSpawn');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.match(body, /chooseSpawn\(\{[\s\S]*portals/, 'loadSpawn must pass portals to chooseSpawn');
  assert.match(body, /chooseSpawn\(\{[\s\S]*isWalkable/, 'loadSpawn must pass isWalkable to chooseSpawn');
});
