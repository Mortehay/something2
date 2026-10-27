// The box's 3D turnaround (POST /api/turnaround3d) pasted into a 2D sheet.
//
// The 2D sheet builder draws a direction from a prompt, so its front quarters
// collapse onto the front view and its western rows are flipped eastern rows
// (SOMET-659). The turnaround renders the subject from eight camera positions,
// so its directions are structurally right -- but it is STATIC: one cell per
// direction, no action frames (the box's rigging gate failed). So it can only
// replace a standing pose: every frame of each `idle/<dir>` row becomes that
// direction's turnaround cell. Other actions keep the 2D frames.
//
// The manifest gains `unmirrored.idle` (the replaced directions), which tells
// the renderer (sheetActions.rowFor) to draw those western rows as themselves
// instead of mirroring the eastern ones.
//
// [ASSUMED] turnaround atlas shape: the same as a sheet atlas -- {cell:{w,h},
// rows:[{row, direction, ...}]}, the direction's cell at column 0 of its row.
// No turnaround had ever finished on the box when this was written (its mesh
// worker was not consuming jobs), so anything else is refused with a reason
// and the 2D sheet is kept unchanged.
const { decodeRGBA } = require('./pngAlpha.js');
const { encodeRGBA } = require('./pngTrim.js');

const fail = (error) => ({ ok: false, error });

function applyTurnaround({ sheetPng, manifest, turnaroundPng, turnaroundAtlas }) {
  const atlas = turnaroundAtlas || {};
  const cell = atlas.cell;
  if (!cell || !(cell.w > 0) || !(cell.h > 0) || !Array.isArray(atlas.rows)) {
    return fail('the turnaround atlas is missing cell or rows');
  }
  const [cw, ch] = manifest.cell || [];
  if (cell.w !== cw || cell.h !== ch) {
    return fail(`the turnaround cell is ${cell.w}x${cell.h}, the sheet's is ${cw}x${ch}`);
  }
  const sheet = decodeRGBA(sheetPng);
  if (!sheet) return fail('the sheet is not an 8-bit RGBA PNG');
  const turn = decodeRGBA(turnaroundPng);
  if (!turn) return fail('the turnaround is not an 8-bit RGBA PNG');

  const turnRow = new Map();
  for (const r of atlas.rows) {
    if (r && typeof r.direction === 'string' && Number.isInteger(r.row)) turnRow.set(r.direction, r.row);
  }

  const replaced = [];
  for (const r of manifest.rows || []) {
    if (r.action !== 'idle' || !turnRow.has(r.direction)) continue;
    const sy = turnRow.get(r.direction) * ch;
    if (sy + ch > turn.height || cw > turn.width) {
      return fail(`turnaround row ${r.direction} is outside the ${turn.width}x${turn.height} image`);
    }
    for (let i = 0; i < r.frames; i += 1) {
      const rect = manifest.frames[`idle/${r.direction}/${i}`];
      if (!rect) continue;
      const [dx, dy] = rect;
      for (let y = 0; y < ch; y += 1) {
        const src = ((sy + y) * turn.width) * 4;
        const dst = ((dy + y) * sheet.width + dx) * 4;
        turn.px.copy(sheet.px, dst, src, src + cw * 4);
      }
    }
    replaced.push(r.direction);
  }
  if (replaced.length === 0) return fail('the turnaround has no direction the sheet\'s idle rows use');

  return {
    ok: true,
    png: encodeRGBA(sheet.width, sheet.height, sheet.px),
    manifest: { ...manifest, unmirrored: { ...(manifest.unmirrored || {}), idle: replaced } },
    directions: replaced,
  };
}

module.exports = { applyTurnaround };
