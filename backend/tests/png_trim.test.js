const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { trimToContent, encodeRGBA, MARGIN_PCT } = require('../src/services/pngTrim.js');
const { decodeRGBA, CLEAR } = require('../src/services/pngAlpha.js');

// SOMET-562. The trim rule, tested against images the generator actually
// produced.
//
// WHY REAL FIXTURES AND NOT SYNTHETIC ONES. A synthetic "off-centre square on
// a transparent field" passes a trim that is subtly wrong, because it has no
// feathered edge, no despill halo and no stray speckle -- the three things
// that decide whether a real trim finds the true bounding box or the whole
// canvas. The two fixtures here came out of the object store during SOMET-561,
// downscaled to 256 so the repo stays light. Their measured geometry:
//
//   offcentre-darts.png  bbox (103,29)-(139,176)  fills 14.1% W, 57.4% H
//   margin-staff.png     bbox (111,21)-(143,237)  fills 12.5% W, 84.4% H
//
// Those numbers are transcribed from tools/measure-art-margin.py, an
// INDEPENDENT implementation in a different language. That is deliberate: an
// expectation computed by the code under test proves only that the code agrees
// with itself.

const FIXTURES = path.join(__dirname, 'fixtures', 'art');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

// --- a tiny independent PNG writer, so the tests can state their own inputs -
//
// Written out longhand rather than imported from pngTrim: a test that builds
// its input with the encoder under test cannot fail when that encoder is
// wrong. Only the pieces the tests need -- 8-bit RGBA, one IDAT, filter 0.
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// pixel(x, y) -> [r, g, b, a]
function makePng(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0;   // filter: none
    p += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a;
      p += 4;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TRANSPARENT = [0, 0, 0, 0];
const RED = [255, 0, 0, 255];

// Where is the content in a decoded image? Read back from the OUTPUT buffer,
// never inferred from what the trim reported about itself.
function contentBox(buf) {
  const img = decodeRGBA(buf);
  assert.ok(img, 'output was not decodable as 8-bit RGBA');
  let left = img.width; let right = -1; let top = img.height; let bottom = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (img.px[(y * img.width + x) * 4 + 3] >= CLEAR) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return right < 0 ? null : { left, top, right, bottom, w: img.width, h: img.height };
}

// --- the real fixtures -----------------------------------------------------

test('a real off-centre image ends up centred', () => {
  const before = contentBox(readFixture('offcentre-darts.png'));
  // Precondition: the fixture is genuinely lopsided, otherwise this test
  // proves nothing about centring. Measured 11.3% top vs 31.2% bottom.
  assert.ok(before.top < (before.h - 1 - before.bottom) - 20,
    `fixture is not off-centre: top=${before.top} bottom=${before.h - 1 - before.bottom}`);

  const out = trimToContent(readFixture('offcentre-darts.png'));
  const after = contentBox(out.buffer);

  // Opposite margins now agree to within a pixel of each other.
  const marginL = after.left;
  const marginR = after.w - 1 - after.right;
  const marginT = after.top;
  const marginB = after.h - 1 - after.bottom;
  assert.ok(Math.abs(marginL - marginR) <= 1, `L=${marginL} R=${marginR}`);
  assert.ok(Math.abs(marginT - marginB) <= 1, `T=${marginT} B=${marginB}`);
});

test('a real image with huge margin ends up filling its canvas', () => {
  const src = readFixture('margin-staff.png');
  const before = contentBox(src);
  // Measured: content spans 32 of 256 px across -- 12.5%.
  const fillBefore = (before.right - before.left + 1) / before.w;
  assert.ok(fillBefore < 0.2, `fixture should start mostly empty, got ${fillBefore}`);

  const out = trimToContent(src);
  const after = contentBox(out.buffer);
  const fillW = (after.right - after.left + 1) / after.w;
  const fillH = (after.bottom - after.top + 1) / after.h;

  // Fills both axes bar the deliberate margin. At MARGIN_PCT=3 the content
  // spans ~94% of each axis (3% each side). Both axes, not just the long one:
  // the margin is taken per-axis precisely so an elongated subject does not
  // end up with a fat canvas that the renderer then stretches it to fill.
  const expected = 1 - (2 * MARGIN_PCT()) / 100;
  assert.ok(fillW > expected - 0.03, `fillW=${fillW} expected ~${expected}`);
  assert.ok(fillH > expected - 0.03, `fillH=${fillH} expected ~${expected}`);
});

test('the subject is never upscaled', () => {
  const src = readFixture('margin-staff.png');
  const before = contentBox(src);
  const out = trimToContent(src);
  const after = contentBox(out.buffer);
  const wBefore = before.right - before.left + 1;
  const wAfter = after.right - after.left + 1;
  // Trimming moves the subject; it must not resample it. Allow no growth at
  // all -- an upscale here is how crisp art turns to blur.
  assert.ok(wAfter <= wBefore, `subject grew from ${wBefore}px to ${wAfter}px`);
});

// --- the guard that decides whether the feature works at all ---------------

test('corner speckles below the alpha floor do not defeat the crop', () => {
  // The real failure mode: a feathered cutout leaves a barely-visible pixel in
  // a corner. At a naive alpha > 0 threshold that single pixel makes the
  // bounding box the whole canvas and the trim silently becomes a no-op that
  // still reports success.
  const src = makePng(100, 100, (x, y) => {
    if (x === 0 && y === 0) return [255, 0, 255, 3];        // speckle, invisible
    if (x === 99 && y === 99) return [255, 0, 255, 2];      // and another
    if (x >= 40 && x < 60 && y >= 40 && y < 60) return RED; // the actual subject
    return TRANSPARENT;
  });

  const out = trimToContent(src);
  const after = contentBox(out.buffer);
  const fill = (after.right - after.left + 1) / after.w;
  assert.ok(fill > 0.85, `speckle defeated the crop: content fills only ${fill}`);
  assert.ok(out.ratio < 0.5, `expected a real crop, ratio was ${out.ratio}`);
});

test('visible pixels near the floor are kept, not cropped away', () => {
  // The mirror of the test above, and the reason the floor cannot simply be
  // raised: alpha 40 is faint but genuinely visible -- a glow, a wisp of
  // smoke -- and cropping it off would eat real art.
  const src = makePng(100, 100, (x, y) => {
    if (x >= 10 && x < 20 && y >= 10 && y < 20) return [255, 255, 255, 40];
    if (x >= 40 && x < 60 && y >= 40 && y < 60) return RED;
    return TRANSPARENT;
  });
  const out = trimToContent(src);
  const after = contentBox(out.buffer);
  // The faint patch and the solid square must both survive: the content box
  // spans from one to the other, so it is wider than the square alone.
  const span = after.right - after.left + 1;
  assert.ok(span >= 45, `faint art was cropped away: span=${span}`);
});

// --- degenerate inputs -----------------------------------------------------

test('a fully opaque image is a no-op and says so', () => {
  // This is what every tile looks like. Nothing to trim, and the caller needs
  // to be able to tell that from a trim that failed.
  const src = makePng(64, 64, () => RED);
  const out = trimToContent(src);
  assert.strictEqual(out.ratio, 1, 'a full-canvas subject should report ratio 1');
  const after = contentBox(out.buffer);
  assert.strictEqual(after.w, 64);
  assert.strictEqual(after.h, 64);
});

test('a fully transparent image is left alone', () => {
  const src = makePng(32, 32, () => TRANSPARENT);
  const out = trimToContent(src);
  // There is no content to centre on. Returning the original is the only
  // honest answer; cropping to nothing would produce a 0x0 PNG that no
  // decoder accepts.
  assert.strictEqual(out.ratio, 1);
  assert.deepStrictEqual(out.buffer, src);
});

test('an unreadable image returns null rather than a guess', () => {
  assert.strictEqual(trimToContent(Buffer.from('not a png at all')), null);
  assert.strictEqual(trimToContent(Buffer.alloc(0)), null);
  assert.strictEqual(trimToContent(null), null);
});

test('a greyscale png is refused rather than mangled', () => {
  // colour type 0 has no alpha channel to find a bounding box in. pngAlpha
  // already refuses anything but 8-bit RGBA non-interlaced; the trim inherits
  // that rule instead of inventing a second one.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;    // greyscale
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc((4 + 1) * 4))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.strictEqual(trimToContent(png), null);
});

