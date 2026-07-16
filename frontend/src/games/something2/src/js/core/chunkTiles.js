import { parseKey, chunkOrigin } from "./worldCoords.js";
import { MAP_TILE_SIZE } from "./constants.js";
import { worldToScreen } from "./iso.js";

// True if a chunk's screen-space bounding box (its 4 world-pixel corners,
// projected) intersects the viewport box centered on the camera. Uses the
// same generous margins as the per-tile cull in RenderSystem.renderChunked.
// Pure; no canvas/DOM access.
export function chunkVisible(cx, cy, chunkSize, camera) {
  const span = chunkSize * MAP_TILE_SIZE;
  const origin = chunkOrigin(cx, cy, chunkSize);
  const corners = [
    worldToScreen(origin.x, origin.y),
    worldToScreen(origin.x + span, origin.y),
    worldToScreen(origin.x, origin.y + span),
    worldToScreen(origin.x + span, origin.y + span),
  ];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  const vpMinX = camera.screenX - camera.width;
  const vpMaxX = camera.screenX + camera.width;
  const vpMinY = camera.screenY - camera.height;
  const vpMaxY = camera.screenY + camera.height;
  return maxX >= vpMinX && minX <= vpMaxX && maxY >= vpMinY && minY <= vpMaxY;
}

// World-pixel tile centers (+ tile name) for every cell of every loaded chunk.
// Pure; consumed by the renderer. grid[lr][lc] is the tile at local row lr, col lc.
// When `camera` is given, whole chunks that are entirely off-screen are
// skipped before their tiles are enumerated (perf: avoids projecting every
// tile of every loaded chunk, most of which are off-screen at chunk_size 64).
// `camera` is optional for back-compat; omit it to enumerate all loaded chunks.
export function chunkTileCells(chunkedMap, camera = null) {
  const T = MAP_TILE_SIZE;
  const N = chunkedMap.chunkSize;
  const cells = [];
  for (const key of chunkedMap.loadedKeys()) {
    const { cx, cy } = parseKey(key);
    if (camera && !chunkVisible(cx, cy, N, camera)) continue;
    const grid = chunkedMap.getChunk(cx, cy);
    if (!grid) continue;
    const origin = chunkOrigin(cx, cy, N);
    for (let lr = 0; lr < grid.length; lr++) {
      const row = grid[lr];
      for (let lc = 0; lc < row.length; lc++) {
        cells.push({
          worldX: origin.x + lc * T + T / 2,
          worldY: origin.y + lr * T + T / 2,
          tile: row[lc],
        });
      }
    }
  }
  return cells;
}
