// frontend/src/games/something2/src/js/systems/wallRenderer.js
// Pure geometry + draw for extruded wall blocks, plus the unified-pass
// comparator and the see-through reveal predicate. Iso diamonds are 2:1;
// worldToScreen returns the tile diamond CENTRE, so faces are built around it.

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
  // Affine: image (sw×sh) -> parallelogram p0->p1 (x), p0->p3 (y).
  const ux = (p1.x - p0.x) / sw, uy = (p1.y - p0.y) / sw;
  const vx = (p3.x - p0.x) / sh, vy = (p3.y - p0.y) / sh;
  ctx.setTransform(ux, uy, vx, vy, p0.x, p0.y);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = shade;
  ctx.fill();
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
      drawTexturedFace(ctx, visual.img, crop, f.left[0], f.left[1], f.left[3], f.left[2], 'rgba(0,0,0,0.28)');
      // right face p0=liftedBottom, p1=liftedRight, p3=groundBottom, p2=groundRight
      drawTexturedFace(ctx, visual.img, crop, f.right[0], f.right[1], f.right[3], f.right[2], 'rgba(0,0,0,0.45)');
    }
    // top diamond via the existing tile cache, lifted by H
    const cv = tileCache.get(visual.cacheKey, visual.img, visual.crop);
    ctx.drawImage(cv, s.x - halfW, (s.y - H) - halfH);
  } else {
    if (H > 0) {
      fillQuad(ctx, f.left, shadeColor(color, -0.28));
      fillQuad(ctx, f.right, shadeColor(color, -0.45));
    }
    fillQuad(ctx, f.top, color);
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
