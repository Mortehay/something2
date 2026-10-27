// SOMET-605 (spec §4.4): "screen radius = half the viewport diagonal, in
// world units". The view is isometric, so a screen length is not a world
// length: each canvas corner is projected back to the world and the farthest
// one wins. Pure; Game.update calls it every frame with the canvas size, so
// a future zoom or resizable backing store only has to change what it passes.
import { screenToWorld } from '../core/iso.js';

export function screenRadiusWorld(viewW, viewH) {
  if (!(viewW > 0) || !(viewH > 0)) return 0;
  let r = 0;
  for (const sx of [-viewW / 2, viewW / 2]) {
    for (const sy of [-viewH / 2, viewH / 2]) {
      const w = screenToWorld(sx, sy);
      r = Math.max(r, Math.hypot(w.x, w.y));
    }
  }
  return r;
}
