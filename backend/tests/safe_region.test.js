const test = require('node:test');
const assert = require('node:assert');
const { buildSafeContext, isSafeTile } = require('../src/services/safeRegion.js');

// A 6x4 village at rows 10..13, cols 20..25 -- the shape mapService's
// cfg.villages carries.
const VILLAGE = { minRow: 10, minCol: 20, width: 6, height: 4 };

test('a tile inside a village box is safe, including its wall ring', () => {
  const ctx = buildSafeContext({ villages: [VILLAGE] });
  assert.equal(isSafeTile(ctx, 12, 22), true, 'interior');
  assert.equal(isSafeTile(ctx, 10, 20), true, 'north-west corner of the wall ring');
  assert.equal(isSafeTile(ctx, 13, 25), true, 'south-east corner of the wall ring');
  assert.equal(isSafeTile(ctx, 9, 22), false, 'one row north of the box');
  assert.equal(isSafeTile(ctx, 14, 22), false, 'one row south of the box');
  assert.equal(isSafeTile(ctx, 12, 26), false, 'one col east of the box');
});

test('radius 0 means roads are NOT safe -- not even the road tile itself', () => {
  // This is what keeps every world that has not opted in placing exactly the
  // creatures it placed before this feature existed.
  const ctx = buildSafeContext({
    pathCells: new Set(['5,5']), safeRoadRadius: 0,
  });
  assert.equal(isSafeTile(ctx, 5, 5), false);
});

test('a road makes a Chebyshev square of radius N safe, and nothing beyond it', () => {
  const ctx = buildSafeContext({
    pathCells: new Set(['5,5']), safeRoadRadius: 2,
  });
  assert.equal(isSafeTile(ctx, 5, 5), true, 'the road cell itself');
  assert.equal(isSafeTile(ctx, 3, 3), true, 'the diagonal corner at exactly radius 2');
  assert.equal(isSafeTile(ctx, 7, 7), true, 'the opposite diagonal corner');
  assert.equal(isSafeTile(ctx, 5, 8), false, 'radius 3 along a row');
  assert.equal(isSafeTile(ctx, 2, 5), false, 'radius 3 along a column');
  assert.equal(isSafeTile(ctx, 8, 8), false, 'radius 3 diagonally');
});

test('an authored safe rectangle is safe independently of villages and roads', () => {
  const ctx = buildSafeContext({
    safeRects: [{ minRow: 40, minCol: 40, width: 3, height: 3 }],
  });
  assert.equal(isSafeTile(ctx, 41, 41), true);
  assert.equal(isSafeTile(ctx, 42, 42), true, 'inclusive far corner');
  assert.equal(isSafeTile(ctx, 43, 41), false, 'one row past the rectangle');
});

test('an empty context makes nothing safe', () => {
  const ctx = buildSafeContext();
  assert.equal(isSafeTile(ctx, 0, 0), false);
  assert.equal(isSafeTile(ctx, 500, 500), false);
});

test('a junk radius degrades to 0 rather than to NaN', () => {
  // Every comparison against NaN is false, so a NaN radius would disable the
  // road leg silently -- the failure mode this normalization exists to make
  // impossible. Asserted for each way a hand-edited spec gets it wrong.
  for (const junk of ['2', 2.5, -1, null, undefined, NaN, {}]) {
    const ctx = buildSafeContext({ pathCells: new Set(['5,5']), safeRoadRadius: junk });
    assert.equal(ctx.safeRoadRadius, 0, `radius ${JSON.stringify(junk)} must normalize to 0`);
    assert.equal(isSafeTile(ctx, 5, 5), false);
  }
});

test('a non-Set pathCells degrades to empty rather than throwing', () => {
  const ctx = buildSafeContext({ pathCells: ['5,5'], safeRoadRadius: 2 });
  assert.equal(isSafeTile(ctx, 5, 5), false);
});

// ---------------------------------------------------------------------------
// A malformed rectangle must be LOUD (SOMET-288 review, finding 4).
//
// Unlike the radius, a rectangle has no safe fallback: degrading it means the
// authored rectangle silently does not exist, and a world advertised as safe
// that is not safe tells nobody. Each case below is a way a rect actually
// arrives wrong -- the snake_case one is not hypothetical, it was observed
// placing 80 of 80 creatures with the rectangle having no effect at all.
// ---------------------------------------------------------------------------
test('a safe rect spelled snake_case throws instead of silently protecting nothing', () => {
  const raw = { min_row: 20, min_col: 20, width: 8, height: 8 };
  assert.throws(
    () => buildSafeContext({ safeRects: [raw] }),
    /safeRects\[0\]\.minRow must be an integer/,
  );
  // The message must point at the conversion the caller skipped, or the next
  // person sees "must be an integer" about a field their JSON does not have.
  assert.throws(() => buildSafeContext({ safeRects: [raw] }), /buildWorldGenConfig/);
});

test('a null or non-object safe rect entry throws', () => {
  for (const junk of [null, undefined, 'rect', 7]) {
    assert.throws(
      () => buildSafeContext({ safeRects: [junk] }),
      /safeRects\[0\] must be an object/,
      `entry ${JSON.stringify(junk)} must be reported`,
    );
  }
});

test('a safe rect with a non-integer or non-positive dimension throws', () => {
  const ok = { minRow: 4, minCol: 4, width: 3, height: 3 };
  // Sanity first: the base rect is accepted, so the failures below are about
  // the field each case mutates and not about the fixture.
  assert.equal(isSafeTile(buildSafeContext({ safeRects: [ok] }), 5, 5), true);

  assert.throws(() => buildSafeContext({ safeRects: [{ ...ok, minRow: 4.5 }] }),
    /safeRects\[0\]\.minRow must be an integer/);
  assert.throws(() => buildSafeContext({ safeRects: [{ ...ok, width: '3' }] }),
    /safeRects\[0\]\.width must be an integer/);
  assert.throws(() => buildSafeContext({ safeRects: [{ ...ok, height: NaN }] }),
    /safeRects\[0\]\.height must be an integer/);
  // Zero-area rectangles are integral and pass every field check, yet cover no
  // tile -- the same "authored but inert" outcome, so they are refused too.
  assert.throws(() => buildSafeContext({ safeRects: [{ ...ok, width: 0 }] }),
    /positive width and height/);
  assert.throws(() => buildSafeContext({ safeRects: [{ ...ok, height: -2 }] }),
    /positive width and height/);
});

test('a non-array safeRects throws, but an absent one is still the opt-out', () => {
  assert.throws(() => buildSafeContext({ safeRects: { minRow: 0, minCol: 0, width: 2, height: 2 } }),
    /safeRects must be an array/);
  // undefined/null are how EVERY world that never opted in arrives here, and
  // they must stay free -- this is the compatibility guarantee, not laxness.
  for (const absent of [undefined, null]) {
    assert.deepEqual(buildSafeContext({ safeRects: absent }).safeRects, []);
  }
  // The index in the message names the offending element, not just the array.
  assert.throws(
    () => buildSafeContext({ safeRects: [{ minRow: 1, minCol: 1, width: 2, height: 2 }, null] }),
    /safeRects\[1\] must be an object/,
  );
});
