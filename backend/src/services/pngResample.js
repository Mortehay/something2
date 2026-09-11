const { decodeRGBA } = require('./pngAlpha.js');
const { encodeRGBA } = require('./pngTrim.js');

// SOMET-573. Shrink the COMMITTED copy of an icon to a display-sized edge.
//
// WHY. The three icon kinds (skills, passive labels, items) come off the
// generator as 1024px cutouts and export at 100-780 KB each -- 96 MB for
// the catalogue, against 26 MB for every tile and entity combined. The game
// draws them at 48 px (skill grid), 32 px (admin table) and 30 px (inventory
// slots). Capping the longest edge at 256 keeps them 5x oversampled on a
// 1x display and 2.7x on a 2x one, and brings the set to 26 MB.
//
// WHAT IT IS NOT. Not lossless: measured on the real files there is no pixel
// grid to downscale along (PSNR is flat 20-30 dB at every integer factor)
// and lossless re-encoding saves 2-3%. This is a deliberate, bounded loss on
// the committed copy only; the object store keeps the original.
//
// AREA AVERAGE, NOT NEAREST. Nearest-neighbour on a stylistic "pixel art"
// image with no real grid produces sparkle and dropped lines. Each
// destination pixel is the exact area-weighted mean of the source pixels it
// covers, including fractional coverage at non-integer factors -- an integer
// factor over solid blocks is therefore exact.
//
// PREMULTIPLIED. Averaging straight RGBA darkens every silhouette edge: a red
// pixel next to three transparent black ones becomes dark red at a quarter
// alpha. Weighting colour by alpha and dividing back out keeps the colour
// red and only lowers the alpha, which is what a downscaled edge should be.

function resampleRGBA(img, maxEdge) {
  const { width, height, px } = img;
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return img;

  const scale = maxEdge / longest;
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));
  const sx = width / dw;
  const sy = height / dh;
  const out = Buffer.alloc(dw * dh * 4);

  // Per-axis coverage tables: for each destination index, the source range
  // [start, end) and the fractional weight of each source cell in it.
  const axis = (dstN, srcN, ratio) => {
    const table = new Array(dstN);
    for (let d = 0; d < dstN; d += 1) {
      const from = d * ratio;
      const to = Math.min(srcN, (d + 1) * ratio);
      const first = Math.floor(from);
      const last = Math.min(srcN - 1, Math.ceil(to) - 1);
      const weights = [];
      for (let s = first; s <= last; s += 1) {
        const w = Math.min(to, s + 1) - Math.max(from, s);
        if (w > 0) weights.push([s, w]);
      }
      table[d] = weights;
    }
    return table;
  };
  const cols = axis(dw, width, sx);
  const rows = axis(dh, height, sy);

  for (let dy = 0; dy < dh; dy += 1) {
    for (let dx = 0; dx < dw; dx += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0; let area = 0;
      for (const [y, wy] of rows[dy]) {
        for (const [x, wx] of cols[dx]) {
          const w = wx * wy;
          const i = (y * width + x) * 4;
          const alpha = px[i + 3];
          r += px[i] * alpha * w;
          g += px[i + 1] * alpha * w;
          b += px[i + 2] * alpha * w;
          a += alpha * w;
          area += w;
        }
      }
      const o = (dy * dw + dx) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / area);
      }
      // a == 0: fully transparent, leave the zeroed bytes.
    }
  }
  return { width: dw, height: dh, px: out };
}

// PNG in, PNG out. Anything this module cannot read (palette, 16-bit,
// interlaced, not a PNG) is returned as it came: an unreadable icon is still
// worth committing at full size, and the caller reports `source: null`.
function shrinkToEdge(buffer, maxEdge) {
  const img = decodeRGBA(buffer);
  if (!img) return { buffer, source: null, resized: false };
  const source = { width: img.width, height: img.height };
  const out = resampleRGBA(img, maxEdge);
  if (out === img) return { buffer, source, resized: false };
  return { buffer: encodeRGBA(out.width, out.height, out.px), source, resized: true };
}

module.exports = { resampleRGBA, shrinkToEdge };
