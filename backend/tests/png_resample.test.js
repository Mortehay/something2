const test = require('node:test');
const assert = require('node:assert');

const { resampleRGBA, shrinkToEdge } = require('../src/services/pngResample.js');
const { encodeRGBA } = require('../src/services/pngTrim.js');
const { decodeRGBA } = require('../src/services/pngAlpha.js');

// SOMET-573. Area-average downscale for the committed icon copies.

function image(width, height, fill) {
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fill(x, y);
      px.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return { width, height, px };
}

const at = (img, x, y) => [...img.px.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

test('an image already within the cap is returned untouched', () => {
  const img = image(200, 100, () => [1, 2, 3, 255]);
  assert.strictEqual(resampleRGBA(img, 256), img);
});

test('the longest edge lands exactly on the cap and the other edge keeps the aspect', () => {
  const out = resampleRGBA(image(640, 480, () => [0, 0, 0, 255]), 256);
  assert.strictEqual(out.width, 256);
  assert.strictEqual(out.height, 192);
  const tall = resampleRGBA(image(300, 900, () => [0, 0, 0, 255]), 256);
  assert.strictEqual(tall.width, 85);
  assert.strictEqual(tall.height, 256);
});

test('an integer factor over solid blocks is exact: each block becomes one pixel of its own colour', () => {
  // 4x4 image made of four 2x2 solid blocks.
  const colours = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 128]];
  const img = image(4, 4, (x, y) => colours[(y >> 1) * 2 + (x >> 1)]);
  const out = resampleRGBA(img, 2);
  assert.deepStrictEqual(at(out, 0, 0), [255, 0, 0, 255]);
  assert.deepStrictEqual(at(out, 1, 0), [0, 255, 0, 255]);
  assert.deepStrictEqual(at(out, 0, 1), [0, 0, 255, 255]);
  assert.deepStrictEqual(at(out, 1, 1), [255, 255, 0, 128]);
});

test('transparent neighbours do not darken an edge: averaging is over premultiplied alpha', () => {
  // One opaque red pixel and three fully transparent BLACK pixels. A naive
  // average gives (64,0,0,64): a dark red fringe at every silhouette edge.
  // Premultiplied averaging keeps the colour red and only lowers alpha.
  const img = image(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  const [r, g, b, a] = at(resampleRGBA(img, 1), 0, 0);
  assert.strictEqual(a, 64);
  assert.strictEqual(r, 255);
  assert.strictEqual(g, 0);
  assert.strictEqual(b, 0);
});

test('a non-integer factor averages fractional coverage rather than dropping rows', () => {
  // 3 wide -> 2 wide: left dest pixel covers 1.5 source pixels. With source
  // columns 0 and 255 and 0, the left pixel is (255*1 + 0*0.5)/1.5 = 170.
  const img = image(3, 1, (x) => [x === 1 ? 0 : 255, 0, 0, 255]);
  const out = resampleRGBA(img, 2);
  assert.strictEqual(out.width, 2);
  assert.strictEqual(at(out, 0, 0)[0], 170);
  assert.strictEqual(at(out, 1, 0)[0], 170);
});

test('shrinkToEdge round-trips through the real encoder and decoder', () => {
  const src = image(512, 256, (x, y) => [x & 255, y & 255, 0, 255]);
  const buf = encodeRGBA(src.width, src.height, src.px);
  const out = shrinkToEdge(buf, 256);
  assert.strictEqual(out.resized, true);
  assert.deepStrictEqual(out.source, { width: 512, height: 256 });
  const dec = decodeRGBA(out.buffer);
  assert.strictEqual(dec.width, 256);
  assert.strictEqual(dec.height, 128);
  assert.ok(out.buffer.length < buf.length);
});

test('shrinkToEdge leaves a small image and an unreadable buffer as they are', () => {
  const small = encodeRGBA(2, 2, Buffer.alloc(16, 255));
  const s = shrinkToEdge(small, 256);
  assert.strictEqual(s.resized, false);
  assert.strictEqual(s.buffer, small);
  assert.deepStrictEqual(s.source, { width: 2, height: 2 });
  const junk = Buffer.from('not a png');
  const j = shrinkToEdge(junk, 256);
  assert.strictEqual(j.resized, false);
  assert.strictEqual(j.buffer, junk);
  assert.strictEqual(j.source, null);
});
