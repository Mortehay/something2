// Turns the GPU box's atlas for one job into our sheet.json. Pure: no I/O.
// The box atlas has no per-frame map. Frame (row r, column c) sits at
// [c*cell.w, r*cell.h, cell.w, cell.h]; each row holds `frames_per_action`
// frames and rows are action-major. Every rect is derived from the atlas and
// checked against the PNG so the manifest can never disagree with the image.
const { pngSize } = require('./spriteSheet');
const { SPRITE_ALL_DIRECTIONS, WESTERN_DIRECTIONS } = require('./spriteBatchOptions');

const fail = (error) => ({ ok: false, error });

function buildBoxSheetManifest({ atlas, sheetPng, actions, directions, frames, engine, boxJobId, kind, realWestern = false }) {
  const size = pngSize(sheetPng);
  if (!size) return fail('the sheet is not a readable PNG');
  const cell = atlas && atlas.cell;
  const grid = atlas && atlas.grid;
  if (!cell || !grid || !Array.isArray(atlas.rows)) return fail('the atlas is missing cell, grid or rows');
  if (!(cell.w > 0) || !(cell.h > 0)) return fail('the atlas cell size is invalid');
  if (atlas.rows.length !== grid.rows) {
    return fail(`the atlas lists ${atlas.rows.length} rows but its grid has ${grid.rows}`);
  }
  if (atlas.frames_per_action !== frames) {
    return fail(`the atlas has ${atlas.frames_per_action} frames per action, expected ${frames}`);
  }
  if (frames > grid.columns) return fail(`${frames} frames do not fit in ${grid.columns} atlas columns`);

  const byPair = new Map();
  for (const r of atlas.rows) {
    const k = `${r.action}/${r.direction}`;
    if (byPair.has(k)) return fail(`the atlas has ${k} more than once`);
    byPair.set(k, r.row);
  }

  const rows = [];
  const out = {};
  for (const action of actions) {
    for (const direction of directions) {
      const row = byPair.get(`${action}/${direction}`);
      if (row === undefined) return fail(`the atlas has no row for ${action}/${direction}`);
      rows.push({ row, action, direction, frames });
      for (let i = 0; i < frames; i += 1) {
        const key = `${action}/${direction}/${i}`;
        const rect = [i * cell.w, row * cell.h, cell.w, cell.h];
        if (rect[0] + rect[2] > size.width || rect[1] + rect[3] > size.height) {
          return fail(`frame ${key} at [${rect.join(',')}] is outside the ${size.width}x${size.height} sheet`);
        }
        out[key] = rect;
      }
    }
  }

  const manifest = {
    version: 1, sheet: 'sheet.png', concept: 'concept.png', engine, box_job_id: boxJobId,
    cell: [cell.w, cell.h], actions, frames_per_action: frames, rows, frames: out,
  };
  // HQ lane (SOMET-712): which engine the box says drew the sheet. `engine`
  // above is our display label; the box's own echo goes here. No echo (every
  // box before the HQ lane) means the standard diffusers lane.
  const echo = atlas.engine && typeof atlas.engine === 'object' ? atlas.engine : null;
  manifest.box_engine = (echo && typeof echo.name === 'string' && echo.name) || 'diffusers';
  if (echo) manifest.box_engine_info = echo;

  // The box builds w/nw/sw by flipping e/ne/se (MIRROR_WEST) and says so per
  // atlas row (`mirrored_from`, `handedness: "swapped"`). A western row is
  // unmirrored only when its atlas row exists, the atlas carries mirroring
  // info at all, and this row has no mirrored_from. `realWestern` is accepted
  // for old callers but no longer decides anything (the box has no such field).
  const hasInfo = atlas.rows.some((r) => r && (r.mirrored_from || r.handedness));
  const western = hasInfo
    ? SPRITE_ALL_DIRECTIONS.filter((d) => WESTERN_DIRECTIONS.includes(d) && directions.includes(d))
    : [];
  const unmirroredFor = (action) => western.filter((d) => {
    const row = atlas.rows.find((r) => r.action === action && r.direction === d);
    return row && !row.mirrored_from;
  });
  const perAction = {};
  for (const a of actions) {
    const list = unmirroredFor(a);
    if (list.length) perAction[a] = list;
  }
  if (Object.keys(perAction).length) manifest.unmirrored = perAction;

  if (Array.isArray(atlas.quality)) {
    manifest.quality = atlas.quality.filter((q) => q && `${q.action}/${q.direction}/${q.frame}` in out);
  }

  if (kind === 'object') {
    const loop = rows.find((r) => r.action === 'sway') || rows.find((r) => r.action === 'idle') || rows[0];
    const bare = {};
    for (let i = 0; i < frames; i += 1) bare[String(i)] = out[`${loop.action}/${loop.direction}/${i}`];
    manifest.frames = { ...bare, ...out };
  }
  return { ok: true, manifest };
}

function staticFrameFor(manifest) {
  const keys = Object.keys(manifest.frames);
  return keys.includes('idle/s/0') ? 'idle/s/0' : keys[0];
}

module.exports = { buildBoxSheetManifest, staticFrameFor };
