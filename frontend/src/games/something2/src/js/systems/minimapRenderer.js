// Pure Canvas-2D drawing for the in-game minimap. Player-centered iso window:
// the player's (fractional) global tile maps to the box center and everything
// else offsets from it. Diamonds are 2:1 like the in-game world and the world
// browser preview (see mapPreviewRenderer.js). No DOM/React/state.

// Screen position of a global tile (fractional ok) within the minimap box.
// One diamond of width cellW represents `step` world tiles.
export function worldTileToView(col, row, view) {
  const { centerCol, centerRow, step, cellW, boxW, boxH } = view;
  const cellH = cellW / 2;
  const dc = (col - centerCol) / step;
  const dr = (row - centerRow) / step;
  return {
    x: (dc - dr) * cellW / 2 + boxW / 2,
    y: (dc + dr) * cellH / 2 + boxH / 2,
  };
}

function diamond(ctx, x, y, hw, hh) {
  ctx.beginPath();
  ctx.moveTo(x, y - hh);
  ctx.lineTo(x + hw, y);
  ctx.lineTo(x, y + hh);
  ctx.lineTo(x - hw, y);
  ctx.closePath();
}

// Iso screen angle of a world-tile movement vector, for the player facing arrow.
function isoAngle(dx, dy) {
  return Math.atan2((dx + dy) * 0.5, dx - dy);
}

export function drawMinimap(ctx, { overview, tileColors, player, creatures, doorways, villages, view }) {
  const cellW = view.cellW, hw = cellW / 2, hh = cellW / 4;

  // 1) Terrain
  if (overview) {
    for (let r = 0; r < overview.rows; r++) {
      const row = overview.tiles[r];
      if (!row) continue;
      for (let c = 0; c < overview.cols; c++) {
        const name = row[c];
        if (!name) continue;
        const { x, y } = worldTileToView(overview.originCol + c * overview.step, overview.originRow + r * overview.step, view);
        if (x < -cellW || x > view.boxW + cellW || y < -cellW || y > view.boxH + cellW) continue;
        ctx.fillStyle = (tileColors && tileColors[name]) || '#334155';
        diamond(ctx, x, y, hw, hh);
        ctx.fill();
      }
    }
  }

  // 2) Villages (gold square), 3) doorways (magenta diamond)
  for (const v of villages || []) {
    const { x, y } = worldTileToView(v.col, v.row, view);
    ctx.fillStyle = '#fbbf24';
    ctx.fillRect(x - 3, y - 3, 6, 6);
  }
  for (const d of doorways || []) {
    const { x, y } = worldTileToView(d.col, d.row, view);
    ctx.fillStyle = '#c084fc';
    diamond(ctx, x, y, 4, 4);
    ctx.fill();
  }

  // 4) Creatures (colored dots)
  for (const cr of creatures || []) {
    const { x, y } = worldTileToView(cr.col, cr.row, view);
    ctx.fillStyle = cr.color || '#e5e7eb';
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // 5) Player: centered dot + facing triangle
  const { x, y } = worldTileToView(player.col, player.row, view);
  const dir = player.dir || { dx: 0, dy: 1 };
  const ang = isoAngle(dir.dx, dir.dy);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(7, 0);
  ctx.lineTo(-4, -4);
  ctx.lineTo(-4, 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#4a9eff';
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fill();
}
