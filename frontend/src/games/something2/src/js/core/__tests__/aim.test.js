import { describe, it, expect } from 'vitest';
import { cursorToWorld, aimVector } from '../aim.js';
import { worldToScreen } from '../iso.js';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.js';

// Build a camera centered on a known world point, and the canvas pixel that a
// second world point projects to, then assert the inverse recovers it.
function cameraAt(wx, wy) {
  const s = worldToScreen(wx, wy);
  return { screenX: s.x, screenY: s.y, width: GAME_WIDTH, height: GAME_HEIGHT };
}
function canvasPixelOf(wx, wy, camera) {
  const s = worldToScreen(wx, wy);
  return { cx: s.x - camera.screenX + GAME_WIDTH / 2, cy: s.y - camera.screenY + GAME_HEIGHT / 2 };
}

it('cursorToWorld inverts the camera + iso projection', () => {
  const camera = cameraAt(1000, 1000);
  const target = { x: 1300, y: 900 };
  const { cx, cy } = canvasPixelOf(target.x, target.y, camera);
  const w = cursorToWorld(cx, cy, camera);
  expect(w.x).toBeCloseTo(target.x, 3);
  expect(w.y).toBeCloseTo(target.y, 3);
});

it('aimVector returns a unit vector pointing from player center to cursor', () => {
  const camera = cameraAt(1000, 1000);
  const pcx = 1000, pcy = 1000;
  const target = { x: 1200, y: 1000 }; // due +x in world space
  const { cx, cy } = canvasPixelOf(target.x, target.y, camera);
  const { nx, ny } = aimVector(cx, cy, camera, pcx, pcy);
  expect(Math.hypot(nx, ny)).toBeCloseTo(1, 6);
  expect(nx).toBeCloseTo(1, 6);
  expect(ny).toBeCloseTo(0, 6);
});

it('aimVector returns {0,0} when the cursor is on the player center', () => {
  const camera = cameraAt(1000, 1000);
  const { cx, cy } = canvasPixelOf(1000, 1000, camera);
  expect(aimVector(cx, cy, camera, 1000, 1000)).toEqual({ nx: 0, ny: 0 });
});
