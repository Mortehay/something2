import { worldToChunkLocal, CHUNK_KEY } from "./worldCoords.js";
import { MAP_TILE_SIZE } from "./constants.js";

// Holds a neighborhood of loaded chunk grids and resolves world-pixel positions
// to tiles, walkability, and speed. Mirrors the collision interface of the
// legacy `Map` (getTileAt + mapTiles) so Player.update can consume it unchanged
// (wired in Phase 4). A chunk grid is grid[localRow][localCol] of tile-type names.
export class ChunkedMap {
  constructor(chunkSize, mapTiles = null) {
    this.chunkSize = chunkSize;
    this.tileSize = MAP_TILE_SIZE;
    this.mapTiles = mapTiles;
    this.chunks = new Map(); // "cx,cy" -> string[][]
  }

  setChunk(cx, cy, grid) { this.chunks.set(CHUNK_KEY(cx, cy), grid); }
  hasChunk(cx, cy) { return this.chunks.has(CHUNK_KEY(cx, cy)); }
  removeChunk(cx, cy) { this.chunks.delete(CHUNK_KEY(cx, cy)); }
  getChunk(cx, cy) { return this.chunks.get(CHUNK_KEY(cx, cy)) || null; }
  loadedKeys() { return [...this.chunks.keys()]; }

  getTileAt(worldX, worldY) {
    const { cx, cy, lr, lc } = worldToChunkLocal(worldX, worldY, this.chunkSize);
    const grid = this.chunks.get(CHUNK_KEY(cx, cy));
    if (!grid || !grid[lr]) return null;
    const tile = grid[lr][lc];
    return tile === undefined ? null : tile;
  }

  _tileDef(tileType) {
    if (!tileType || !this.mapTiles) return null;
    if (Array.isArray(this.mapTiles)) {
      return this.mapTiles.find((t) => t.name === tileType || t.type === tileType) || null;
    }
    return this.mapTiles[tileType] || null;
  }

  isWalkable(worldX, worldY) {
    const tile = this.getTileAt(worldX, worldY);
    if (tile === null) return false; // unloaded/unknown -> blocked (streaming frontier)
    const def = this._tileDef(tile);
    return def ? def.walkable !== false : true;
  }

  speedAt(worldX, worldY) {
    const def = this._tileDef(this.getTileAt(worldX, worldY));
    return def && def.speed !== undefined ? def.speed : 1;
  }
}
