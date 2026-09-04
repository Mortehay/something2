const zlib = require('node:zlib');

// SOMET-540. Reading a PNG's ALPHA CHANNEL, to answer one question the
// header cannot: was the backdrop actually removed?
//
// WHY THIS EXISTS, measured on a live batch 2026-09-04. The existing guard asks
// "does this PNG have an alpha channel" -- byte 25 of the header. A passive
// label came back as a SCENE (a character beside a wardrobe) on the flat
// magenta backdrop, with the backdrop never keyed: 90% opaque, alpha channel
// present, colour type 6. It passed the header check, passed the provider's own
// 422 threshold (which fires near 1%), and was recorded as a success. In an icon
// slot it is a magenta square.
//
// HOW MUCH OF IT IS ACTUALLY GONE is the tell. Measured across 12 real images
// from this provider -- the ten judged usable by eye and the two judged
// failures -- the separation is wide and clean:
//
//   usable:   67 79 83 89 90 92 92 93 94 95  (% transparent)
//   failures: 10 ("Afterimage", a scene on an unkeyed backdrop)
//              4 ("Focus", a scattered scene)
//
// A floor anywhere between those two clusters separates them perfectly.
//
// A CORNER TEST WAS TRIED FIRST AND REJECTED, recorded here so it is not tried
// again: "an unkeyed backdrop leaves all four corners opaque" sounds sharper
// than a percentage, and it does not work. The failing image's magenta block is
// INSET, with a keyed margin around it, so all four corners read transparent --
// opaqueCorners was 0 for every image, good and bad alike. It discriminated
// nothing.
//
// NO NEW DEPENDENCY. This decodes only what it needs -- 8-bit RGBA,
// non-interlaced, which is what every provider on this path returns -- and
// answers `null` for anything else. That is the same rule the rest of the image
// guarding follows: refuse what we can positively see is wrong, never reject
// what we merely cannot read.

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Walk the chunk list, collecting IHDR and the IDAT payloads.
function readChunks(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    const end = start + len;
    if (end + 4 > buf.length) return null;               // truncated
    if (type === 'IHDR') ihdr = buf.subarray(start, end);
    else if (type === 'IDAT') idat.push(buf.subarray(start, end));
    else if (type === 'IEND') break;
    off = end + 4;                                       // + CRC
  }
  if (!ihdr || ihdr.length < 13 || idat.length === 0) return null;
  return {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    depth: ihdr[8],
    colourType: ihdr[9],
    interlace: ihdr[12],
    idat: Buffer.concat(idat),
  };
}

// PNG filtering is per-scanline and references the row above, so there is no
// way to read one corner without unfiltering everything above it.
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const o = y * stride;
    const prev = o - stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[o + x - bpp] : 0;        // left
      const b = y > 0 ? out[prev + x] : 0;              // up
      const c = (y > 0 && x >= bpp) ? out[prev + x - bpp] : 0;  // up-left
      const v = line[x];
      let val;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          val = v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
          break;
        }
        default: return null;                            // unknown filter
      }
      out[o + x] = val & 0xff;
    }
  }
  return out;
}

// How transparent is this image, and are its corners keyed?
//
// Returns null when the image is not one we can read -- which callers must
// treat as "no opinion", never as a failure.
const OPAQUE = 200;          // an alpha this high is visibly solid
const CLEAR = 16;            // and this low is visibly gone

function alphaProfile(buf) {
  const png = readChunks(buf);
  if (!png) return null;
  // Only the shape every provider on this path actually returns. Anything else
  // (16-bit, palette, greyscale, interlaced) is not decoded rather than guessed.
  if (png.colourType !== 6 || png.depth !== 8 || png.interlace !== 0) return null;

  let raw;
  try {
    raw = zlib.inflateSync(png.idat);
  } catch {
    return null;
  }
  const bpp = 4;
  const { width, height } = png;
  if (raw.length < (width * bpp + 1) * height) return null;
  const px = unfilter(raw, width, height, bpp);
  if (!px) return null;

  const stride = width * bpp;
  let clear = 0;
  const total = width * height;
  for (let i = 3; i < px.length; i += bpp) if (px[i] < CLEAR) clear += 1;

  return { width, height, transparentPct: (clear * 100) / total };
}

// The floor, placed in the gap measured above: 2.5x above the worst failure
// (10%) and 2.7x below the least-transparent success (67%). Deliberately not
// tight to either cluster -- a subject that legitimately fills more of its
// frame should pass, and the failure this catches is not marginal.
const MIN_TRANSPARENT_PCT = () => parseFloat(process.env.ART_MIN_TRANSPARENT_PCT || '25');

module.exports = { alphaProfile, MIN_TRANSPARENT_PCT, OPAQUE, CLEAR };