// --- the encoder ------------------------------------------------------------

test('encode round-trips every pixel exactly', () => {
  // The encoder is new code on a path where a wrong byte shows up as corrupted
  // art rather than an exception, so check the pixels, not just that it parses.
  //
  // Calls encodeRGBA DIRECTLY. Routing this through trimToContent was the
  // first attempt and it tested nothing: a full-canvas subject takes the
  // already-tight early return, which hands back the original buffer without
  // ever reaching the encoder. The test passed with the encoder unreachable.
  const width = 37;
  const height = 23;
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      px[i] = (x * 7) & 0xff;
      px[i + 1] = (y * 11) & 0xff;
      px[i + 2] = (x ^ y) & 0xff;
      px[i + 3] = ((x + y) % 2) ? 255 : 30;
    }
  }
  const encoded = encodeRGBA(width, height, px);
  const after = decodeRGBA(encoded);
  assert.ok(after, 'our own encoder produced something we cannot decode');
  assert.strictEqual(after.width, width);
  assert.strictEqual(after.height, height);
  assert.deepStrictEqual(after.px, px);
});

test('an image that is already tight is returned untouched', () => {
  // Idempotence, which the repair script depends on: running it twice must not
  // shave another margin off every image, and must not churn bytes for nothing.
  const src = makePng(40, 40, () => RED);
  const once = trimToContent(src);
  const twice = trimToContent(once.buffer);
  assert.strictEqual(twice.ratio, 1);
  assert.deepStrictEqual(twice.buffer, once.buffer);
});

