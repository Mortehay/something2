// SOMET-668: GPU-box walk rows are not a stable cycle. On Warrior:1 the east
// walk row alternates a wide lunge (body centroid x ~19.7) with an upright
// stance (~31.0) -- an ~11 px sideways jump twice a cycle while the world
// position moves smoothly, which reads as the player snapping backward.
// This measures each walk frame's upper-body centroid once per atlas and
// yields a per-frame horizontal offset (source px) that pulls every frame of a
// row onto the row's mean. It hides the lateral jump, not the pose swap.

const BODY_FRACTION = 0.44; // top rows only: legs/feet swing legitimately
const ALPHA_MIN = 40;
const MAX_SHIFT_FRACTION = 0.4; // a bigger correction means a bad measure; skip

// x centroid (frame-local px) of opaque pixels in the top of `rect`, or null.
export function bodyCentroidX(image, rect) {
  const [rx, ry, rw, rh] = rect;
  const rows = Math.max(1, Math.round(rh * BODY_FRACTION));
  let sum = 0;
  let n = 0;
  for (let y = ry; y < ry + rows && y < image.height; y++) {
    for (let x = rx; x < rx + rw && x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] > ALPHA_MIN) {
        sum += x - rx;
        n++;
      }
    }
  }
  return n ? sum / n : null;
}

// { "walk/e/0": shiftPx, ... } -- only frames that need a nonzero shift.
export function walkAnchorOffsets(manifest, image) {
  const rows = new Map();
  for (const [key, rect] of Object.entries((manifest && manifest.frames) || {})) {
    const parts = key.split("/");
    if (parts[0] !== "walk" || parts.length !== 3 || !Array.isArray(rect)) continue;
    const c = bodyCentroidX(image, rect);
    if (c === null) continue;
    const row = `${parts[0]}/${parts[1]}`;
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push({ key, c, w: rect[2] });
  }
  const out = {};
  for (const frames of rows.values()) {
    if (frames.length < 2) continue;
    const mean = frames.reduce((s, f) => s + f.c, 0) / frames.length;
    for (const f of frames) {
      const shift = mean - f.c;
      if (Math.abs(shift) < 0.5 || Math.abs(shift) > f.w * MAX_SHIFT_FRACTION) continue;
      out[f.key] = shift;
    }
  }
  return out;
}

export function walkAnchorFor(table, key) {
  return (table && table[key]) || 0;
}

// Per-atlas cache. getImageData can throw (tainted canvas) or the atlas can be
// unreadable: then there is simply no correction.
//
// SOMET-764: a failed read is cached too (as null). It is final for that
// image, and this runs per creature per frame -- retrying it rebuilt and
// re-read the whole atlas every frame, ~100 ms/frame on the first map. Only
// an atlas with no size yet (still decoding) is measured again later.
const cache = new WeakMap();
export function walkAnchorTable(atlas, manifest, createCanvas = defaultCanvas) {
  if (!atlas || !manifest) return null;
  if (cache.has(atlas)) return cache.get(atlas);
  const w = atlas.naturalWidth || atlas.width;
  const h = atlas.naturalHeight || atlas.height;
  if (!(w > 0 && h > 0)) return null;
  let table = null;
  try {
    const cv = createCanvas(w, h);
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(atlas, 0, 0);
    table = walkAnchorOffsets(manifest, ctx.getImageData(0, 0, w, h));
  } catch {
    table = null;
  }
  cache.set(atlas, table);
  return table;
}

function defaultCanvas(w, h) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  return cv;
}
