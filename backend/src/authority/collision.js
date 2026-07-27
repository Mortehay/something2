// Server-side movement/collision for the authoritative simulation. The
// resolveMove algorithm is a byte-for-byte port of the frontend
// systems/movement.js so client prediction and server authority converge.
// ServerMap lazily generates chunks via mapService.generateChunk — the server
// has the whole world, so (unlike the client's streaming ChunkedMap) an
// unknown tile only happens on a malformed grid, and is treated as blocked.
const { generateChunk } = require('../services/mapService');

const MAP_TILE_SIZE = 100; // must match frontend core/constants.js
const MAX_CHUNKS = 512; // per-ServerMap LRU cap on memoized chunk grids

function resolveMove(map, actor, dirX, dirY, dt) {
  if (dirX === 0 && dirY === 0) return { x: actor.x, y: actor.y, moved: false };

  const len = Math.hypot(dirX, dirY);
  const nx = dirX / len;
  const ny = dirY / len;

  const hw = actor.width / 2;
  const hh = actor.height / 2;
  const cx = actor.x + hw;
  const cy = actor.y + hh;

  const tileSpeed = map.speedAt(cx, cy);
  const stepX = nx * actor.speed * dt * tileSpeed;
  const stepY = ny * actor.speed * dt * tileSpeed;

  let x = actor.x;
  let y = actor.y;
  let moved = false;

  // Footprint collision: block a step only if the box's LEADING EDGE in the
  // step direction would enter an unwalkable tile. Test the edge's two corners
  // (the box is <= a tile wide, so 2 corners cover every tile it can touch).
  // Testing only the leading edge — not the whole box — lets an actor already
  // overlapping a wall still move away from it.
  if (stepX !== 0) {
    const leadX = cx + stepX + (stepX > 0 ? hw : -hw);
    if (map.isWalkable(leadX, cy - hh) && map.isWalkable(leadX, cy + hh)) {
      x += stepX;
      moved = true;
    }
  }
  if (stepY !== 0) {
    const leadY = cy + stepY + (stepY > 0 ? hh : -hh);
    if (map.isWalkable(cx - hw, leadY) && map.isWalkable(cx + hw, leadY)) {
      y += stepY;
      moved = true;
    }
  }

  return { x, y, moved };
}

class ServerMap {
  // world: { seed:number, chunkSize:number, tileTypes:{ [name]: {walkable, speed} } }
  constructor(world) {
    this.world = world;
    this.chunkSize = world.chunkSize;
    this.tileTypes = world.tileTypes;
    this.chunks = new Map(); // "cx,cy" -> string[][]
  }

  getChunk(cx, cy) {
    const key = `${cx},${cy}`;
    const g = this.chunks.get(key);
    if (g !== undefined) {
      // Refresh recency: delete + re-set moves the key to the newest position
      // (Map preserves insertion order, so the first key is the LRU victim).
      this.chunks.delete(key);
      this.chunks.set(key, g);
      return g;
    }
    const grid = generateChunk(this.world, cx, cy);
    this.chunks.set(key, grid);
    if (this.chunks.size > MAX_CHUNKS) {
      this.chunks.delete(this.chunks.keys().next().value); // evict oldest
    }
    return grid;
  }

  getTileAt(worldX, worldY) {
    const gCol = Math.floor(worldX / MAP_TILE_SIZE);
    const gRow = Math.floor(worldY / MAP_TILE_SIZE);
    const cx = Math.floor(gCol / this.chunkSize);
    const cy = Math.floor(gRow / this.chunkSize);
    const lc = gCol - cx * this.chunkSize;
    const lr = gRow - cy * this.chunkSize;
    const grid = this.getChunk(cx, cy);
    if (!grid || !grid[lr]) return null;
    const t = grid[lr][lc];
    return t === undefined ? null : t;
  }

  isWalkable(worldX, worldY) {
    const t = this.getTileAt(worldX, worldY);
    if (t === null) return false;
    const def = this.tileTypes[t];
    return def ? def.walkable !== false : true;
  }

  speedAt(worldX, worldY) {
    const def = this.tileTypes[this.getTileAt(worldX, worldY)];
    return def && def.speed !== undefined ? def.speed : 1;
  }
}

module.exports = { resolveMove, ServerMap, MAP_TILE_SIZE, MAX_CHUNKS };