test('the reported ratio is the real area change', () => {
  // A 20x20 subject inside 100x100. After the trim the canvas is the subject
  // plus 3% margin, so the area ratio is far below 1 -- and this number is
  // what makes a no-op trim visible in the job record instead of silent.
  const src = makePng(100, 100, (x, y) => (
    (x >= 40 && x < 60 && y >= 40 && y < 60) ? RED : TRANSPARENT));
  const out = trimToContent(src);
  const after = decodeRGBA(out.buffer);
  const measured = (after.width * after.height) / (100 * 100);
  assert.ok(Math.abs(out.ratio - measured) < 1e-9,
    `reported ${out.ratio} but the image is ${measured}`);
  assert.ok(out.ratio < 0.1, `expected a large crop, got ${out.ratio}`);
});

// --- encoder efficiency ----------------------------------------------------

test('scanlines are filtered adaptively, not all written as type 0', () => {
  // REGRESSION GUARD, and it earned its place. Every row originally went out
  // with filter 0 (none), which decodes perfectly and looks fine in a unit
  // test -- but deflate does badly on raw RGBA gradients. The repair pass's
  // dry run over the real corpus reported it growing from 58MB to 78MB:
  // rose_bush went 94,245 -> 126,197 bytes while being cropped to 28% of its
  // area, about 4.7x the bytes per pixel. Nothing in the test suite noticed,
  // because size is not correctness -- until you are shipping every entity
  // image to a browser through a rate limiter.
  const width = 64;
  const height = 64;
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      px[i] = x * 4;              // a smooth horizontal ramp, which Sub predicts
      px[i + 1] = y * 4;          // and a vertical one, which Up predicts
      px[i + 2] = 128;
      px[i + 3] = 255;
    }
  }
  const encoded = encodeRGBA(width, height, px);

  // Read the filter byte off each scanline of the decompressed IDAT.
  const chunks = [];
  let off = 8;
  while (off + 8 <= encoded.length) {
    const len = encoded.readUInt32BE(off);
    const type = encoded.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') chunks.push(encoded.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const used = new Set();
  for (let y = 0; y < height; y += 1) used.add(raw[y * (stride + 1)]);

  assert.ok(!(used.size === 1 && used.has(0)),
    'every scanline used filter 0 -- adaptive selection is not running');

  // And the point of it: the result is materially smaller than the same
  // pixels written unfiltered.
  const unfiltered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    unfiltered[y * (stride + 1)] = 0;
    px.copy(unfiltered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const naive = zlib.deflateSync(unfiltered, { level: 9 }).length;
  const actual = zlib.deflateSync(raw, { level: 9 }).length;
  assert.ok(actual < naive * 0.9,
    `filtering saved little: ${actual} vs ${naive} bytes unfiltered`);
});
