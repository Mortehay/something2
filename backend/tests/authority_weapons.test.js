const test = require('node:test');
const assert = require('node:assert');
const { normalizeAim, inArc, hasLineOfSight } = require('../src/authority/weapons.js');
const { MAX_SUB } = require('../src/authority/projectiles');

test('normalizeAim normalizes a non-zero vector to unit length', () => {
  const { nx, ny } = normalizeAim(3, 4, 's');
  assert.ok(Math.abs(Math.hypot(nx, ny) - 1) < 1e-9);
  assert.ok(Math.abs(nx - 0.6) < 1e-9 && Math.abs(ny - 0.8) < 1e-9);
});

test('normalizeAim falls back to the facing direction on a zero vector', () => {
  assert.deepEqual(round(normalizeAim(0, 0, 'e')), { nx: 1, ny: 0 });
  assert.deepEqual(round(normalizeAim(0, 0, 'n')), { nx: 0, ny: -1 });
  const se = normalizeAim(0, 0, 'se');
  assert.ok(Math.abs(Math.hypot(se.nx, se.ny) - 1) < 1e-9);
  assert.ok(se.nx > 0 && se.ny > 0);
  // Unknown/empty facing → default south.
  assert.deepEqual(round(normalizeAim(0, 0, null)), { nx: 0, ny: 1 });
});

test('normalizeAim falls back to facing on non-finite aim', () => {
  for (const [ax, ay] of [[Infinity, 0], [NaN, 0], [0, -Infinity]]) {
    const { nx, ny } = normalizeAim(ax, ay, 'e');
    assert.deepEqual({ nx, ny }, { nx: 1, ny: 0 });
    assert.equal(Number.isNaN(nx), false);
    assert.equal(Number.isNaN(ny), false);
  }
});

test('inArc: inside reach and cone is a hit', () => {
  // aim east; target due east, close.
  assert.equal(inArc(0, 0, 1, 0, 50, 0, 80, 0.6), true);
});

test('inArc: outside reach is a miss even when dead ahead', () => {
  assert.equal(inArc(0, 0, 1, 0, 200, 0, 80, 0.6), false);
});

test('inArc: outside the angular cone is a miss even when within reach', () => {
  // aim east; target due north, within reach — angle 90° > 0.3 rad half-cone.
  assert.equal(inArc(0, 0, 1, 0, 0, -50, 80, 0.6), false);
});

test('inArc: a wide arc includes a target a narrow arc excludes', () => {
  // target 45° off-aim, within reach.
  const tx = 40, ty = -40; // 45° up-right from origin; aim east
  assert.equal(inArc(0, 0, 1, 0, tx, ty, 80, 0.6), false); // narrow (0.3 rad half)
  assert.equal(inArc(0, 0, 1, 0, tx, ty, 80, 1.8), true);  // wide (0.9 rad half)
});

test('inArc: a target exactly at the origin counts as a hit', () => {
  assert.equal(inArc(10, 10, 1, 0, 10, 10, 80, 0.6), true);
});

function round(v) { return { nx: Math.round(v.nx), ny: Math.round(v.ny) }; }

// Map stub: everything walkable except an x-range forming a vertical wall.
function wallMap(wallXMin, wallXMax) {
  return {
    chunkSize: 8,
    isWalkable: (x) => !(x >= wallXMin && x <= wallXMax),
    speedAt: () => 1,
    getChunk: () => [],
  };
}

test('MAX_SUB is shared, not duplicated', () => {
  assert.strictEqual(typeof MAX_SUB, 'number');
  assert.ok(MAX_SUB > 0 && MAX_SUB <= 16, 'must stay small enough to not skip a wall');
});

test('clear terrain has line of sight', () => {
  const map = wallMap(10000, 10001); // wall far away, irrelevant
  assert.strictEqual(hasLineOfSight(map, 0, 0, 200, 0), true);
});

test('a wall between the two points blocks line of sight', () => {
  const map = wallMap(90, 110);
  assert.strictEqual(hasLineOfSight(map, 0, 0, 200, 0), false);
});

test('a wall BEYOND the target does not block', () => {
  const map = wallMap(300, 320);
  assert.strictEqual(hasLineOfSight(map, 0, 0, 200, 0), true);
});

test('point-blank is always visible', () => {
  const map = wallMap(-1000, 1000); // standing inside a blocked tile
  assert.strictEqual(hasLineOfSight(map, 50, 50, 50, 50), true);
});

test('line of sight is symmetric', () => {
  const map = wallMap(90, 110);
  assert.strictEqual(hasLineOfSight(map, 0, 0, 200, 0), hasLineOfSight(map, 200, 0, 0, 0));
});

test('a diagonal wall crossing is blocked', () => {
  const map = wallMap(90, 110);
  assert.strictEqual(hasLineOfSight(map, 0, 0, 200, 200), false);
});

// hasLineOfSight documents that BOTH endpoints are excluded from the walk, so
// an attacker standing in a doorway (ORIGIN on a blocked tile) or a target
// clipping a wall corner (TARGET on a blocked tile) must not be self-blocking.
// Nothing previously asserted that; a loop bounds change to include either
// endpoint left the whole suite green. Both cases below use a wall that is
// exactly one point wide, positioned only under the endpoint under test, with
// a distance well beyond MAX_SUB so the point-blank early return can't mask
// the loop bounds.
test('hasLineOfSight is not self-blocked when the ORIGIN sits on a blocked tile', () => {
  const map = wallMap(100, 100); // only the origin's own tile is blocked
  assert.strictEqual(hasLineOfSight(map, 100, 0, 300, 0), true);
});

test('hasLineOfSight is not self-blocked when the TARGET sits on a blocked tile', () => {
  const map = wallMap(300, 300); // only the target's own tile is blocked
  assert.strictEqual(hasLineOfSight(map, 0, 0, 300, 0), true);
});
