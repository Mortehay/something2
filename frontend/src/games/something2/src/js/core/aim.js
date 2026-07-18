import { screenToWorld } from "./iso.js";
import { GAME_WIDTH, GAME_HEIGHT } from "./constants.js";

// Convert a canvas pixel (0..GAME_WIDTH, 0..GAME_HEIGHT) to a world position,
// inverting Camera.apply's translation and the iso projection.
export function cursorToWorld(canvasX, canvasY, camera) {
  const sx = canvasX - GAME_WIDTH / 2 + camera.screenX;
  const sy = canvasY - GAME_HEIGHT / 2 + camera.screenY;
  return screenToWorld(sx, sy);
}

// Unit aim vector in world space from the player center (pcx,pcy) to the cursor.
// Returns {nx:0, ny:0} when the cursor is exactly on the center.
export function aimVector(canvasX, canvasY, camera, pcx, pcy) {
  const w = cursorToWorld(canvasX, canvasY, camera);
  const dx = w.x - pcx, dy = w.y - pcy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { nx: 0, ny: 0 };
  return { nx: dx / len, ny: dy / len };
}
