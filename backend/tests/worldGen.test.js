const test = require('node:test');
const assert = require('node:assert');

const {
  hash2,
  globalValueNoise,
} = require('../src/services/mapService');

test('hash2 is deterministic and in [0,1)', () => {
  const a = hash2(1234, 7, -3);
  const b = hash2(1234, 7, -3);
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 1, `out of range: ${a}`);
});

test('hash2 varies with each argument (incl. negatives)', () => {
  assert.notEqual(hash2(1, 0, 0), hash2(2, 0, 0));       // seed
  assert.notEqual(hash2(1, 0, 0), hash2(1, 1, 0));       // x
  assert.notEqual(hash2(1, 0, 0), hash2(1, 0, 1));       // y
  assert.notEqual(hash2(1, -1, 0), hash2(1, 1, 0));      // negative vs positive x
});

test('globalValueNoise is deterministic and in [0,1]', () => {
  const a = globalValueNoise(9, 100, 250, 8);
  const b = globalValueNoise(9, 100, 250, 8);
  assert.equal(a, b);
  assert.ok(a >= 0 && a <= 1, `out of range: ${a}`);
});

test('globalValueNoise is smooth (adjacent samples stay close)', () => {
  let maxJump = 0;
  for (let gc = 1; gc < 200; gc++) {
    maxJump = Math.max(
      maxJump,
      Math.abs(globalValueNoise(5, 40, gc, 8) - globalValueNoise(5, 40, gc - 1, 8)),
    );
  }
  assert.ok(maxJump < 0.35, `noise not smooth, maxJump ${maxJump}`);
});

test('globalValueNoise agrees at negative coordinates too', () => {
  const a = globalValueNoise(3, -64, -64, 8);
  const b = globalValueNoise(3, -64, -64, 8);
  assert.equal(a, b);
});
