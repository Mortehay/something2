// Server-side movement/collision for the authoritative simulation. The
// resolveMove algorithm is a byte-for-byte port of the frontend
// systems/movement.js so client prediction and server authority converge.
// ServerMap lazily generates chunks via mapService.generateChunk — the server
// has the whole world, so (unlike the client's streaming ChunkedMap) an
// unknown tile only happens on a malformed grid, and is treated as blocked.
const { generateChunk, generateChunkDecorations } = require('../services/mapService');

const MAP_TILE_SIZE = 100; // must match frontend core/constants.js
const MAX_CHUNKS = 512; // per-ServerMap LRU cap on memoized chunk grids
const WALL_EPS = 0.01; // clamp/inset margin so a clamped face stays inside the walkable tile

// SOMET-337. Fraction of the actor's box used as its ground FOOTPRINT — the
// feet, not the whole body. The box is the SPRITE's extent (player 64x64,
// creature 48x48); using all of it against a 100px tile stopped an actor half
// a box-width from the obstacle (32px for a player), a gap that became visible
// once SOMET-319 put the feet on the real anchor. At 0.5 the standoff halves:
// 16px for a player, 12px for a creature.
//
// Scale, not a fixed size, so one rule covers every actor and 1.0 reproduces
// the old full-box behaviour exactly. The anchor is unchanged — the footprint
// is centred on the same box centre movement already resolved against.
const FOOTPRINT_SCALE = 0.5;

