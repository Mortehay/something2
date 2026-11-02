const { decodeRGBA } = require('./pngAlpha.js');
const { encodeRGBA } = require('./pngTrim.js');

// SOMET-701. Replace flagged frames of a stored sheet with the nearest good
// frame of the same action/direction row. Pure: bytes in, bytes out.
//
// Idle and sway frames are copied one pixel UP (bottom row transparent) so the
// loop still moves; every other action is copied as-is.

const SHIFT_UP_ACTIONS = new Set(['idle', 'sway']);

const keyOf = (t) => `${t.action}/${t.direction}/${t.frame}`;

// Frame indices present for action/direction, ascending.
function rowIndices(manifest, action, direction) {
  const prefix = `${action}/${direction}/`;
  const out = [];
  for (const k of Object.keys(manifest.frames || {})) {
    if (!k.startsWith(prefix)) continue;
    const i = Number(k.slice(prefix.length));
    if (Number.isInteger(i)) out.push(i);
  }
  return out.sort((a, b) => a - b);
}

function copyCell(px, W, src, dst, shiftUp) {
  const [sx, sy, w, h] = src;
  const [dx, dy, dw, dh] = dst;
  const cw = Math.min(w, dw);
  const ch = Math.min(h, dh);
  // Read the source first: it may not overlap the destination, but be safe.
  const cell = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y += 1) px.copy(cell, y * cw * 4, ((sy + y) * W + sx) * 4, ((sy + y) * W + sx + cw) * 4);
  for (let y = 0; y < ch; y += 1) {
    const from = shiftUp ? y + 1 : y;
    const o = ((dy + y) * W + dx) * 4;
    if (from >= ch) px.fill(0, o, o + cw * 4);
    else cell.copy(px, o, from * cw * 4, (from + 1) * cw * 4);
  }
}

function replaceFrames(sheetPng, manifest, targets) {
  const img = decodeRGBA(sheetPng);
  if (!img) throw new Error('sheet.png is not a readable RGBA PNG');
  const px = Buffer.from(img.px);
  const targetKeys = new Set(targets.map(keyOf));
  const failed = new Set(targetKeys);
  for (const q of manifest.quality || []) if (q && q.passed === false) failed.add(keyOf(q));
  const replaced = [];
  const skipped = [];
  const done = new Map();

  for (const t of targets) {
    const key = keyOf(t);
    const rect = manifest.frames && manifest.frames[key];
    if (!rect) { skipped.push({ frame: key, reason: 'not a frame of this sheet' }); continue; }
    let best = null;
    for (const i of rowIndices(manifest, t.action, t.direction)) {
      if (failed.has(`${t.action}/${t.direction}/${i}`)) continue;
      const d = Math.abs(i - t.frame);
      if (best === null || d < best.d) best = { i, d }; // ascending scan: ties keep the lower index
    }
    if (!best) { skipped.push({ frame: key, reason: `no good frame in ${t.action}/${t.direction}` }); continue; }
    const from = `${t.action}/${t.direction}/${best.i}`;
    copyCell(px, img.width, manifest.frames[from], rect, SHIFT_UP_ACTIONS.has(t.action));
    replaced.push({ frame: key, from });
    done.set(key, from);
  }

  const next = { ...manifest };
  if (Array.isArray(manifest.quality)) {
    next.quality = manifest.quality.map((q) => {
      const from = q && done.get(keyOf(q));
      if (!from) return q;
      const { reason, check, size_jump_reason: _s, ...keep } = q;
      return { ...keep, passed: true, failed_checks: [], replaced_from: from };
    });
  }
  // A target with no quality entry (explicit body) still records the replacement.
  for (const [key, from] of done) {
    const [action, direction, frame] = key.split('/');
    if (!(next.quality || []).some((q) => keyOf(q) === key)) {
      next.quality = [...(next.quality || []), { action, direction, frame: Number(frame), passed: true, failed_checks: [], replaced_from: from }];
    }
  }
  return { png: encodeRGBA(img.width, img.height, px), manifest: next, replaced, skipped };
}

// The default target list: every failed quality entry.
function flaggedTargets(manifest) {
  return (manifest.quality || []).filter((q) => q && q.passed === false)
    .map((q) => ({ action: q.action, direction: q.direction, frame: q.frame }));
}

module.exports = { replaceFrames, flaggedTargets };
