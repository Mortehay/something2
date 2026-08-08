// SOMET-253 Task 6: the knockback primitive. `knockbackPosition` is the
// pre-existing SOMET-243 portal-bounce function (see plan_portal_transition
// .test.js for its own coverage, now exercised with the renamed fromX/fromY
// params); `knockbackWithFallback` is new -- the three-rung retry combat
// knockback needs so a target with its back to a wall still gets shoved.
const test = require('node:test');
const assert = require('node:assert');
const { knockbackPosition, knockbackWithFallback } = require('../src/authority/knockback.js');

// A map with open floor everywhere except a hard boundary at `wallAt` along
// one axis. `axis` is 'x' or 'y' -- whichever axis the wall blocks.
function wallMap(wallAt, axis = 'x') {
  return {
    isWalkable(x, y) {
      const v = axis === 'x' ? x : y;
      return v < wallAt;
    },
  };
}

function openMap() {
  return { isWalkable: () => true };
}

function closedMap() {
  return { isWalkable: () => false };
}

test('a shove moves the target directly away from the attacker', () => {
  // Attacker at (0,0), target at (100,0), distance 50 -> target ends at
  // x=150, y=0. Assert DIRECTION explicitly (not just "it moved"), since a
  // target that happened to move on its own would pass the weaker version.
  const result = knockbackWithFallback({
    px: 100, py: 0, fromX: 0, fromY: 0, distance: 50, map: openMap(),
  });
  assert.strictEqual(result.x, 150);
  assert.strictEqual(result.y, 0);
});

test('a target against a wall is shoved the furthest distance that fits', () => {
  // Open floor for 30px past the target (target at x=1000, wall at x=1030),
  // then wall. distance 100: full-100 candidate (x=1100) fails, half-50
  // candidate (x=1050) fails, quarter-25 candidate (x=1025) lands (< 1030).
  const map = wallMap(1030, 'x');
  const result = knockbackWithFallback({
    px: 1000, py: 500, fromX: 900, fromY: 500, distance: 100, map,
  });
  assert.strictEqual(result.x, 1025, `expected the 25px rung to land, got x=${result.x}`);
  assert.strictEqual(result.y, 500);
  assert.ok(map.isWalkable(result.x, result.y), 'the landing spot must be walkable');
});

test('a target boxed in on every side is not moved', () => {
  // All three distances (100, 50, 25) fail against a fully closed map.
  const map = closedMap();
  const result = knockbackWithFallback({
    px: 1000, py: 1000, fromX: 900, fromY: 900, distance: 100, map,
  });
  assert.strictEqual(result.x, 1000, 'position must be EXACTLY unchanged, never NaN/undefined');
  assert.strictEqual(result.y, 1000, 'position must be EXACTLY unchanged, never NaN/undefined');
  assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y));
});

test('the portal bounce is unchanged: knockbackPosition is full-distance-or-nothing, no retry ladder', () => {
  // Same wall setup as the fallback test above: the full 100px candidate
  // fails (it would land past the wall at x=1030), but knockbackPosition
  // must NOT retry at a shorter distance -- it must return the target
  // exactly where it started, unlike knockbackWithFallback which would find
  // the 25px rung.
  const map = wallMap(1030, 'x');
  const result = knockbackPosition({
    px: 1000, py: 500, fromX: 900, fromY: 500, distance: 100, map,
  });
  assert.deepStrictEqual(result, { x: 1000, y: 500 },
    'knockbackPosition must be all-or-nothing: no shorter-distance retry');
});

test('a degenerate zero-length vector does not produce NaN', () => {
  // Attacker exactly on the target -- the extracted function pushes north
  // (dx=0, dy=-1) arbitrarily rather than dividing by a zero-length vector.
  const map = openMap();
  const result = knockbackPosition({
    px: 500, py: 500, fromX: 500, fromY: 500, distance: 40, map,
  });
  assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y), 'must not be NaN');
  assert.strictEqual(result.x, 500, 'degenerate case pushes north: x unchanged');
  assert.strictEqual(result.y, 460, 'degenerate case pushes north: y decreases by the full distance');
});