function resolveMove(map, actor, dirX, dirY, dt) {
  if (dirX === 0 && dirY === 0) return { x: actor.x, y: actor.y, moved: false };

  const len = Math.hypot(dirX, dirY);
  const nx = dirX / len;
  const ny = dirY / len;

  const hw = actor.width / 2;
  const hh = actor.height / 2;
  const cx = actor.x + hw;
  const cy = actor.y + hh;

  // Footprint half-extents — what the walkability samples and the swept clamp
  // read. hw/hh stay the SPRITE box (still the anchor's basis); fhw/fhh are the
  // feet. With FOOTPRINT_SCALE = 1 these are equal and the maths is identical
  // to the pre-SOMET-337 full-box test.
  const fhw = hw * FOOTPRINT_SCALE;
  const fhh = hh * FOOTPRINT_SCALE;

  const tileSpeed = map.speedAt(cx, cy);
  const stepX = nx * actor.speed * dt * tileSpeed;
  const stepY = ny * actor.speed * dt * tileSpeed;

  let x = actor.x;
  let y = actor.y;
  let moved = false;

  // Swept clamp per axis. The leading face is the box edge in the travel
  // direction; a sub-tile step crosses at most one boundary.
  // Assumes tile-aligned walls (isWalkable is per-tile) and sub-tile steps (dt small); both hold in-game.
  // If the destination corners are blocked, clamp the face to WALL_EPS shy of the
  // wall boundary and move only that far (dt-invariant: any timestep lands on
  // the same face). Perpendicular corners are inset by WALL_EPS so an edge
  // exactly on a tile line is not read as inside the next tile.
  if (stepX !== 0) {
    const dir = stepX > 0 ? 1 : -1;
    const face = cx + dir * fhw;
    const destFace = face + stepX;
    const top = cy - fhh + WALL_EPS;
    const bot = cy + fhh - WALL_EPS;
    if (map.isWalkable(destFace, top) && map.isWalkable(destFace, bot)) {
      x += stepX;
      moved = true;
    } else {
      const boundary = dir > 0
        ? Math.floor(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE
        : Math.ceil(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE;
      const tileFace = boundary - dir * WALL_EPS;
      const tileMove = tileFace - face;
      if (tileMove * dir > 0 && map.isWalkable(tileFace, top) && map.isWalkable(tileFace, bot) &&
          (!map.isWalkable(boundary + dir * WALL_EPS, top) || !map.isWalkable(boundary + dir * WALL_EPS, bot))) {
        x += tileMove;
        moved = true;
      } else {
        let lo = 0;
        let hi = stepX;
        for (let iter = 0; iter < 16; iter++) {
          const mid = (lo + hi) / 2;
          const testFace = face + mid;
          if (map.isWalkable(testFace, top) && map.isWalkable(testFace, bot)) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        const safeMove = dir > 0 ? Math.max(0, lo - WALL_EPS) : Math.min(0, lo + WALL_EPS);
        if (Math.abs(safeMove) > 0.0001) {
          x += safeMove;
          moved = true;
        }
      }
    }
  }
  if (stepY !== 0) {
    const dir = stepY > 0 ? 1 : -1;
    const face = cy + dir * fhh;
    const destFace = face + stepY;
    const left = cx - fhw + WALL_EPS;
    const right = cx + fhw - WALL_EPS;
    if (map.isWalkable(left, destFace) && map.isWalkable(right, destFace)) {
      y += stepY;
      moved = true;
    } else {
      const boundary = dir > 0
        ? Math.floor(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE
        : Math.ceil(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE;
      const tileFace = boundary - dir * WALL_EPS;
      const tileMove = tileFace - face;
      if (tileMove * dir > 0 && map.isWalkable(left, tileFace) && map.isWalkable(right, tileFace) &&
          (!map.isWalkable(left, boundary + dir * WALL_EPS) || !map.isWalkable(right, boundary + dir * WALL_EPS))) {
        y += tileMove;
        moved = true;
      } else {
        let lo = 0;
        let hi = stepY;
        for (let iter = 0; iter < 16; iter++) {
          const mid = (lo + hi) / 2;
          const testFace = face + mid;
          if (map.isWalkable(left, testFace) && map.isWalkable(right, testFace)) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        const safeMove = dir > 0 ? Math.max(0, lo - WALL_EPS) : Math.min(0, lo + WALL_EPS);
        if (Math.abs(safeMove) > 0.0001) {
          y += safeMove;
          moved = true;
        }
      }
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
    this.decorationDefs = world.decorationDefs || [];
    // "cx,cy" -> Map<"lr,lc", {x,y,r}[]>: the blocking circles (tile-local px)
    // of each tile. ChunkedMap.setChunk builds the identical structure.
    this.blockedDecoCircles = new Map();
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

  // Lazily builds (and memoizes, LRU-capped like getChunk) the blocking circles
  // per chunk-local "row,col" tile, using the same generateChunkDecorations the
  // /chunk endpoint uses -- the parity mechanism that keeps client-visible
  // decorations and server collision in lockstep.
  blockedDecorationsFor(cx, cy) {
    const key = `${cx},${cy}`;
    let tiles = this.blockedDecoCircles.get(key);
    if (tiles !== undefined) return tiles;
    tiles = new Map();
    if (this.decorationDefs.length > 0) {
      const grid = this.getChunk(cx, cy);
      for (const d of generateChunkDecorations(this.world, cx, cy, grid, this.decorationDefs, { cover: false })) {
        if (!d.blocking) continue;
        const k = `${d.row},${d.col}`;
        let list = tiles.get(k);
        if (!list) { list = []; tiles.set(k, list); }
        list.push({ x: d.ox, y: d.oy, r: d.radius });
      }
    }
    this.blockedDecoCircles.set(key, tiles);
    if (this.blockedDecoCircles.size > MAX_CHUNKS) {
      this.blockedDecoCircles.delete(this.blockedDecoCircles.keys().next().value);
    }
    return tiles;
  }

  isWalkable(worldX, worldY) {
    const t = this.getTileAt(worldX, worldY);
    if (t === null) return false;
    const def = this.tileTypes[t];
    if (def && def.walkable === false) return false;
    // Decoration overlay: a blocking feature is a circle of `r` px around its
    // tile-local anchor (x, y), inclusive of the edge. The generator keeps the
    // circle inside its own tile, so only that tile's circles are tested.
    const gCol = Math.floor(worldX / MAP_TILE_SIZE);
    const gRow = Math.floor(worldY / MAP_TILE_SIZE);
    const cx = Math.floor(gCol / this.chunkSize);
    const cy = Math.floor(gRow / this.chunkSize);
    const lc = gCol - cx * this.chunkSize;
    const lr = gRow - cy * this.chunkSize;
    const circles = this.blockedDecorationsFor(cx, cy).get(`${lr},${lc}`);
    if (circles) {
      const lx = worldX - gCol * MAP_TILE_SIZE;
      const ly = worldY - gRow * MAP_TILE_SIZE;
      for (const c of circles) {
        const dx = lx - c.x, dy = ly - c.y;
        if (dx * dx + dy * dy <= c.r * c.r) return false;
      }
    }
    return true;
  }

  speedAt(worldX, worldY) {
    const def = this.tileTypes[this.getTileAt(worldX, worldY)];
    return def && def.speed !== undefined ? def.speed : 1;
  }
}

// FOOTPRINT_SCALE and WALL_EPS are exported for TESTS ONLY, and only so one
// test can pin them (see authority_collision.test.js's "the footprint geometry
// three fixtures depend on"). Nothing in src reads them from here. Fixtures
// deliberately keep their expected positions as literals rather than
// recomputing them from these values -- an assertion derived from the same
// constant as the code under test agrees with a wrong constant.
module.exports = {
  resolveMove, ServerMap, MAP_TILE_SIZE, MAX_CHUNKS, FOOTPRINT_SCALE, WALL_EPS,
};
