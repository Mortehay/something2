// backend/tests/p5_derive_size.test.js
const test = require('node:test');
const assert = require('node:assert');
const { deriveSize, SIZE_STEPS } = require('../scripts/dungeon/escalation');

// Expected sizes are literals, not recomputed from SIZE_STEPS -- recomputing
// the bucket arithmetic from the table would assert that Math.floor works.
test('deriveSize steps through the ramp from shallow to deep', () => {
  assert.equal(deriveSize(0), 96);
  assert.equal(deriveSize(0.1), 96);
  assert.equal(deriveSize(0.25), 128);
  assert.equal(deriveSize(0.5), 160);
  assert.equal(deriveSize(0.7), 192);
  assert.equal(deriveSize(0.9), 224);
  assert.equal(deriveSize(1), 224);
});

test('deriveSize never shrinks as hopFraction rises', () => {
  let prev = 0;
  for (let i = 0; i <= 20; i++) {
    const size = deriveSize(i / 20);
    assert.ok(size >= prev, `size dropped at hopFraction ${i / 20}`);
    prev = size;
  }
});

// A world that does not divide into whole 32-tile chunks would leave a
// partial chunk at its edge, which no part of the chunk loader expects.
test('every size on the ramp is a whole number of 32-tile chunks', () => {
  for (const size of SIZE_STEPS) {
    assert.equal(size % 32, 0, `${size} is not a multiple of the chunk size`);
  }
});

test('the ramp is exactly the five sizes the design settled on', () => {
  assert.deepEqual(SIZE_STEPS, [96, 128, 160, 192, 224]);
});

// hopFraction is clamped to [0,1] by the generator before it gets here, but
// deriveSize must not index off the end of the table if that ever changes.
test('deriveSize tolerates a hopFraction at or past the top of the range', () => {
  assert.equal(deriveSize(1.5), 224);
});
