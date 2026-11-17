// frontend/src/games/something2/src/js/systems/wallRenderer.js
// Pure geometry + draw for extruded wall blocks, plus the unified-pass
// comparator and the see-through reveal predicate. Iso diamonds are 2:1;
// worldToScreen returns the tile diamond CENTRE, so faces are built around it.

import { TILE_DIAMOND_PAD } from './tileTexture.js';
import { ISO_K } from '../core/iso.js';

// --- Thin connected walls (SOMET-771) -----------------------------------------
// A built wall draws as a quarter-tile-thick post at the tile centre plus one
// arm per neighbouring wall tile, so a ring reads as a continuous wall instead
// of a row of full-diamond cubes. Render only: the whole tile still blocks.
export const WALL_THICKNESS = 25; // world px; MAP_TILE_SIZE is 100

// Non-overlapping world-space rects relative to the tile centre, ordered
// back-to-front by centre depth (x + y) so painting them in order is correct.
export function thinWallBoxes(nb, T = 100, thick = WALL_THICKNESS) {
  const h = thick / 2, e = T / 2;
  const boxes = [{ x0: -h, y0: -h, x1: h, y1: h }];
  if (nb.n) boxes.push({ x0: -h, y0: -e, x1: h, y1: -h });
  if (nb.w) boxes.push({ x0: -e, y0: -h, x1: -h, y1: h });
  if (nb.e) boxes.push({ x0: h, y0: -h, x1: e, y1: h });
  if (nb.s) boxes.push({ x0: -h, y0: h, x1: h, y1: e });
  const depth = (r) => (r.x0 + r.x1 + r.y0 + r.y1) / 2;
  return boxes.sort((a, b) => depth(a) - depth(b));
}

// Project a tile-relative world rect, extruded by H, to screen quads. `s` is the
// tile centre on screen. Only the camera-facing faces exist: +y (south) and +x (east).
export function projectBox(s, r, H) {
  const pt = (dx, dy, lift) => ({ x: s.x + (dx - dy) * ISO_K, y: s.y + (dx + dy) * ISO_K / 2 - lift });
  return {
    top: [pt(r.x0, r.y0, H), pt(r.x1, r.y0, H), pt(r.x1, r.y1, H), pt(r.x0, r.y1, H)],
    south: [pt(r.x0, r.y1, H), pt(r.x1, r.y1, H), pt(r.x1, r.y1, 0), pt(r.x0, r.y1, 0)],
    east: [pt(r.x1, r.y0, H), pt(r.x1, r.y1, H), pt(r.x1, r.y1, 0), pt(r.x1, r.y0, 0)],
  };
}

// Top diamond lifted by H, and the two camera-facing (south-west / south-east)
// vertical faces extruded straight down by H.
export function wallFaces(s, halfW, halfH, H) {
  const liftedTop = { x: s.x, y: s.y - halfH - H };
  const liftedRight = { x: s.x + halfW, y: s.y - H };
  const liftedBottom = { x: s.x, y: s.y + halfH - H };
  const liftedLeft = { x: s.x - halfW, y: s.y - H };
  const groundRight = { x: s.x + halfW, y: s.y };
  const groundBottom = { x: s.x, y: s.y + halfH };
  const groundLeft = { x: s.x - halfW, y: s.y };
  return {
    top: [liftedTop, liftedRight, liftedBottom, liftedLeft],
    left: [liftedLeft, liftedBottom, groundBottom, groundLeft],
    right: [liftedBottom, liftedRight, groundRight, groundBottom],
  };
}

// Unified draw order: higher place_order always paints later (on top); within
// the same order, back-to-front by iso depth. Default order 0 => pure depth.
export function compareDrawables(a, b) {
  return (a.order - b.order) || (a.depth - b.depth);
}

