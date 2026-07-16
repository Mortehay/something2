import { parseKey, chunkOrigin } from "./worldCoords.js";
import { MAP_TILE_SIZE } from "./constants.js";

// World-pixel tile centers (+ tile name) for every cell of every loaded chunk.
// Pure; consumed by the renderer. grid[lr][lc] is the tile at local row lr, col lc.
export function chunkTileCells(chunkedMap) {
  const T = MAP_TILE_SIZE;
  const N = chunkedMap.chunkSize;
  const cells = [];
  for (const key of chunkedMap.loadedKeys()) {
    const { cx, cy } = parseKey(key);
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
