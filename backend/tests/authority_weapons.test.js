const test = require('node:test');
const assert = require('node:assert');
const { normalizeAim, inArc, DEFAULT_WEAPON_NAME } = require('../src/authority/weapons.js');

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

test('DEFAULT_WEAPON_NAME is dagger', () => {
  assert.equal(DEFAULT_WEAPON_NAME, 'dagger');
});

function round(v) { return { nx: Math.round(v.nx), ny: Math.round(v.ny) }; }
