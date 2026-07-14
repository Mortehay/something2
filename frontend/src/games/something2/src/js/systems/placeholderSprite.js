import { worldToScreen } from "../core/iso.js";

// Screen-space direction each world facing points, in iso projection.
// World deltas per facing (x = east, y = south in world space):
const FACING_WORLD = {
  N:  { x: -1, y: -1 },
  NE: { x:  0, y: -1 },
  E:  { x:  1, y: -1 },
  SE: { x:  1, y:  0 },
  S:  { x:  1, y:  1 },
  SW: { x:  0, y:  1 },
  W:  { x: -1, y:  1 },
  NW: { x: -1, y:  0 },
};

// Convert a facing to a normalized screen-space wedge direction.
export function facingToWedge(facing) {
  const w = FACING_WORLD[facing] || FACING_WORLD.S;
  // Project the direction through the iso transform (origin-relative).
  const s = worldToScreen(w.x, w.y);
  const len = Math.hypot(s.x, s.y) || 1;
  return { dx: s.x / len, dy: s.y / len };
}

// Draw a colored diamond block with a facing wedge. ctx is a 2D context,
// (cx, cy) is the screen center, size is the block half-extent.
export function drawPlaceholder(ctx, cx, cy, size, color, facing) {
  ctx.fillStyle = color || "#7c3aed";
  ctx.beginPath();
  ctx.arc(cx, cy, size, 0, Math.PI * 2);
  ctx.fill();
  const { dx, dy } = facingToWedge(facing || "S");
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + dx * size, cy + dy * size);
  ctx.stroke();
}
