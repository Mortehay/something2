import { landmarkPulse, landmarkColor } from "./landmarkRenderer.js";
import { MAP_TILE_SIZE } from "../core/constants.js";
import { diamond, terrainBlit } from "./minimapTerrainLayer.js";

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

// Iso screen angle of a world-tile movement vector, for the player facing arrow.
function isoAngle(dx, dy) {
  return Math.atan2((dx + dy) * 0.5, dx - dy);
}

export function drawMinimap(ctx, {
  overview, player, creatures, doorways, villages, view,
  // SOMET-444. The terrain window as a pre-rendered bitmap -- see
  // minimapTerrainLayer.js for why it is cached rather than redrawn. Shaped
  // { canvas, geom, dpr }, or null before the first overview arrives.
  terrainLayer,
  // SOMET-298. World-pixel points from the join frame (Game's snapshot), NOT
  // from the overview payload. The overview is a cached terrain window; a
  // landmark is per-character state (a waypoint is lit or not) that already
  // arrives on `joined`, so sourcing it here keeps one source of truth and
  // leaves overviewCache alone. `phase` is the caller's rAF timestamp -- see
  // landmarkRenderer for why a renderer must never read its own clock.
  landmarks, phase,
}) {
  // 1) Terrain -- one blit of the cached window bitmap.
  //
  // Only the part of the bitmap that lands inside the box is copied. That
  // matters: the bitmap for a 64x64 window is far larger than the box, and
  // handing drawImage the WHOLE source (the 5-argument form) makes it scale
  // the entire quad -- measured SLOWER than the per-cell loop it replaced.
  // The 9-argument form with a clipped source rect is the whole win.
  //
  // Source and destination are both snapped to whole DEVICE pixels so the copy
  // is 1:1 and never resampled; resampling blurs the diamonds and costs more
  // again. The error is under one device pixel, so terrain and markers cannot
  // visibly disagree.
  if (overview && terrainLayer) {
    const blit = terrainBlit(overview, view, terrainLayer);
    if (blit) {
      ctx.drawImage(terrainLayer.canvas, blit.sx, blit.sy, blit.sw, blit.sh, blit.dx, blit.dy, blit.dw, blit.dh);
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
    if (d.toName && view.cellW > 14 && ctx.fillText) {
      ctx.save();
      ctx.font = '9px sans-serif';
      ctx.fillStyle = '#f3e8ff';
      ctx.textAlign = 'center';
      ctx.fillText(d.toName, x, y - 8);
      ctx.restore();
    }
  }

  // 3.5) Landmarks (pulsing diamond): waypoints and portals.
  //
  // Colour and pulse both come from landmarkRenderer, deliberately imported
  // rather than reimplemented -- the ground marker and the minimap marker must
  // be the same colour and beat together, or a player cannot tell they are the
  // same thing. Two copies of "#7dd3fc" would drift the first time one changed.
  //
  // Wrapped in save/restore: the pulse writes globalAlpha, and the player dot
  // is drawn after this. Leaking it would make the PLAYER fade in and out,
  // which reads as a rendering glitch rather than as a landmark.
  if (Array.isArray(landmarks) && landmarks.length) {
    const alpha = landmarkPulse(phase);
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const l of landmarks) {
      if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y)) continue;
      const { x, y } = worldTileToView(l.x / MAP_TILE_SIZE, l.y / MAP_TILE_SIZE, view);
      const color = landmarkColor(l.kind);
      // Same rule as the ground marker: only an unactivated WAYPOINT is hollow.
      // A portal is never "activated" -- walking into one uses it.
      if (l.kind === 'waypoint' && l.activated !== true) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        diamond(ctx, x, y, 5, 5);
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        diamond(ctx, x, y, 5, 5);
        ctx.fill();
      }
      if (l.kind === 'portal' && l.name && view.cellW > 14 && ctx.fillText) {
        ctx.save();
        ctx.font = '9px sans-serif';
        ctx.fillStyle = '#fbcfe8';
        ctx.textAlign = 'center';
        ctx.fillText(l.name, x, y - 8);
        ctx.restore();
      }
    }
    ctx.restore();
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
  if (player && Number.isFinite(player.col) && Number.isFinite(player.row)) {
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
}
