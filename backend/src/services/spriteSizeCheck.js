const { decodeRGBA } = require('./pngAlpha.js');

// SOMET-697. The GPU box sometimes draws a frame as a close-up (head to knees)
// and then shrinks it into the cell, so the figure looks bigger and cut off.
// Measured on a real idle sheet: frame1/frame0 opaque area was 1.00-1.09 for
// full-body rows and 1.18-1.46 for close-ups. 1.15 separates them.
//
// SOMET-703. The first version compared every frame to the row's SMALLEST
// frame. Measured on a real sheet, a frame cut off inside the box image (area
// 702 in a row with median ~928) was the smallest, so it became the yardstick:
// every good frame was flagged and the bad one never was. The reference is now
// the row MEDIAN of the non-zero areas, and a frame is flagged when it is too
// big (> SPRITE_SIZE_JUMP_RATIO, default 1.15) or too small (< 
// SPRITE_SIZE_SHRINK_RATIO, default 0.85). A 2-frame row has no meaningful
// median (it is the mean, so +30% reads as only +13%): it uses the smaller
// frame as the reference and can only flag the larger one.
//
// SOMET-704. The box also slices side views flat: the figure's back (or face)
// ends in a straight vertical line from head to waist. Measured on Warrior:2,
// the longest run of scanlines whose silhouette x stays within 1 px was 19-26
// on the sliced side of every e/w frame and at most 16 (a hanging arm) on the
// other rows. A frame is flagged when such a run reaches
// SPRITE_CUT_EDGE_FRACTION (default 0.31) of the cell height -- 20 px for a
// 64 px cell. A run lying on the cell border is ignored: that is a filled cell
// or an edge crop, not a slice. The same measurements put ne/1 at +14% (a
// close-up) and a good ne/3 at +12.4%, so the grow limit default went from
// 1.15 to 1.13. Both checks share
// one check name, so a frame carries at most one flag with both reasons.
const ALPHA_MIN = 32;
const CHECK = 'size_jump';
const ratioLimit = () => {
  const v = parseFloat(process.env.SPRITE_SIZE_JUMP_RATIO);
  return Number.isFinite(v) && v > 1 ? v : 1.13;
};
const shrinkLimit = () => {
  const v = parseFloat(process.env.SPRITE_SIZE_SHRINK_RATIO);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.85;
};

const cutFraction = () => {
  const v = parseFloat(process.env.SPRITE_CUT_EDGE_FRACTION);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.31;
};

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

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

// Longest run of consecutive scanlines whose edge x stays within 1 px, skipping
// runs on the cell border. edges[y] is -1 for an empty scanline.
function straightRun(edges, border) {
  let best = 0;
  for (let i = 0; i < edges.length; i += 1) {
    if (edges[i] < 0 || edges[i] === border) continue;
    let lo = edges[i], hi = edges[i], j = i;
    while (j < edges.length && edges[j] >= 0 && edges[j] !== border
      && Math.max(hi, edges[j]) - Math.min(lo, edges[j]) <= 1) {
      lo = Math.min(lo, edges[j]); hi = Math.max(hi, edges[j]); j += 1;
    }
    best = Math.max(best, j - i);
  }
  return best;
}

// 'left' or 'right' when that side of the figure is a long straight line.
function cutSide(img, [x, y, w, h]) {
  if (x < 0 || y < 0 || x + w > img.width || y + h > img.height) return null;
  const left = [], right = [];
  for (let yy = 0; yy < h; yy += 1) {
    let l = -1, r = -1;
    for (let xx = 0; xx < w; xx += 1) {
      if (img.px[((y + yy) * img.width + x + xx) * 4 + 3] > ALPHA_MIN) { if (l < 0) l = xx; r = xx; }
    }
    left.push(l); right.push(r);
  }
  const need = Math.ceil(h * cutFraction());
  const l = straightRun(left, 0), r = straightRun(right, w - 1);
  if (l < need && r < need) return null;
  return l >= r ? { side: 'left', rows: l } : { side: 'right', rows: r };
}