// A wall "reveals" (fades for) an actor it could be occluding: the actor is
// behind-or-level with the wall (actor.depth <= wall.depth) and within R px of
// the wall tile centre. Walls the actor stands in front of never fade.
export function wallRevealed(wall, actors, R) {
  const r2 = R * R;
  for (const a of actors) {
    if (a.depth > wall.depth) continue;
    const dx = a.x - wall.x, dy = a.y - wall.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

// Map an image (or crop) onto a parallelogram face defined by 3 corners:
// p0 (origin), p1 (image +x edge end), p3 (image +y edge end). Clips to the
// face, draws the texture skewed, then a translucent shade for a depth cue.
function drawTexturedFace(ctx, img, crop, p0, p1, p3, p2, shade) {
  const [sx, sy, sw, sh] = crop || [0, 0, img.width, img.height];
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath();
  ctx.clip();
  // Affine: image (sw×sh) -> parallelogram p0->p1 (x), p0->p3 (y). COMPOSE onto
  // the current (camera) transform via transform() — setTransform() would REPLACE
  // it and drop the camera pan, drawing the texture far off its clipped face
  // (the bug that left the sides showing the flat canvas background).
  const ux = (p1.x - p0.x) / sw, uy = (p1.y - p0.y) / sw;
  const vx = (p3.x - p0.x) / sh, vy = (p3.y - p0.y) / sh;
  ctx.save();
  ctx.transform(ux, uy, vx, vy, p0.x, p0.y);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.restore(); // back to the camera transform; the clip path is still current
  ctx.fillStyle = shade;
  ctx.fill(); // shade the same clipped parallelogram, in camera space
  ctx.restore();
}

function fillQuad(ctx, quad, style) {
  ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y);
  for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
  ctx.closePath();
  ctx.fillStyle = style;
  ctx.fill();
}

// Draw one wall block. `visual` is resolveTileVisual's {img, crop, cacheKey} or
// null (color-only tile). Faces are drawn first, top last (over them).
export function drawWall(ctx, { s, def, visual, H, alpha, halfW, halfH, tileCache }) {
  const f = wallFaces(s, halfW, halfH, H);
  ctx.globalAlpha = alpha;
  const color = (def && def.color) || '#555555';
  if (visual && visual.img) {
    const crop = visual.crop || null;
    if (H > 0) {
      // left face p0=liftedLeft, p1=liftedBottom, p3=groundLeft, p2=groundBottom
      drawTexturedFace(ctx, visual.img, crop, f.left[0], f.left[1], f.left[3], f.left[2], 'rgba(0,0,0,0.12)');
      // right face p0=liftedBottom, p1=liftedRight, p3=groundBottom, p2=groundRight
      drawTexturedFace(ctx, visual.img, crop, f.right[0], f.right[1], f.right[3], f.right[2], 'rgba(0,0,0,0.22)');
    }
    // top diamond via the existing tile cache, lifted by H
    const cv = tileCache.get(visual.cacheKey, visual.img, visual.crop);
    // Same pad shift as the flat-floor blit in RenderSystem: the cached
    // diamond is larger than its tile on every side, so drawing it at the
    // unpadded origin would offset every wall top by TILE_DIAMOND_PAD.
    ctx.drawImage(cv, Math.round(s.x - halfW) - TILE_DIAMOND_PAD,
      Math.round((s.y - H) - halfH) - TILE_DIAMOND_PAD);
  } else {
    if (H > 0) {
      fillQuad(ctx, f.left, shadeColor(color, -0.12));
      fillQuad(ctx, f.right, shadeColor(color, -0.22));
    }
    fillQuad(ctx, f.top, color);
  }
  ctx.globalAlpha = 1;
}

// Natural rock mass (biome terrain) keeps the full-diamond block; every other
// wall tile -- built walls, gates, doorways -- draws thin.
export const BLOCK_WALL_TILES = new Set(['cave_wall']);

// Which orthogonal neighbours of the wall tile centred at (worldX, worldY) are
// themselves wall tiles. getTile(x,y) -> tile name or null (unloaded chunk:
// no arm until it streams in); getDef(name) -> tile def or null.
export function wallNeighbours(getTile, getDef, worldX, worldY, T = 100) {
  const isWall = (x, y) => {
    const t = getTile(x, y);
    const def = t ? getDef(t) : null;
    return !!(def && Number(def.wall_height) > 0);
  };
  return {
    n: isWall(worldX, worldY - T), e: isWall(worldX + T, worldY),
    s: isWall(worldX, worldY + T), w: isWall(worldX - T, worldY),
  };
}

// Render-pass dispatch for one wall drawable {s, def, visual, H, neighbours, tile?}.
export function drawWallDrawable(ctx, d, { halfW, halfH, tileCache, alpha = 1 }) {
  const name = d.tile || (d.def && d.def.name);
  if (d.neighbours && !BLOCK_WALL_TILES.has(name)) {
    drawThinWall(ctx, { s: d.s, def: d.def, visual: d.visual, H: d.H, alpha, neighbours: d.neighbours });
  } else {
    drawWall(ctx, { s: d.s, def: d.def, visual: d.visual, H: d.H, alpha, halfW, halfH, tileCache });
  }
}

// Sub-crop [u0,u1]x[v0,v1] (fractions) of a texture crop, so a 25px face shows a
// quarter of the texture at its natural scale instead of the whole image squeezed.
function subCrop(img, crop, u0, u1, v0 = 0, v1 = 1) {
  const [sx, sy, sw, sh] = crop || [0, 0, img.width, img.height];
  return [sx + sw * u0, sy + sh * v0, sw * (u1 - u0), sh * (v1 - v0)];
}

// Draw one thin connected wall (SOMET-771). Same inputs as drawWall minus the
// diamond sizes/tile cache, plus `neighbours` {n,e,s,w}: which sides carry an arm.
export function drawThinWall(ctx, { s, def, visual, H, alpha, neighbours, T = 100 }) {
  ctx.globalAlpha = alpha;
  const color = (def && def.color) || '#555555';
  const u = (v) => (v + T / 2) / T; // tile-relative coord -> texture fraction
  for (const r of thinWallBoxes(neighbours, T)) {
    const q = projectBox(s, r, H);
    if (visual && visual.img) {
      const { img, crop } = visual;
      if (H > 0) {
        drawTexturedFace(ctx, img, subCrop(img, crop, u(r.x0), u(r.x1)), q.south[0], q.south[1], q.south[3], q.south[2], 'rgba(0,0,0,0.12)');
        drawTexturedFace(ctx, img, subCrop(img, crop, u(r.y0), u(r.y1)), q.east[0], q.east[1], q.east[3], q.east[2], 'rgba(0,0,0,0.22)');
      }
      drawTexturedFace(ctx, img, subCrop(img, crop, u(r.x0), u(r.x1), u(r.y0), u(r.y1)), q.top[0], q.top[1], q.top[3], q.top[2], 'rgba(255,255,255,0.10)');
    } else {
      if (H > 0) {
        fillQuad(ctx, q.south, shadeColor(color, -0.12));
        fillQuad(ctx, q.east, shadeColor(color, -0.22));
      }
      fillQuad(ctx, q.top, shadeColor(color, 0.08));
    }
  }
  ctx.globalAlpha = 1;
}

// Darken a #rrggbb (or #abc shorthand, or #rrggbbaa) hex by `amt` in [-1,0]; falls back to input.
export function shadeColor(hex, amt) {
  // Try 6-digit match first: #rrggbb or rrggbb
  let m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '');
  if (m) {
    const f = (h) => Math.max(0, Math.min(255, Math.round(parseInt(h, 16) * (1 + amt))));
    return `rgb(${f(m[1])}, ${f(m[2])}, ${f(m[3])})`;
  }
  // Try 3-digit shorthand: #abc or abc (expand to #aabbcc)
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex || '');
  if (m) {
    const expand = (c) => c + c;
    const r = expand(m[1]), g = expand(m[2]), b = expand(m[3]);
    const f = (h) => Math.max(0, Math.min(255, Math.round(parseInt(h, 16) * (1 + amt))));
    return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
  }
  // Unparseable: return input unchanged
  return hex;
}
