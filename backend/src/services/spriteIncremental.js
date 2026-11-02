const { decodeRGBA } = require('./pngAlpha.js');
const { encodeRGBA } = require('./pngTrim.js');
const { SPRITE_ALL_DIRECTIONS, WESTERN_DIRECTIONS } = require('./spriteBatchOptions.js');

// SOMET-702. Pure planner + merger for incremental sprite re-runs: decide which
// cells of an earlier sheet can be kept, which rows still need drawing, and
// stitch the kept cells and a newly drawn partial sheet into one sheet.

const keyOf = (a, d, i) => `${a}/${d}/${i}`;
const qKey = (q) => keyOf(q.action, q.direction, q.frame);

function flaggedKeys(manifest) {
  const s = new Set();
  for (const q of (manifest && manifest.quality) || []) if (q && q.passed === false) s.add(qKey(q));
  return s;
}

function planReuse({ actions, directions, frames, baseManifest }) {
  const have = (baseManifest && baseManifest.frames) || {};
  const flagged = flaggedKeys(baseManifest);
  const keep = new Set();
  const drawRows = [];
  for (const action of actions) {
    for (const direction of directions) {
      let missing = false;
      for (let i = 0; i < frames; i += 1) {
        const k = keyOf(action, direction, i);
        if (!(k in have)) missing = true;
        else if (!flagged.has(k)) keep.add(k);
      }
      if (missing) drawRows.push({ action, direction });
    }
  }
  let jobSpec = null;
  if (drawRows.length) {
    const as = new Set(drawRows.map((r) => r.action));
    const ds = new Set(drawRows.map((r) => r.direction));
    jobSpec = {
      actions: actions.filter((a) => as.has(a)),
      directions: SPRITE_ALL_DIRECTIONS.filter((d) => ds.has(d)),
    };
  }
  return { keep, drawRows, jobSpec, total: actions.length * directions.length * frames };
}

function mergeSheets({ actions, directions, frames, realWestern = false, base, drawn, keep }) {
  const bm = base.manifest;
  const cell = bm.cell || (drawn && drawn.manifest.cell);
  if (!Array.isArray(cell)) throw new Error('the base manifest has no cell size');
  const [cw, ch] = cell;
  const baseImg = decodeRGBA(base.png);
  if (!baseImg) throw new Error('the base sheet is not a readable RGBA PNG');
  const drawnImg = drawn ? decodeRGBA(drawn.png) : null;
  if (drawn && !drawnImg) throw new Error('the drawn sheet is not a readable RGBA PNG');

  const nRows = actions.length * directions.length;
  const W = cw * frames;
  const H = ch * nRows;
  const px = Buffer.alloc(W * H * 4);
  const rows = [];
  const outFrames = {};
  const quality = [];
  const baseQ = new Map(((bm.quality) || []).filter(Boolean).map((q) => [qKey(q), q]));
  const drawnQ = new Map((((drawn && drawn.manifest.quality)) || []).filter(Boolean).map((q) => [qKey(q), q]));
  const hasQuality = Array.isArray(bm.quality) || !!(drawn && Array.isArray(drawn.manifest.quality));

  let r = 0;
  for (const action of actions) {
    for (const direction of directions) {
      rows.push({ row: r, action, direction, frames });
      for (let i = 0; i < frames; i += 1) {
        const k = keyOf(action, direction, i);
        const fromBase = keep.has(k);
        const src = fromBase ? { m: bm, img: baseImg, q: baseQ } : { m: drawn && drawn.manifest, img: drawnImg, q: drawnQ };
        const rect = src.m && src.m.frames && src.m.frames[k];
        if (!rect) throw new Error(`frame ${k} is in neither the base nor the drawn sheet`);
        const [sx, sy, sw, sh] = rect;
        if (sx + sw > src.img.width || sy + sh > src.img.height) throw new Error(`frame ${k} is outside its sheet`);
        const w = Math.min(sw, cw);
        const h = Math.min(sh, ch);
        for (let y = 0; y < h; y += 1) {
          src.img.px.copy(px, ((r * ch + y) * W + i * cw) * 4, ((sy + y) * src.img.width + sx) * 4, ((sy + y) * src.img.width + sx + w) * 4);
        }
        outFrames[k] = [i * cw, r * ch, cw, ch];
        const entry = src.q.get(k);
        if (entry) quality.push(entry);
      }
      r += 1;
    }
  }

  const manifest = {
    version: 1, sheet: 'sheet.png', concept: bm.concept || 'concept.png',
    engine: drawn ? drawn.manifest.engine : bm.engine,
    box_job_id: drawn ? drawn.manifest.box_job_id : bm.box_job_id,
    cell: [cw, ch], actions: [...actions], frames_per_action: frames, rows, frames: outFrames,
  };
  const western = realWestern === true
    ? SPRITE_ALL_DIRECTIONS.filter((d) => WESTERN_DIRECTIONS.includes(d) && directions.includes(d))
    : [];
  if (western.length) manifest.unmirrored = Object.fromEntries(actions.map((a) => [a, western]));
  if (hasQuality) manifest.quality = quality;
  return { png: encodeRGBA(W, H, px), manifest };
}

module.exports = { planReuse, mergeSheets };
