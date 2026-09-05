const zlib = require('node:zlib');

// A real PNG encoder, for tests that need a real PNG.
//
// Shared by png_alpha.test.js (which tests the decoder) and
// art_dispatcher_catalog_db.test.js (which needs an image the transparency
// guard will refuse). One copy, because two copies of a fixture builder is how
// they drift and stop describing the same thing.

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

// An 8-bit RGBA PNG. `alphaAt(x, y)` decides each pixel's alpha, so a test can
// describe a shape rather than a byte array. `filter` picks the PNG row filter,
// because unfiltering is where a decoder actually goes wrong.
function makePng(width, height, alphaAt, { filter = 0, colourType = 6, depth = 8, interlace = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = colourType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = interlace;

  const bpp = 4;
  const stride = width * bpp;
  const rows = [];
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const raw = Buffer.alloc(stride);
    for (let x = 0; x < width; x += 1) {
      raw[x * bpp] = 200; raw[x * bpp + 1] = 40; raw[x * bpp + 2] = 200;  // magenta
      raw[x * bpp + 3] = alphaAt(x, y);
    }
    const enc = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? raw[i - bpp] : 0;
      const b = prev[i];
      if (filter === 0) enc[i] = raw[i];
      else if (filter === 1) enc[i] = (raw[i] - a) & 0xff;
      else if (filter === 2) enc[i] = (raw[i] - b) & 0xff;
      else throw new Error('unsupported test filter');
    }
    rows.push(Buffer.concat([Buffer.from([filter]), enc]));
    raw.copy(prev);
  }
  return Buffer.concat([
    SIG, chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CLEAR = 0;
const SOLID = 255;

// The measured failure shape: an opaque block with a KEYED MARGIN around it.
// Roughly 90% opaque, corners transparent -- what came back from a live batch
// as a scene on an unkeyed backdrop and was recorded as a success.
function unkeyedBackdropPng(n = 100, inset = 5) {
  return makePng(n, n, (x, y) => (
    x >= inset && x < n - inset && y >= inset && y < n - inset ? SOLID : CLEAR));
}

// A clean cutout: a small centred object, mostly transparent.
function cutoutPng(n = 100) {
  const a = Math.floor(n * 0.35);
  const b = Math.floor(n * 0.65);
  return makePng(n, n, (x, y) => (x >= a && x < b && y >= a && y < b ? SOLID : CLEAR));
}

module.exports = { makePng, unkeyedBackdropPng, cutoutPng, CLEAR, SOLID };
