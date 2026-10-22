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
    this.decorations = new Map(); // "cx,cy" -> { list, blocked: Map<"row,col", {x,y,r}[]> }
    this.biomes = new Map(); // "cx,cy" -> string[][] (coarse biome grid, or absent)
    this.cover = new Map(); // "cx,cy" -> { types: string[], cells: number[] } (5-tuples), or absent
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

  setChunk(cx, cy, grid, decorations = [], biomes = null, cover = null) {
    this.chunks.set(CHUNK_KEY(cx, cy), grid);
    // Precompute the blocking circles (tile-local px) per tile for cheap
    // walkability checks; same structure as ServerMap.blockedDecorationsFor.
    const blocked = new Map();
    for (const d of decorations) {
      if (d.blocking !== true) continue;
      const k = `${d.row},${d.col}`;
      let list = blocked.get(k);
      if (!list) { list = []; blocked.set(k, list); }
      list.push({ x: d.ox, y: d.oy, r: d.radius });
    }
    this.decorations.set(CHUNK_KEY(cx, cy), { list: decorations, blocked });
    if (biomes) this.biomes.set(CHUNK_KEY(cx, cy), biomes);
    else this.biomes.delete(CHUNK_KEY(cx, cy));
    if (cover && cover.cells && cover.cells.length) this.cover.set(CHUNK_KEY(cx, cy), cover);
    else this.cover.delete(CHUNK_KEY(cx, cy));
  }
  hasChunk(cx, cy) { return this.chunks.has(CHUNK_KEY(cx, cy)); }
  removeChunk(cx, cy) {
    this.chunks.delete(CHUNK_KEY(cx, cy));
    this.decorations.delete(CHUNK_KEY(cx, cy));
    this.biomes.delete(CHUNK_KEY(cx, cy));
    this.cover.delete(CHUNK_KEY(cx, cy));
  }
  getChunk(cx, cy) { return this.chunks.get(CHUNK_KEY(cx, cy)) || null; }
  decorationsInChunk(cx, cy) { const e = this.decorations.get(CHUNK_KEY(cx, cy)); return e ? e.list : []; }
  coverInChunk(cx, cy) { return this.cover.get(CHUNK_KEY(cx, cy)) || { types: [], cells: [] }; }
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
    // Blocking-decoration overlay mirrors the server's ServerMap.isWalkable so
    // client-side prediction and server authority agree: a blocking feature is
    // a circle of r px (inclusive) around its tile-local anchor, never
    // crossing its tile's edge.
    const { cx, cy, lr, lc } = worldToChunkLocal(worldX, worldY, this.chunkSize);
    const e = this.decorations.get(CHUNK_KEY(cx, cy));
    const circles = e && e.blocked.get(`${lr},${lc}`);
    if (circles) {
      const gCol = cx * this.chunkSize + lc;
      const gRow = cy * this.chunkSize + lr;
      const lx = worldX - gCol * this.tileSize;
      const ly = worldY - gRow * this.tileSize;
      for (const c of circles) {
        const dx = lx - c.x, dy = ly - c.y;
        if (dx * dx + dy * dy <= c.r * c.r) return false;
      }
    }
    return true;
  }

  speedAt(worldX, worldY) {
    const def = this._tileDef(this.getTileAt(worldX, worldY));
    return def && def.speed !== undefined ? def.speed : 1;
  }

  // Game audio: the biome under a world position, from the coarse grid the
  // chunk route sends (grid.length cells per chunk side, so the cell step is
  // chunkSize / grid.length -- 8x8 for a 64-tile chunk, 4x4 for a 32-tile one).
  // undefined = chunk not loaded yet ("don't know"); null = loaded but no
  // biome here (the world has no biome grid). The ambience engine treats both
  // as "keep what is playing" once a biome has played, but uses null to fall
  // back to world ambience in a biome-less world. Reuses getTileAt's
  // world -> chunk -> local conversion.
  biomeAt(worldX, worldY) {
    const { cx, cy, lr, lc } = worldToChunkLocal(worldX, worldY, this.chunkSize);
    if (!this.chunks.has(CHUNK_KEY(cx, cy))) return undefined;
    const g = this.biomes.get(CHUNK_KEY(cx, cy));
    if (!g) return null;
    const step = this.chunkSize / g.length;
    const r = Math.floor(lr / step);
    const c = Math.floor(lc / step);
    return (g[r] && g[r][c]) || null;
  }
}
