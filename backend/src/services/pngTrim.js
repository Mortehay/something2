const zlib = require('node:zlib');
const { decodeRGBA, CLEAR } = require('./pngAlpha.js');

// SOMET-562. Crop a generated sprite down to the subject it actually drew.
//
// WHY THIS IS A SCALE BUG AND NOT A COSMETIC ONE. RenderSystem.drawCreature
// blits with the five-argument drawImage(img, x, y, w, h), which stretches the
// WHOLE image -- transparent margin included -- into the entity's display box.
// So a subject occupying 30% of its canvas renders at 30% of the width it was
// authored for, and two props drawn with different margins render at visibly
// different sizes for no reason the author can see or control.
//
// MEASURED BEFORE BUILDING (SOMET-561), alpha bbox against canvas:
//
//   remote provider   mean fill  W 30.4%  H 54.4%    0/11 already tight
//   local sprite-gen  mean fill  W 89.3%  H 90.4%
//   tiles (control)   mean fill  W  100%  H  100%   50/50 already tight
//
// The local path already calls crop_to_content(); the remote one stores the
// raw 1024x1024 square. archmage_staff spans 11.8% of its width. That is the
// whole defect -- not the prompt, not the model.
//
// WHAT IT DELIBERATELY DOES NOT DO: resample. The subject keeps its own
// resolution and is never scaled up to refill the canvas it was drawn on. A
// generator centres a small object in a large frame, so restoring the original
// canvas size would upscale a ~70px boulder to 1024 and turn crisp art to
// blur. The renderer scales to display_width/display_height regardless, so an
// upscale here buys nothing and costs detail.
//
// TILES MUST NOT COME THROUGH HERE. A ground tile is meant to be fully opaque
// and full-bleed; it has no subject to find. In practice a tile trims to a
// no-op (its bbox is the whole canvas), but the caller excludes tiles by kind
// rather than relying on that, because "harmless today" is not a guarantee.

// The alpha floor for "this pixel is content".
//
// LOAD-BEARING, and the single reason this feature works at all. A feathered
// cutout leaves alpha-1 and alpha-2 speckles in the corners. At the obvious
// threshold -- alpha > 0 -- one such pixel drags the bounding box out to the
// full canvas, every image measures as already perfectly tight, and the trim
// becomes a silent no-op that still reports success. It would have passed a
// test suite written against synthetic fixtures.
//
// CLEAR is imported rather than redeclared: pngAlpha already owns the
// definition of "an alpha this low is visibly gone" and there must not be two
// answers to that question in one codebase.
const CONTENT_ALPHA = CLEAR;

// Breathing room left around the subject, as a percentage of EACH AXIS.
//
// Not decoration either. A cutout's edge is feathered over a pixel or two, and
// cropping flush to it puts partially-transparent pixels hard against the
// frame, which reads as a hard cut line against terrain. 3% is enough to keep
// the fade inside the image and small enough to be invisible once the renderer
// has scaled the result into a 64x104 box.
//
// PER-AXIS, NOT A UNIFORM PIXEL MARGIN off the longer side -- that was the
// first attempt and the tests caught it. A staff 32px wide and 216px tall
// takes a 6px margin off its height; applying those same 6px across gives a
// 44px-wide canvas holding a 32px subject, so the content fills 95% of the
// height but only 73% of the width. The renderer then stretches that canvas
// into the display box and the staff comes out fat. Taking 3% of each axis
// separately keeps outW:outH equal to contentW:contentH, so the subject's
// proportions survive the trip through drawImage.
const MARGIN_PCT = () => parseFloat(process.env.ART_TRIM_MARGIN_PCT || '3');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- encoding ---------------------------------------------------------------
//
// pngAlpha decodes; nothing here encoded until now. Written out rather than
// taking a dependency: `sharp` is the obvious answer and it is a native module
// pulled in for a job that needs no resampling, no colour management and no
// format conversion -- only "write these RGBA bytes back out". That is ~50
// lines, and it keeps the no-new-dependency rule pngAlpha states for itself.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

