'use strict';
// Pure image transforms for the "web copy" feature: PNG in, WebP out.
// No database or storage access. Sheets and strips are resized frame by frame
// so cells stay on an integer grid and neighbouring frames never bleed.

// sharp is loaded on first use, never at require time: a missing or broken
// native build then fails a shrink ('shrinker_unavailable' -- an install
// problem, never blamed on the image), not the backend's boot.
// Its libvips pool is capped so a batch run leaves cores for the game.
const SHARP_CONCURRENCY = 2;
let sharpLib = null;
function sharp(...args) {
  if (!sharpLib) {
    let lib;
    try {
      lib = require('sharp');
    } catch (e) {
      const why = String((e && e.message) || e).split('\n')[0];
      throw new ShrinkError('shrinker_unavailable',
        `image library sharp failed to load (${why}); run npm install in backend/`);
    }
    lib.concurrency(SHARP_CONCURRENCY);
    sharpLib = lib;
  }
  return sharpLib(...args);
}

class ShrinkError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ShrinkError';
    this.code = code;
  }
}

// Wrap a transform failure as bad_image, but keep a ShrinkError's own code
// (shrinker_unavailable must not turn into "the image is bad").
const asShrinkError = (e, what) => (e instanceof ShrinkError ? e : new ShrinkError('bad_image', `${what}: ${e.message}`));

const EPS = 1e-9;

function scaled(v, scale) {
  const r = v * scale;
  if (Math.abs(r - Math.round(r)) > EPS) {
    throw new ShrinkError('fractional_cell', `${v} * ${scale} is not an integer`);
  }
  return Math.round(r);
}

// Plain lossy WebP for single images. Sheets/strips use near-lossless: lossy
// filtering smears colour ~1px across a hard cell edge (blue ~80/255 into a
// red neighbour at q85-100), which breaks the "no bleed between frames" rule.
function webp(pipeline, quality, nearLossless = false) {
  return pipeline.webp({ quality, alphaQuality: 100, nearLossless }).toBuffer();
}

async function readMeta(buf) {
  try {
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions');
    return meta;
  } catch (e) {
    throw asShrinkError(e, 'unreadable image');
  }
}

async function shrinkImage(buf, { maxEdge, quality = 85 } = {}) {
  const meta = await readMeta(buf);
  const srcWidth = meta.width;
  const srcHeight = meta.height;
  let width = srcWidth;
  let height = srcHeight;
  const longest = Math.max(srcWidth, srcHeight);
  if (maxEdge && longest > maxEdge) {
    const k = maxEdge / longest;
    width = Math.max(1, Math.round(srcWidth * k));
    height = Math.max(1, Math.round(srcHeight * k));
  }
  try {
    let p = sharp(buf);
    if (width !== srcWidth || height !== srcHeight) {
      p = p.resize(width, height, { fit: 'fill', kernel: 'lanczos3' });
    }
    return { buffer: await webp(p, quality), width, height, srcWidth, srcHeight };
  } catch (e) {
    throw asShrinkError(e, 'shrink failed');
  }
}

// rects: [[x, y, w, h], ...] in source pixels. Returns the new image and the
// scaled rects (same order). Every scaled value must be an integer.
async function shrinkRects(buf, rects, scale, quality) {
  const meta = await readMeta(buf);
  const width = scaled(meta.width, scale);
  const height = scaled(meta.height, scale);
  const out = rects.map((r) => r.map((v) => scaled(v, scale)));
  try {
    if (scale === 1) {
      return { buffer: await webp(sharp(buf), quality, true), width, height, rects: out };
    }
    const layers = [];
    for (let i = 0; i < rects.length; i++) {
      const [x, y, w, h] = rects[i];
      const [nx, ny, nw, nh] = out[i];
      const input = await sharp(buf)
        .extract({ left: x, top: y, width: w, height: h })
        .resize(nw, nh, { fit: 'fill', kernel: 'lanczos3' })
        .png()
        .toBuffer();
      layers.push({ input, left: nx, top: ny });
    }
    const canvas = sharp({
      create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite(layers);
    return { buffer: await webp(canvas, quality, true), width, height, rects: out };
  } catch (e) {
    throw asShrinkError(e, 'shrink failed');
  }
}

async function shrinkSheet(buf, manifest, { scale, quality = 85 } = {}) {
  const next = JSON.parse(JSON.stringify(manifest));
  const keys = Object.keys(next.frames || {});
  const cell = scaled(next.cell[0], scale);
  const cellH = scaled(next.cell[1], scale);
  const r = await shrinkRects(buf, keys.map((k) => next.frames[k]), scale, quality);
  keys.forEach((k, i) => { next.frames[k] = r.rects[i]; });
  next.cell = [cell, cellH];
  return { buffer: r.buffer, manifest: next, width: r.width, height: r.height };
}

async function shrinkStrip(buf, frames, { scale, quality = 85 } = {}) {
  const meta = await readMeta(buf);
  if (!Number.isInteger(frames) || frames < 1 || meta.width % frames !== 0) {
    throw new ShrinkError('bad_image', `width ${meta.width} is not divisible by ${frames} frames`);
  }
  const cw = meta.width / frames;
  const rects = [];
  for (let i = 0; i < frames; i++) rects.push([i * cw, 0, cw, meta.height]);
  const r = await shrinkRects(buf, rects, scale, quality);
  return { buffer: r.buffer, width: r.width, height: r.height };
}

module.exports = { shrinkImage, shrinkSheet, shrinkStrip, ShrinkError };
