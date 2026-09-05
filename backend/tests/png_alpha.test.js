const test = require('node:test');
const assert = require('node:assert');
const { alphaProfile, MIN_TRANSPARENT_PCT } = require('../src/services/pngAlpha.js');

// SOMET-540. Reading a PNG's alpha channel with no image library.
//
// The fixtures are REAL PNGs, built here rather than mocked: the thing under
// test is a decoder, so a fake input would only assert that my test builder and
// my decoder agree with each other. Cross-checked against the live batch --
// this decoder's percentages match an independent PIL measurement of the same
// twelve files exactly.

const { makePng } = require('./helpers/png.js');

const CLEAR_A = 0;
const SOLID = 255;

test('a fully transparent image reads as 100% transparent', () => {
  const p = alphaProfile(makePng(16, 16, () => CLEAR_A));
  assert.equal(p.width, 16);
  assert.equal(p.transparentPct, 100);
});

test('a fully opaque image reads as 0% -- this is the square that must be refused', () => {
  const p = alphaProfile(makePng(16, 16, () => SOLID));
  assert.equal(p.transparentPct, 0);
});

// A CENTRED OBJECT: a solid 8x8 block inside a 16x16 frame is 25% opaque, so
// 75% transparent. The arithmetic is independent of the code under test.
test('a centred object measures the area it actually covers', () => {
  const p = alphaProfile(makePng(16, 16, (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? SOLID : CLEAR_A)));
  assert.equal(p.transparentPct, 75);
});

// THE MEASURED FAILURE, reproduced as a fixture. An inset opaque block with a
// keyed margin -- 90% opaque overall. This is the shape that passed the header
// check, passed the provider's 422, and rendered as a magenta square.
test('an inset unkeyed backdrop is caught, though its CORNERS are transparent', () => {
  const n = 100;
  const inset = 5;
  const png = makePng(n, n, (x, y) => (
    x >= inset && x < n - inset && y >= inset && y < n - inset ? SOLID : CLEAR_A));
  const p = alphaProfile(png);
  assert.ok(p.transparentPct < MIN_TRANSPARENT_PCT(),
    `an unkeyed backdrop measured ${p.transparentPct.toFixed(0)}% transparent, `
    + `which a ${MIN_TRANSPARENT_PCT()}% floor would let through`);
  assert.ok(p.transparentPct > 0,
    'and it is not simply a fully opaque square -- the margin IS keyed, '
    + 'which is exactly why a corner test misses this and a percentage does not');
});

// Unfiltering is where a hand-rolled decoder goes wrong, and a wrong unfilter
// produces plausible-looking numbers rather than an error.
test('the alpha reading is the same under Sub and Up row filters', () => {
  const shape = (x, y) => (x >= 4 && x < 12 && y >= 4 && y < 12 ? SOLID : CLEAR_A);
  const none = alphaProfile(makePng(16, 16, shape, { filter: 0 }));
  const sub = alphaProfile(makePng(16, 16, shape, { filter: 1 }));
  const up = alphaProfile(makePng(16, 16, shape, { filter: 2 }));
  assert.equal(sub.transparentPct, none.transparentPct,
    'Sub-filtered rows must decode to the same image');
  assert.equal(up.transparentPct, none.transparentPct,
    'Up-filtered rows must decode to the same image');
});

// "Refuse what we can see is wrong, never what we merely cannot read."
test('anything not 8-bit non-interlaced RGBA returns no opinion, not a verdict', () => {
  assert.equal(alphaProfile(makePng(8, 8, () => SOLID, { colourType: 2 })), null, 'RGB');
  assert.equal(alphaProfile(makePng(8, 8, () => SOLID, { interlace: 1 })), null, 'interlaced');
  assert.equal(alphaProfile(makePng(8, 8, () => SOLID, { depth: 16 })), null, '16-bit');
  assert.equal(alphaProfile(Buffer.from('not a png at all')), null);
  assert.equal(alphaProfile(Buffer.alloc(0)), null);
  assert.equal(alphaProfile(null), null);
});

test('a truncated PNG is unreadable rather than a wrong answer', () => {
  const full = makePng(16, 16, () => CLEAR_A);
  assert.equal(alphaProfile(full.subarray(0, full.length - 30)), null);
});

// Corrupt compressed data must not throw out of the guard and fail a job that
// might be fine.
test('undecompressable image data returns null instead of throwing', () => {
  const full = makePng(16, 16, () => CLEAR_A);
  const i = full.indexOf(Buffer.from('IDAT', 'ascii'));
  full[i + 6] ^= 0xff;                       // scramble the zlib stream
  assert.doesNotThrow(() => alphaProfile(full));
  assert.equal(alphaProfile(full), null);
});

// The floor sits in the gap MEASURED between the two clusters, not on a round
// number someone liked.
test('the floor separates every measured success from every measured failure', () => {
  const floor = MIN_TRANSPARENT_PCT();
  const usable = [67, 79, 83, 89, 90, 92, 92, 93, 94, 95];
  const failures = [10, 4];
  for (const v of usable) assert.ok(v >= floor, `${v}% was judged usable but the floor is ${floor}%`);
  for (const v of failures) assert.ok(v < floor, `${v}% was judged a failure but passes a ${floor}% floor`);
});
