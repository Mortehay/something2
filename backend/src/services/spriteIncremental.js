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

// Cells patched by use-good-frames (a copy of a neighbour, not a drawing).
function patchedKeys(manifest) {
  const s = new Set();
  for (const q of (manifest && manifest.quality) || []) if (q && q.replaced_from) s.add(qKey(q));
  return s;
}

// A row with a missing cell OR a flagged cell is drawn (SOMET-702 I1: "draw
// only new and flagged frames"). In a drawn row the base keeps its good cells;
// its missing, flagged and use-good-frames-patched (M2) cells come from the new
// draw. A row with every cell present and unflagged is kept whole (no box call).
// M3: when the base's idle rows came from the 3D turnaround, a drawn idle row
// takes all its idle cells from the new draw so static turnaround renders are
// not mixed with 2D poses.
// SOMET-708: a flag in a western row the game mirrors (not listed in the
// base's unmirrored) draws nothing -- the game shows the eastern row flipped,
// and use-good-frames would skip the new cells anyway. Missing cells still draw.
function planReuse({ actions, directions, frames, baseManifest }) {
  const have = (baseManifest && baseManifest.frames) || {};
  const flagged = flaggedKeys(baseManifest);
  const asIs = (baseManifest && baseManifest.unmirrored) || {};
  const mirrored = (a, d) => WESTERN_DIRECTIONS.includes(d) && !(Array.isArray(asIs[a]) && asIs[a].includes(d));
  const patched = patchedKeys(baseManifest);
  const turnaroundBase = !!(baseManifest && baseManifest.turnaround3d);
  const keep = new Set();
  const drawRows = [];
  for (const action of actions) {
    for (const direction of directions) {
      let draw = false;
      const good = [];
      const pending = [];
      for (let i = 0; i < frames; i += 1) {
        const k = keyOf(action, direction, i);
        if (!(k in have) || (flagged.has(k) && !mirrored(action, direction))) { draw = true; continue; }
        good.push(k);
        pending.push(k);
      }
      if (!draw) { for (const k of good) keep.add(k); continue; }
      drawRows.push({ action, direction });
      if (turnaroundBase && action === 'idle') continue;
      for (const k of pending) if (!patched.has(k)) keep.add(k);
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

// SOMET-709 ("keep and add"): the base's actions that this run did not ask
// for and that the base has whole for the run's directions and frame count.
// They are copied into the new sheet unchanged and never sent to the box; an
// incomplete one is left out (drawing it is a separate request).
function carriedActions({ actions, directions, frames, baseManifest }) {
  const have = (baseManifest && baseManifest.frames) || {};
  const baseActions = Array.isArray(baseManifest && baseManifest.actions) ? baseManifest.actions : [];
  const out = [];
  for (const a of baseActions) {
    if (actions.includes(a) || out.includes(a)) continue;
    let whole = true;
    for (const d of directions) for (let i = 0; i < frames; i += 1) if (!(keyOf(a, d, i) in have)) whole = false;
    if (whole) out.push(a);
  }
  return out;
}

const mergeError = (msg) => Object.assign(new Error(msg), { code: 'SPRITE_MERGE' });

function mergeSheets({ actions, directions, frames, realWestern = false, base, drawn, keep }) {
  const useBase = keep;
  const bm = base.manifest;
  const cell = bm.cell || (drawn && drawn.manifest.cell);
  if (!Array.isArray(cell)) throw mergeError('the base manifest has no cell size');
  const dc = drawn && drawn.manifest.cell;
  if (dc && (dc[0] !== cell[0] || dc[1] !== cell[1])) throw mergeError(`the drawn cell ${dc.join('x')} differs from the base cell ${cell.join('x')}`);
  const [cw, ch] = cell;
  const baseImg = decodeRGBA(base.png);
  if (!baseImg) throw mergeError('the base sheet is not a readable RGBA PNG');
  const drawnImg = drawn ? decodeRGBA(drawn.png) : null;
  if (drawn && !drawnImg) throw mergeError('the drawn sheet is not a readable RGBA PNG');

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
        const fromBase = useBase.has(k);
        const src = fromBase ? { m: bm, img: baseImg, q: baseQ } : { m: drawn && drawn.manifest, img: drawnImg, q: drawnQ };
        const rect = src.m && src.m.frames && src.m.frames[k];
        if (!rect) throw mergeError(`frame ${k} is in neither the base nor the drawn sheet`);
        const [sx, sy, sw, sh] = rect;
        if (sx + sw > src.img.width || sy + sh > src.img.height) throw mergeError(`frame ${k} is outside its sheet`);
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
  // Unmirrored rows: a row taken whole from the base keeps the base's word
  // (a 3D turnaround or a real-western draw there); a row with any new cell
  // follows the drawn manifest's own word (the box's mirrored_from, see
  // buildBoxSheetManifest); realWestern no longer decides it.
  const fullyFromBase = (a, d) => {
    for (let i = 0; i < frames; i += 1) if (!useBase.has(keyOf(a, d, i))) return false;
    return true;
  };
  const baseUnmirrored = bm.unmirrored || {};
  const du = (drawn && drawn.manifest.unmirrored) || {};
  const drawnUnmirrored = (a, d) => WESTERN_DIRECTIONS.includes(d) && Array.isArray(du[a]) && du[a].includes(d);
  const unmirrored = {};
  for (const a of actions) {
    const asIs = SPRITE_ALL_DIRECTIONS.filter((d) => directions.includes(d) && (fullyFromBase(a, d)
      ? Array.isArray(baseUnmirrored[a]) && baseUnmirrored[a].includes(d)
      : drawnUnmirrored(a, d)));
    if (asIs.length) unmirrored[a] = asIs;
  }
  if (Object.keys(unmirrored).length) manifest.unmirrored = unmirrored;
  // The turnaround marker stays only while every idle row is the base's own.
  if (bm.turnaround3d && actions.includes('idle') && directions.every((d) => fullyFromBase('idle', d))) {
    manifest.turnaround3d = bm.turnaround3d;
  }
  if (hasQuality) manifest.quality = quality;
  return { png: encodeRGBA(W, H, px), manifest };
}

module.exports = { planReuse, carriedActions, mergeSheets };
