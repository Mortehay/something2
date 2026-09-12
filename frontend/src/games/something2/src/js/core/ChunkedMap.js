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
    this.chunks = new Map(); // "cx,cy" -> string[][]
    this.decorations = new Map(); // "cx,cy" -> { list, blocked: Set<"row,col"> }
    this.setMapTiles(mapTiles);
  }

  setMapTiles(mapTiles) {
    this.mapTiles = mapTiles;
    this._tileDefMap = new Map();
    if (mapTiles) {
      if (Array.isArray(mapTiles)) {
        for (const t of mapTiles) {
          if (t) {
            if (t.name) this._tileDefMap.set(t.name, t);
            if (t.type) this._tileDefMap.set(t.type, t);
          }
        }
      } else if (typeof mapTiles === 'object') {
        for (const [k, v] of Object.entries(mapTiles)) {
          this._tileDefMap.set(k, v);
        }
      }
    }
  }

  setChunk(cx, cy, grid, decorations = []) {
    this.chunks.set(CHUNK_KEY(cx, cy), grid);
    // Precompute the blocking-tile set for O(1) walkability checks.
    const blocked = new Set();
    for (const d of decorations) if (d.blocking) blocked.add(`${d.row},${d.col}`);
    this.decorations.set(CHUNK_KEY(cx, cy), { list: decorations, blocked });
  }
  hasChunk(cx, cy) { return this.chunks.has(CHUNK_KEY(cx, cy)); }
  removeChunk(cx, cy) { this.chunks.delete(CHUNK_KEY(cx, cy)); this.decorations.delete(CHUNK_KEY(cx, cy)); }
  getChunk(cx, cy) { return this.chunks.get(CHUNK_KEY(cx, cy)) || null; }
  decorationsInChunk(cx, cy) { const e = this.decorations.get(CHUNK_KEY(cx, cy)); return e ? e.list : []; }
  loadedKeys() { return [...this.chunks.keys()]; }

  getTileAt(worldX, worldY) {
    const { cx, cy, lr, lc } = worldToChunkLocal(worldX, worldY, this.chunkSize);
    const grid = this.chunks.get(CHUNK_KEY(cx, cy));
    if (!grid || !grid[lr]) return null;
    const tile = grid[lr][lc];
    return tile === undefined ? null : tile;
  }

  _tileDef(tileType) {
    if (!tileType) return null;
    if (this._tileDefMap && this._tileDefMap.has(tileType)) {
      return this._tileDefMap.get(tileType);
    }
    if (!this.mapTiles) return null;
    if (Array.isArray(this.mapTiles)) {
      return this.mapTiles.find((t) => t.name === tileType || t.type === tileType) || null;
    }
    return this.mapTiles[tileType] || null;
  }

  isWalkable(worldX, worldY) {
    const tile = this.getTileAt(worldX, worldY);
    if (tile === null) return false; // unloaded/unknown -> blocked (streaming frontier)
    const def = this._tileDef(tile);
    if (def && def.walkable === false) return false;
    // Blocking-decoration overlay mirrors the server's ServerMap.isWalkable
    // so client-side prediction and server authority agree.
    const { cx, cy, lr, lc } = worldToChunkLocal(worldX, worldY, this.chunkSize);
    const e = this.decorations.get(CHUNK_KEY(cx, cy));
    if (e && e.blocked.has(`${lr},${lc}`)) return false;
    return true;
  }

  speedAt(worldX, worldY) {
    const def = this._tileDef(this.getTileAt(worldX, worldY));
    return def && def.speed !== undefined ? def.speed : 1;
  }
}
