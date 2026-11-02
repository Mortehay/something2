const { decodeRGBA } = require('./pngAlpha.js');

// SOMET-697. The GPU box sometimes draws a frame as a close-up (head to knees)
// and then shrinks it into the cell, so the figure looks bigger and cut off.
// Measured on a real idle sheet: frame1/frame0 opaque area was 1.00-1.09 for
// full-body rows and 1.18-1.46 for close-ups. 1.15 separates them.
const ALPHA_MIN = 32;
const CHECK = 'size_jump';
const ratioLimit = () => {
  const v = parseFloat(process.env.SPRITE_SIZE_JUMP_RATIO);
  return Number.isFinite(v) && v > 1 ? v : 1.15;
};

function opaqueArea(img, [x, y, w, h]) {
  let n = 0;
  const x1 = Math.min(x + w, img.width);
  const y1 = Math.min(y + h, img.height);
  for (let yy = Math.max(0, y); yy < y1; yy += 1) {
    for (let xx = Math.max(0, x); xx < x1; xx += 1) {
      if (img.px[(yy * img.width + xx) * 4 + 3] > ALPHA_MIN) n += 1;
    }
  }
  return n;
}

// Frames of a row whose figure is much bigger than the row's smallest frame.
function sizeJumpFlags(sheetPng, manifest) {
  const img = decodeRGBA(sheetPng);
  if (!img || !manifest || !Array.isArray(manifest.rows) || !manifest.frames) return [];
  const limit = ratioLimit();
  const flags = [];
  for (const row of manifest.rows) {
    if (!(row.frames > 1)) continue;
    const areas = [];
    for (let i = 0; i < row.frames; i += 1) {
      const rect = manifest.frames[`${row.action}/${row.direction}/${i}`];
      areas.push(rect ? opaqueArea(img, rect) : 0);
    }
    const nonZero = areas.filter((a) => a > 0);
    if (!nonZero.length) continue;
    const base = Math.min(...nonZero);
    areas.forEach((a, i) => {
      if (a > 0 && a / base > limit) {
        flags.push({
          action: row.action,
          direction: row.direction,
          frame: i,
          passed: false,
          source: 'something2',
          check: CHECK,
          failed_checks: [CHECK],
          reason: `size jump: figure area +${Math.round((a / base - 1) * 100)}% vs the smallest frame of ${row.action}/${row.direction} (likely a close-up)`,
        });
      }
    });
  }
  return flags;
}

// Keep every existing entry except earlier size_jump ones (replaced by the new
// run); a frame another check already flagged keeps that entry alone.
function mergeQuality(existing, flags) {
  const kept = (Array.isArray(existing) ? existing : []).filter((q) => !(q && q.check === CHECK));
  const taken = new Set(kept.map((q) => q && `${q.action}/${q.direction}/${q.frame}`));
  return [...kept, ...flags.filter((f) => !taken.has(`${f.action}/${f.direction}/${f.frame}`))];
}

// Never throws: on any error the manifest comes back unchanged.
function withSizeJumpFlags(sheetPng, manifest, log = console.error) {
  try {
    const flags = sizeJumpFlags(sheetPng, manifest);
    const had = Array.isArray(manifest.quality) && manifest.quality.some((q) => q && q.check === CHECK);
    if (!flags.length && !had) return manifest;
    return { ...manifest, quality: mergeQuality(manifest.quality, flags) };
  } catch (err) {
    log(`sprite size check failed: ${err.message}`);
    return manifest;
  }
}

module.exports = { sizeJumpFlags, mergeQuality, withSizeJumpFlags };
