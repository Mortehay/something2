// Isometric minimap renderer for the World Browser preview. Pure drawing +
// fitting math, no DOM/React. Works directly in tile (row, col) space; a tile
// projects to a 2:1 diamond (tileH = tileW/2), matching the in-game iso look.

// Fit the whole rows x cols iso map inside a box, returning the diamond size
// and a centering offset so every diamond lands inside [0,boxW] x [0,boxH].
export function isoFit(rows, cols, boxW, boxH, pad = 8) {
  if (rows <= 0 || cols <= 0) return { tileW: 0, tileH: 0, offsetX: 0, offsetY: 0 };
  const availW = Math.max(1, boxW - 2 * pad);
  const availH = Math.max(1, boxH - 2 * pad);
  // Full iso extent for a given tileW: width = (cols+rows)*tileW/2,
  // height = (cols+rows)*tileW/4. Pick the tileW that fits both.
  const sum = cols + rows;
  const tileW = Math.max(1, Math.min((2 * availW) / sum, (4 * availH) / sum));
  const tileH = tileW / 2;

  // Center the bounding box of tile centers within the box.
  const minX = -(rows - 1) * tileW / 2;
  const maxX = (cols - 1) * tileW / 2;
  const maxY = (cols - 1 + rows - 1) * tileH / 2; // minY = 0
  const contentW = (maxX - minX) + tileW;
  const contentH = maxY + tileH;
  const offsetX = (boxW - contentW) / 2 - (minX - tileW / 2);
  const offsetY = (boxH - contentH) / 2 + tileH / 2;
  return { tileW, tileH, offsetX, offsetY };
}

// Screen position of a tile center for a given fit (+ optional pan offset).
export function tileToScreen(r, c, fit, panX = 0, panY = 0) {
  return {
    x: (c - r) * fit.tileW / 2 + fit.offsetX + panX,
    y: (c + r) * fit.tileH / 2 + fit.offsetY + panY,
  };
}

// Per-tile reveal alpha: the center reveals first, corners last. `band` is the
// fraction of overall progress each tile takes to fade in.
export function revealAlpha(r, c, rows, cols, progress, band = 0.3) {
  if (progress >= 1) return 1;
  if (progress <= 0) return 0;
  const cr = (rows - 1) / 2, cc = (cols - 1) / 2;
  const dist = Math.hypot(r - cr, c - cc);
  const maxDist = Math.hypot(cr, cc) || 1;
  const start = (dist / maxDist) * (1 - band);
  return Math.max(0, Math.min(1, (progress - start) / band));
}

// Draw the terrain diamonds (colored by tileColors[name]) then entity dots.
export function draw(ctx, { tiles, tileColors, entities, fit, revealProgress = 1, panX = 0, panY = 0 }) {
  const rows = tiles.length;
  const cols = rows ? tiles[0].length : 0;
  const hw = fit.tileW / 2, hh = fit.tileH / 2;
  ctx.save();
  for (let r = 0; r < rows; r++) {
    const row = tiles[r];
    if (!row) continue;
    for (let c = 0; c < cols; c++) {
      const name = row[c];
      if (!name) continue;
      const a = revealProgress >= 1 ? 1 : revealAlpha(r, c, rows, cols, revealProgress);
      if (a <= 0) continue;
      const { x, y } = tileToScreen(r, c, fit, panX, panY);
      ctx.globalAlpha = a;
      ctx.fillStyle = (tileColors && tileColors[name]) || '#334155';
      ctx.beginPath();
      ctx.moveTo(x, y - hh);
      ctx.lineTo(x + hw, y);
      ctx.lineTo(x, y + hh);
      ctx.lineTo(x - hw, y);
      ctx.closePath();
      ctx.fill();
    }
  }
  // Object dots, once the terrain is revealed.
  if (entities && entities.length && revealProgress >= 1) {
    ctx.globalAlpha = 0.9;
    const dot = Math.max(1.5, fit.tileW * 0.18);
    for (const e of entities) {
      const r = e.row ?? e.y ?? 0;
      const c = e.col ?? e.x ?? 0;
      const { x, y } = tileToScreen(r, c, fit, panX, panY);
      ctx.fillStyle = e.color || '#0f2e1a';
      ctx.beginPath();
      ctx.arc(x, y, dot, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
