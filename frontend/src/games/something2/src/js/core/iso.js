import { MAP_TILE_SIZE, ISO_TILE_W } from "./constants.js";

// K scales world pixels to iso screen pixels. A world tile of MAP_TILE_SIZE
// projects to a diamond ISO_TILE_W wide (and ISO_TILE_W/2 tall — 2:1).
export const ISO_K = ISO_TILE_W / (2 * MAP_TILE_SIZE);

export function worldToScreen(wx, wy) {
  return {
    x: (wx - wy) * ISO_K,
    y: (wx + wy) * ISO_K / 2,
  };
}

export function screenToWorld(sx, sy) {
  // Invert the linear system above.
  const a = sx / ISO_K;       // wx - wy
  const b = (2 * sy) / ISO_K; // wx + wy
  return {
    x: (a + b) / 2,
    y: (b - a) / 2,
  };
}

// Painter's-algorithm sort key: larger = nearer the camera = drawn later.
export function depthKey(wx, wy) {
  return wx + wy;
}
