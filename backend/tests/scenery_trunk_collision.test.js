const test = require('node:test');
const assert = require('node:assert');
const { resolveMove, ServerMap } = require('../src/authority/collision.js');

// Biome scenery spec, verification: "walking behind tree crowns but blocked at
// the trunk". resolveMove used to sample only the two CORNERS of the 32px
// leading footprint face, so a trunk circle narrower than the face (every
// catalogue block_radius is 8..14) sat between them and a player walking
// straight at it passed through (860/862 head-on approaches in a live forest).
// faceClear now also asks the map whether any blocking circle touches the face.
// Mirrored by frontend systems/__tests__/sceneryTrunkCollision.test.js.

const TILE = 100;
const PLAYER = { width: 64, height: 64, speed: 200 }; // footprint 32x32 (FOOTPRINT_SCALE 0.5)
const HALF = 16; // footprint half-extent
const ANCHOR = { x: 2 * TILE + 50, y: 2 * TILE + 50 }; // tile (2,2), anchor (50,50)

// A real ServerMap over plain grass with ONE blocking circle injected into the
// memoized per-chunk cache, so isWalkable and segmentHitsBlocker both run their
// production code against a circle at a known place.
function mapWithCircle(r) {
  const map = new ServerMap({ seed: 1, chunkSize: 16, tileTypes: { grass: { walkable: true, speed: 1 } } });
  map.blockedDecoCircles.set('0,0', new Map([['2,2', [{ x: 50, y: 50, r }]]]));
  return map;
}

// Walk for 2s at 60 Hz in (dx,dy) from a footprint centre at (cx,cy).
function walk(map, cx, cy, dx, dy, steps = 120) {
  let a = { ...PLAYER, x: cx - 32, y: cy - 32 };
  for (let i = 0; i < steps; i++) {
    const r = resolveMove(map, a, dx, dy, 1 / 60);
    a = { ...a, x: r.x, y: r.y };
  }
  return { cx: a.x + 32, cy: a.y + 32 };
}

// Distance from the circle centre to the footprint rectangle (0 when inside).
function rectDist(p) {
  const qx = Math.max(Math.abs(ANCHOR.x - p.cx) - HALF, 0);
  const qy = Math.max(Math.abs(ANCHOR.y - p.cy) - HALF, 0);
  return Math.hypot(qx, qy);
}

const DIRS = [
  { name: 'east', dx: 1, dy: 0, start: { cx: ANCHOR.x - 60, cy: ANCHOR.y } },
  { name: 'west', dx: -1, dy: 0, start: { cx: ANCHOR.x + 60, cy: ANCHOR.y } },
  { name: 'south', dx: 0, dy: 1, start: { cx: ANCHOR.x, cy: ANCHOR.y - 60 } },
  { name: 'north', dx: 0, dy: -1, start: { cx: ANCHOR.x, cy: ANCHOR.y + 60 } },
];

for (const r of [10, 14]) {
  for (const d of DIRS) {
    test(`head-on ${d.name} at a radius-${r} trunk centred between the corner samples stops before it`, () => {
      const end = walk(mapWithCircle(r), d.start.cx, d.start.cy, d.dx, d.dy);
      const gap = rectDist(end);
      assert.ok(gap > r, `footprint overlaps the trunk: gap ${gap.toFixed(3)} <= r ${r}`);
      // ...and it stops AT the trunk, not somewhere short of it (WALL_EPS clamp).
      assert.ok(gap < r + 0.5, `stopped ${(gap - r).toFixed(3)}px short of the trunk`);
    });
  }
}

test('the corner-only test really did walk through (proves the fixture)', () => {
  const real = mapWithCircle(10);
  const cornersOnly = { isWalkable: (x, y) => real.isWalkable(x, y), speedAt: () => 1 };
  const end = walk(cornersOnly, ANCHOR.x - 60, ANCHOR.y, 1, 0);
  assert.ok(end.cx > ANCHOR.x + 30, `corner-only movement should pass the trunk, ended at ${end.cx}`);
});

for (const r of [10, 14]) {
  test(`a sideways graze that clears a radius-${r} trunk by 1px still passes`, () => {
    const lateral = HALF + r + 1;
    for (const side of [-1, 1]) {
      const end = walk(mapWithCircle(r), ANCHOR.x - 60, ANCHOR.y + side * lateral, 1, 0);
      assert.ok(end.cx > ANCHOR.x + 60, `graze at lateral ${side * lateral} was stopped at ${end.cx}`);
      assert.strictEqual(end.cy, ANCHOR.y + side * lateral, 'a clear graze must not be deflected');
    }
  });
}

test('segmentHitsBlocker: edge inclusive, misses just outside, ignores other tiles', () => {
  const map = mapWithCircle(10);
  const x = ANCHOR.x - 10; // the circle's west edge
  assert.strictEqual(map.segmentHitsBlocker(x, ANCHOR.y - 16, x, ANCHOR.y + 16), true);
  assert.strictEqual(map.segmentHitsBlocker(x - 0.01, ANCHOR.y - 16, x - 0.01, ANCHOR.y + 16), false);
  assert.strictEqual(map.segmentHitsBlocker(450, 450, 450, 482), false);
});