// Choose a per-scanline filter, the way every real encoder does.
//
// THIS WAS FILTER 0 (NONE) FOR EVERY ROW AND IT WAS A MEASURABLE MISTAKE. The
// comment defending it said the extra bytes were not worth the complexity;
// the repair pass's dry run then reported the whole corpus growing from 58MB
// to 78MB. rose_bush went from 94,245 to 126,197 bytes while being cropped to
// 28% of its area -- roughly 4.7x the bytes per pixel. Deflate on raw RGBA
// gradients does badly; deflate on filtered residuals does well, and that gap
// is what PNG filtering exists for. On a project already fighting an asset
// burst that trips a rate limiter, shipping images 3-4x heavier per pixel to
// save fifty lines here would have been the wrong trade.
//
// The heuristic is the standard one from the PNG spec's own guidance: filter
// each row five ways, keep the one whose residuals have the smallest summed
// magnitude, treating each byte as signed. It is not optimal -- optimal needs
// a search across rows -- but it is what libpng does by default and it
// recovers essentially all of the difference.
const FILTERS = 5;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Residual of `type` at byte i of `row`, given the raw bytes of the row above.
function residual(type, row, prev, i, bpp) {
  const x = row[i];
  const a = i >= bpp ? row[i - bpp] : 0;
  const b = prev ? prev[i] : 0;
  const c = (prev && i >= bpp) ? prev[i - bpp] : 0;
  switch (type) {
    case 1: return (x - a) & 0xff;
    case 2: return (x - b) & 0xff;
    case 3: return (x - ((a + b) >> 1)) & 0xff;
    case 4: return (x - paeth(a, b, c)) & 0xff;
    default: return x;
  }
}

function encodeRGBA(width, height, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // colour type: truecolour with alpha
  ihdr[10] = 0;     // compression: deflate
  ihdr[11] = 0;     // filter method: adaptive
  ihdr[12] = 0;     // interlace: none

  const bpp = 4;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;

    let bestType = 0;
    let bestScore = Infinity;
    for (let type = 0; type < FILTERS; type += 1) {
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const v = residual(type, row, prev, i, bpp);
        // Signed magnitude: a residual of 255 is -1, which deflate likes as
        // much as 1. Scoring it as 255 would reject the best filter.
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; bestType = type; }
    }

    for (let i = 0; i < stride; i += 1) {
      candidate[i] = residual(bestType, row, prev, i, bpp);
    }
    raw[y * (stride + 1)] = bestType;
    candidate.copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the trim ---------------------------------------------------------------

// The bounding box of content, or null when the image holds none.
function contentBounds(width, height, px) {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (px[row + x * 4 + 3] >= CONTENT_ALPHA) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return right < 0 ? null : { left, top, right, bottom };
}

/**
 * Crop `buf` to its subject, leaving a small margin.
 *
 * Returns `{ buffer, ratio, width, height }`, or `null` when the image is not
 * one we can read -- which the caller must treat as "store the original", never
 * as a failure. `ratio` is the new area over the old: 1 means nothing was
 * trimmed, which is how a no-op stays VISIBLE instead of being inferred from a
 * success that did nothing.
 */
function trimToContent(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  const img = decodeRGBA(buf);
  if (!img) return null;

  const { width, height, px } = img;
  const bounds = contentBounds(width, height, px);
  // Nothing opaque enough to be a subject. Cropping to an empty box would
  // produce a 0x0 PNG that no decoder accepts, so hand back what we were
  // given and report honestly that nothing changed.
  if (!bounds) return { buffer: buf, ratio: 1, width, height };

  const contentW = bounds.right - bounds.left + 1;
  const contentH = bounds.bottom - bounds.top + 1;
  const pct = MARGIN_PCT();
  // At least a pixel each side whatever the arithmetic says: the margin exists
  // to keep a feathered edge off the frame, and that need does not shrink just
  // because the subject is small.
  const marginX = Math.max(1, Math.round((contentW * pct) / 100));
  const marginY = Math.max(1, Math.round((contentH * pct) / 100));
  const outW = contentW + marginX * 2;
  const outH = contentH + marginY * 2;

  // Already as tight as we would make it. Re-encoding would churn the bytes of
  // every image on every repair run for no visual change, and would make the
  // repair script non-idempotent.
  if (outW >= width && outH >= height) {
    return { buffer: buf, ratio: 1, width, height };
  }

  const out = Buffer.alloc(outW * outH * 4);   // zero-filled: transparent
  for (let y = 0; y < contentH; y += 1) {
    const src = ((bounds.top + y) * width + bounds.left) * 4;
    const dst = ((marginY + y) * outW + marginX) * 4;
    px.copy(out, dst, src, src + contentW * 4);
  }

  return {
    buffer: encodeRGBA(outW, outH, out),
    ratio: (outW * outH) / (width * height),
    width: outW,
    height: outH,
  };
}

module.exports = {
  trimToContent, encodeRGBA, CONTENT_ALPHA, MARGIN_PCT,
};