// Frames of a row whose figure is much bigger or smaller than the row's median,
// or sliced flat down one side.
function sizeJumpFlags(sheetPng, manifest) {
  const img = decodeRGBA(sheetPng);
  if (!img || !manifest || !Array.isArray(manifest.rows) || !manifest.frames) return [];
  const grow = ratioLimit();
  const shrink = shrinkLimit();
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
    const two = nonZero.length === 2;
    const ref = two ? Math.min(...nonZero) : median(nonZero);
    const name = `${row.action}/${row.direction}`;
    areas.forEach((a, i) => {
      if (!(a > 0)) return;
      const ratio = a / ref;
      let how = null;
      if (ratio > grow) how = `+${Math.round((ratio - 1) * 100)}% vs the ${two ? 'smallest' : 'median'} frame of ${name} (likely a close-up)`;
      else if (!two && ratio < shrink) how = `-${Math.round((1 - ratio) * 100)}% vs the median frame of ${name} (likely cut off)`;
      const cut = cutSide(img, manifest.frames[`${row.action}/${row.direction}/${i}`]);
      const reasons = [];
      if (how) reasons.push(`size jump: figure area ${how}`);
      if (cut) reasons.push(`cut edge: the ${cut.side} side of the figure is a straight vertical line for ${cut.rows} px (likely sliced by the box)`);
      if (!reasons.length) return;
      flags.push({
        action: row.action,
        direction: row.direction,
        frame: i,
        passed: false,
        source: 'something2',
        check: CHECK,
        failed_checks: [CHECK],
        reason: reasons.join('; '),
      });
    });
  }
  return flags;
}

const keyOf = (q) => `${q.action}/${q.direction}/${q.frame}`;
const hasJump = (q) => q.check === CHECK || (Array.isArray(q.failed_checks) && q.failed_checks.includes(CHECK));

// Undo this check's marks on an entry (a previous run that no longer flags).
// Returns null when the entry existed only because of this check.
function clearJump(q) {
  if (!hasJump(q)) return q;
  const e = { ...q, failed_checks: (q.failed_checks || []).filter((c) => c !== CHECK) };
  delete e.size_jump_reason;
  if (e.check === CHECK) { delete e.check; delete e.reason; delete e.source; }
  if (e.passed === false && e.failed_checks.length === 0) {
    if (!('attempts' in e)) return null;      // our own entry, not the box's
    e.passed = true;                          // the box passed it
  }
  return e;
}

// Merge new flags INTO the box's per-frame entries (the box emits one per
// frame, passed:true). Idempotent: earlier size_jump marks are cleared first,
// then re-applied. A frame the box already failed keeps its own reason; ours
// goes in size_jump_reason. Never mutates its inputs.
function mergeQuality(existing, flags) {
  const out = [];
  const byKey = new Map();
  for (const q of Array.isArray(existing) ? existing : []) {
    const e = q && typeof q === 'object' ? clearJump(q) : q;
    if (!e) continue;
    out.push(e);
    if (e && typeof e === 'object') byKey.set(keyOf(e), out.length - 1);
  }
  for (const f of flags) {
    const i = byKey.get(keyOf(f));
    if (i === undefined) { out.push(f); continue; }
    const e = { ...out[i], failed_checks: [...(out[i].failed_checks || []), CHECK] };
    if (e.passed !== false) {
      Object.assign(e, { passed: false, check: CHECK, reason: f.reason, source: f.source });
    } else {
      e.size_jump_reason = f.reason;
    }
    out[i] = e;
  }
  return out;
}

// Never throws: on any error the manifest comes back unchanged.
function withSizeJumpFlags(sheetPng, manifest, log = console.error) {
  try {
    const flags = sizeJumpFlags(sheetPng, manifest);
    const had = Array.isArray(manifest.quality) && manifest.quality.some((q) => q && hasJump(q));
    if (!flags.length && !had) return manifest;
    return { ...manifest, quality: mergeQuality(manifest.quality, flags) };
  } catch (err) {
    log(`sprite size check failed: ${err.message}`);
    return manifest;
  }
}

module.exports = { sizeJumpFlags, mergeQuality, withSizeJumpFlags };
