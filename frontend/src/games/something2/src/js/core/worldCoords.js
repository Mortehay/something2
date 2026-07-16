import { MAP_TILE_SIZE } from "./constants.js";

// World-space (pixels) <-> chunk coordinates. A chunk is `chunkSize` tiles wide;
// a tile is MAP_TILE_SIZE pixels. Chunk (cx,cy) owns global tile rows
// [cy*N, cy*N+N) and cols [cx*N, cx*N+N) — the SAME ownership rule the backend
// generator (generateChunk/generateRegion) uses, so a fetched chunk grid drops
// straight in. All math uses Math.floor so negative coordinates are correct.

export function worldToChunkLocal(worldX, worldY, chunkSize) {
  const gCol = Math.floor(worldX / MAP_TILE_SIZE); // global tile col
  const gRow = Math.floor(worldY / MAP_TILE_SIZE); // global tile row
  const cx = Math.floor(gCol / chunkSize);
  const cy = Math.floor(gRow / chunkSize);
  const lc = gCol - cx * chunkSize; // local col in [0, chunkSize)
  const lr = gRow - cy * chunkSize; // local row in [0, chunkSize)
  return { cx, cy, lr, lc };
}

export function chunkOf(worldX, worldY, chunkSize) {
  const { cx, cy } = worldToChunkLocal(worldX, worldY, chunkSize);
  return { cx, cy };
}

export function chunkOrigin(cx, cy, chunkSize) {
  const span = chunkSize * MAP_TILE_SIZE;
  return { x: cx * span, y: cy * span };
}

export function CHUNK_KEY(cx, cy) {
  return `${cx},${cy}`;
}

// Inverse of CHUNK_KEY: "cx,cy" -> { cx, cy }. Handles negative indices.
export function parseKey(key) {
  const [cx, cy] = key.split(",").map(Number);
  return { cx, cy };
}
