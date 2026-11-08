import { parseKey, chunkOrigin } from "./worldCoords.js";
import { MAP_TILE_SIZE, ISO_TILE_W, ISO_TILE_H } from "./constants.js";
import { worldToScreen, screenToWorld } from "./iso.js";

// SOMET-766. The box (centre + HALF-extents, the shape chunkVisible,
// visibleTileRange and the renderer's per-tile check all read) that holds every
// tile centre whose drawing can reach the screen. `camera.width/height` are the
// FULL viewport; reading them as half-extents, as the renderer once did, kept
// ~4x the visible area. Margin: one iso diamond (plus 2px for the camera's
// floor() and the tile pad) on every side, and below the screen also the
// tallest wall, because a wall rises up from a base that can sit off-screen.
export function tileCullBox(camera, maxWallH = 0) {
  const halfW = camera.width / 2 + ISO_TILE_W / 2 + 2;
  const top = camera.height / 2 + ISO_TILE_H / 2 + 2;
  const wall = maxWallH > 0 ? maxWallH : 0;
  return { screenX: camera.screenX, screenY: camera.screenY + wall / 2, width: halfW, height: top + wall / 2 };
}

// Tallest wall_height in a tile set (array of defs, or a name-keyed map); 0 if none.
export function maxWallHeight(mapTiles) {
  let max = 0;
  if (!mapTiles) return max;
  for (const t of Array.isArray(mapTiles) ? mapTiles : Object.values(mapTiles)) {
    const h = t && Number(t.wall_height);
    if (h > max) max = h;
  }
  return max;
}

// True if a chunk's screen-space bounding box (its 4 world-pixel corners,
// projected) intersects the box +/-camera.width/height around the camera
// point. The renderer passes tileCullBox(), whose width/height are half-extents.
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

// Local tile row/col bounds (inclusive) within ONE chunk whose tile CENTERS
// can project inside the camera's viewport margin — the exact same bound the
// per-tile cull in RenderSystem.renderChunked applies after projecting every
// cell (relX/relY vs. +/-camera.width/height). Computed directly from the
// camera instead of enumerating (and projecting) every cell first, since a
// chunk's on-screen extent is usually a small fraction of a full chunk
// (chunk_size is typically 64 -> 4096 tiles/chunk).
//
// The viewport rectangle's PREIMAGE under the iso transform is a rotated
// rectangle (a parallelogram, since worldToScreen/screenToWorld is a 45°
// rotation + non-uniform scale, not axis-aligned), not an axis-aligned box.
// This bounds it with the AABB of its four projected corners, which is
// always a SUPERSET of the true preimage (a convex shape's vertices define
// its AABB) — so this range can only ever include MORE tiles than the exact
// per-tile check downstream keeps, never fewer. It is a cheap pre-filter on
// the candidate set, not a replacement for the exact relX/relY check, which
// still runs on every cell this yields and is what actually decides what's
// drawn.
export function visibleTileRange(cx, cy, chunkSize, camera) {
  const T = MAP_TILE_SIZE;
  const origin = chunkOrigin(cx, cy, chunkSize);
  const vpMinX = camera.screenX - camera.width;
  const vpMaxX = camera.screenX + camera.width;
  const vpMinY = camera.screenY - camera.height;
  const vpMaxY = camera.screenY + camera.height;
  const corners = [
    screenToWorld(vpMinX, vpMinY),
    screenToWorld(vpMaxX, vpMinY),
    screenToWorld(vpMinX, vpMaxY),
    screenToWorld(vpMaxX, vpMaxY),
  ];
  let worldMinX = Infinity, worldMaxX = -Infinity, worldMinY = Infinity, worldMaxY = -Infinity;
  for (const c of corners) {
    if (c.x < worldMinX) worldMinX = c.x;
    if (c.x > worldMaxX) worldMaxX = c.x;
    if (c.y < worldMinY) worldMinY = c.y;
    if (c.y > worldMaxY) worldMaxY = c.y;
  }
  // Tile-center world coords for local (lr,lc) are origin + lc*T + T/2 (x),
  // origin + lr*T + T/2 (y) — see chunkTileCells below. Pad by one whole tile
  // on every side: floor/ceil rounding plus that T/2 center offset means the
  // tightest exact bound could otherwise clip a tile whose center lands just
  // inside the margin. Padding costs a few extra candidate cells (still
  // discarded by the exact check); under-padding risks silently dropping a
  // visible tile, which is the one outcome worse than the over-draw this is
  // fixing.
  const lcStart = Math.max(0, Math.min(Math.floor((worldMinX - origin.x) / T) - 1, chunkSize - 1));
  const lcEnd = Math.max(0, Math.min(Math.ceil((worldMaxX - origin.x) / T) + 1, chunkSize - 1));
  const lrStart = Math.max(0, Math.min(Math.floor((worldMinY - origin.y) / T) - 1, chunkSize - 1));
  const lrEnd = Math.max(0, Math.min(Math.ceil((worldMaxY - origin.y) / T) + 1, chunkSize - 1));
  return { lrStart, lrEnd, lcStart, lcEnd };
}

// World-pixel tile centers (+ tile name) for every cell of every loaded chunk.
// Pure; consumed by the renderer. grid[lr][lc] is the tile at local row lr, col lc.
// When `camera` is given, whole chunks that are entirely off-screen are
// skipped before their tiles are enumerated, AND only the local row/col range
// visibleTileRange computes for the surviving chunks is enumerated (perf:
// avoids projecting every tile of every loaded chunk, most of which are
// off-screen at chunk_size 64 — see F-029/SOMET-209). `camera` is optional
// for back-compat; omit it to enumerate all loaded chunks in full.
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
    const range = camera ? visibleTileRange(cx, cy, N, camera) : null;
    const lrStart = range ? range.lrStart : 0;
    const lrEnd = range ? range.lrEnd : grid.length - 1;
    for (let lr = lrStart; lr <= lrEnd; lr++) {
      const row = grid[lr];
      if (!row) continue;
      const lcStart = range ? range.lcStart : 0;
      const lcEnd = range ? range.lcEnd : row.length - 1;
      for (let lc = lcStart; lc <= lcEnd; lc++) {
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
