# Connected Chunked World — Phase 3 (World-Space Coordinates) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the client continuous world-pixel coordinates that span all chunks, and a `ChunkedMap` that answers `getTileAt` / `isWalkable` / `speedAt` across a loaded neighborhood of chunks — so the existing collision/prediction in `Player.update` will work over chunk seams with no change to its call shape (SOMET-56).

**Architecture:** A pure coordinate module `worldCoords.js` converts world-pixel positions to chunk indices `(cx, cy)` and per-chunk local tile indices `(lr, lc)`, using the **same tile-ownership rule as Phase 1's generator** (chunk `(cx,cy)` owns global tiles `[cx·N, cx·N+N)`). A `ChunkedMap` class holds a set of loaded chunk grids keyed `"cx,cy"` and resolves a world-pixel position to the owning chunk's tile, then to a walkable/speed value via the tile-type table. Both are plain ES-module JS in the client game, unit-tested with Vitest. Nothing is wired into the game loop yet — that's Phase 4.

**Tech Stack:** Frontend ES modules (`frontend/src/games/something2/src/js/core/`), Vitest (`npm run test` from `frontend/`). No new dependencies.

## Global Constraints

- **ES modules** (`import`/`export`) — this is frontend game code. Do not use CommonJS here.
- **No new dependencies.** Vitest is already configured (`frontend/vitest.config.js`, node env, `include: ["src/**/*.test.js"]`).
- **Chunk-ownership rule must match Phase 1 exactly:** chunk `(cx, cy)` owns global tile rows `[cy·N, cy·N+N)` and cols `[cx·N, cx·N+N)`, where `N = chunkSize` (tiles). A chunk grid is `grid[localRow][localCol]`, `localRow`/`localCol` ∈ `[0, N)`. This is the same indexing `generateChunk`/`generateRegion` produce, so a chunk fetched from `GET /api/worlds/:id/chunk` drops straight into `ChunkedMap`.
- **Tile pixel size:** `MAP_TILE_SIZE = 100` (from `core/constants.js`). World-pixel ↔ global-tile is `floor(px / MAP_TILE_SIZE)`, matching the existing `Map.getTileAt`.
- **Negative coordinates supported** — chunks/tiles exist at negative world positions. All coordinate math must use `Math.floor` (correct for negatives), never truncation.
- **`ChunkedMap` mirrors the existing `Map` collision interface** so `Player.update(dt, keys, map)` can consume it unchanged in Phase 4: it exposes `getTileAt(worldX, worldY)` (returns a tile-type string or `null`) and a `mapTiles` field (the tile-type table, object-keyed-by-name **or** array — matching how `Map`/`Player.update` already read it).
- **Do not modify** `Map.js`, `Player.js`, `Game.js`, or any existing file. Phase 3 only **adds** two new modules + their tests. Wiring is Phase 4.
- Commit after every task.

## File Structure

- **Create:** `frontend/src/games/something2/src/js/core/worldCoords.js` — pure coordinate conversions.
- **Create:** `frontend/src/games/something2/src/js/core/ChunkedMap.js` — loaded-neighborhood tile resolver.
- **Create:** `frontend/src/games/something2/src/js/core/__tests__/worldCoords.test.js` and `.../ChunkedMap.test.js`.

---

### Task 1: World-space coordinate util (`worldCoords.js`)

**Files:**
- Create: `frontend/src/games/something2/src/js/core/worldCoords.js`
- Create: `frontend/src/games/something2/src/js/core/__tests__/worldCoords.test.js`

**Interfaces:**
- Consumes: `MAP_TILE_SIZE` from `../constants.js`.
- Produces (all take `chunkSize` in tiles; world coords are pixels):
  - `worldToChunkLocal(worldX, worldY, chunkSize) -> { cx, cy, lr, lc }` — owning chunk index + local tile row/col within it. `lr, lc` always in `[0, chunkSize)`, including negatives.
  - `chunkOf(worldX, worldY, chunkSize) -> { cx, cy }` — just the owning chunk index (consistent with `worldToChunkLocal`).
  - `chunkOrigin(cx, cy, chunkSize) -> { x, y }` — world-pixel top-left of the chunk.
  - `CHUNK_KEY(cx, cy) -> string` — canonical `"cx,cy"` key (used by `ChunkedMap`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/core/__tests__/worldCoords.test.js`:
```js
import { describe, it, expect } from "vitest";
import {
  worldToChunkLocal, chunkOf, chunkOrigin, CHUNK_KEY,
} from "../worldCoords.js";
import { MAP_TILE_SIZE } from "../constants.js";

const N = 4;                // small chunk (tiles) for legible tests
const T = MAP_TILE_SIZE;    // 100 px per tile
const CHUNK_PX = N * T;     // 400 px per chunk

describe("worldToChunkLocal", () => {
  it("puts the origin tile at chunk (0,0) local (0,0)", () => {
    expect(worldToChunkLocal(0, 0, N)).toEqual({ cx: 0, cy: 0, lr: 0, lc: 0 });
  });

  it("local indices stay within [0, N) and rebuild the global tile index", () => {
    for (const [wx, wy] of [[0, 0], [350, 999], [-1, -1], [-350, 12345], [4321, -6789]]) {
      const { cx, cy, lr, lc } = worldToChunkLocal(wx, wy, N);
      expect(lr).toBeGreaterThanOrEqual(0); expect(lr).toBeLessThan(N);
      expect(lc).toBeGreaterThanOrEqual(0); expect(lc).toBeLessThan(N);
      // global tile index == cx*N + lc  (matches Phase 1 chunk ownership)
      expect(cx * N + lc).toBe(Math.floor(wx / T));
      expect(cy * N + lr).toBe(Math.floor(wy / T));
    }
  });

  it("is seam-consistent: last tile of a chunk and first of the next are adjacent", () => {
    // worldX just inside chunk 0's last column vs chunk 1's first column.
    const lastOf0 = worldToChunkLocal(CHUNK_PX - 1, 0, N); // cx 0, lc N-1
    const firstOf1 = worldToChunkLocal(CHUNK_PX, 0, N);    // cx 1, lc 0
    expect(lastOf0).toMatchObject({ cx: 0, lc: N - 1 });
    expect(firstOf1).toMatchObject({ cx: 1, lc: 0 });
  });

  it("handles negative coordinates with floor semantics", () => {
    // -1 px is global tile -1 => chunk -1, local col N-1.
    expect(worldToChunkLocal(-1, -1, N)).toEqual({ cx: -1, cy: -1, lr: N - 1, lc: N - 1 });
  });
});

describe("chunkOf / chunkOrigin", () => {
  it("chunkOf agrees with worldToChunkLocal", () => {
    for (const [wx, wy] of [[123, 456], [-5, -5], [CHUNK_PX + 7, -CHUNK_PX - 7]]) {
      const full = worldToChunkLocal(wx, wy, N);
      expect(chunkOf(wx, wy, N)).toEqual({ cx: full.cx, cy: full.cy });
    }
  });

  it("chunkOrigin is the top-left world pixel of a chunk, and contains its points", () => {
    expect(chunkOrigin(0, 0, N)).toEqual({ x: 0, y: 0 });
    expect(chunkOrigin(2, -1, N)).toEqual({ x: 2 * CHUNK_PX, y: -1 * CHUNK_PX });
    // Any point in chunk (2,-1) is within [origin, origin+CHUNK_PX).
    const { cx, cy } = chunkOf(2 * CHUNK_PX + 5, -CHUNK_PX + 5, N);
    const o = chunkOrigin(cx, cy, N);
    expect(2 * CHUNK_PX + 5 - o.x).toBeGreaterThanOrEqual(0);
    expect(2 * CHUNK_PX + 5 - o.x).toBeLessThan(CHUNK_PX);
  });
});

describe("CHUNK_KEY", () => {
  it("formats a canonical key incl. negatives", () => {
    expect(CHUNK_KEY(0, 0)).toBe("0,0");
    expect(CHUNK_KEY(-2, 3)).toBe("-2,3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `frontend/`: `npm run test -- worldCoords`
Expected: FAIL — `Failed to resolve import "../worldCoords.js"`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/games/something2/src/js/core/worldCoords.js`:
```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run from `frontend/`: `npm run test -- worldCoords`
Expected: PASS (all cases). Then run the full suite `npm run test` — existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/worldCoords.js frontend/src/games/something2/src/js/core/__tests__/worldCoords.test.js
git commit -m "feat(chunkedworld): world-space coordinate util (SOMET-56)"
```

---

### Task 2: `ChunkedMap` — tile resolver over a loaded neighborhood

**Files:**
- Create: `frontend/src/games/something2/src/js/core/ChunkedMap.js`
- Create: `frontend/src/games/something2/src/js/core/__tests__/ChunkedMap.test.js`

**Interfaces:**
- Consumes: `worldToChunkLocal`, `CHUNK_KEY` from `./worldCoords.js`; `MAP_TILE_SIZE` from `./constants.js`.
- Produces: `class ChunkedMap`:
  - `constructor(chunkSize, mapTiles = null)` — `chunkSize` in tiles; `mapTiles` is the tile-type table (object keyed by name, or array of defs — same shape `Map`/`Player.update` accept). Exposes `this.chunkSize`, `this.tileSize = MAP_TILE_SIZE`, `this.mapTiles`, and an internal `this.chunks` (a native `Map` of `"cx,cy" -> string[][]`).
  - `setChunk(cx, cy, grid)`, `hasChunk(cx, cy)`, `removeChunk(cx, cy)`, `getChunk(cx, cy) -> grid|null`, `loadedKeys() -> string[]`.
  - `getTileAt(worldX, worldY) -> string|null` — tile-type name at the world-pixel position, or `null` if that chunk isn't loaded (or the cell is empty).
  - `isWalkable(worldX, worldY) -> boolean` — `false` when the tile is `null` (unloaded → treat as blocked, so an actor can't walk into un-streamed space) or the tile def has `walkable === false`; `true` otherwise.
  - `speedAt(worldX, worldY) -> number` — the tile def's `speed`, or `1` when unknown.

**Design decision (unloaded = blocked):** the current finite-map code treats "no tile" as walkable (edge of a bounded map). In an infinite streamed world, a `null` from `ChunkedMap` means "this chunk hasn't streamed in yet," so `isWalkable` returns **false** there — the actor stops at the streaming frontier rather than walking into the void. Phase 4 keeps a neighborhood around the player, so in normal play the player's tile is always loaded and this only bites at the not-yet-loaded edge.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/core/__tests__/ChunkedMap.test.js`:
```js
import { describe, it, expect } from "vitest";
import { ChunkedMap } from "../ChunkedMap.js";
import { MAP_TILE_SIZE } from "../constants.js";

const N = 4;
const T = MAP_TILE_SIZE;
const CHUNK_PX = N * T;

// A distinct 4x4 grid so we can tell cells apart. grid[lr][lc].
function grid(fill) {
  return Array.from({ length: N }, (_, r) =>
    Array.from({ length: N }, (_, c) => `${fill}-${r}${c}`));
}

const TILE_DEFS = {
  grass: { walkable: true, speed: 1 },
  water: { walkable: false, speed: 1 },
  mud: { walkable: true, speed: 0.5 },
};

describe("ChunkedMap storage", () => {
  it("stores and reports loaded chunks incl. negatives", () => {
    const m = new ChunkedMap(N);
    m.setChunk(0, 0, grid("a"));
    m.setChunk(-1, 2, grid("b"));
    expect(m.hasChunk(0, 0)).toBe(true);
    expect(m.hasChunk(-1, 2)).toBe(true);
    expect(m.hasChunk(5, 5)).toBe(false);
    expect(m.loadedKeys().sort()).toEqual(["-1,2", "0,0"]);
    m.removeChunk(0, 0);
    expect(m.hasChunk(0, 0)).toBe(false);
  });
});

describe("ChunkedMap.getTileAt across a neighborhood", () => {
  it("resolves cells in the correct chunk and local position", () => {
    const m = new ChunkedMap(N);
    m.setChunk(0, 0, grid("A"));
    m.setChunk(1, 0, grid("B"));
    // (0,0) px -> chunk 0, local (0,0)
    expect(m.getTileAt(0, 0)).toBe("A-00");
    // last column of chunk 0 -> local (0, N-1)
    expect(m.getTileAt(CHUNK_PX - 1, 0)).toBe(`A-0${N - 1}`);
    // first column of chunk 1 -> chunk 1, local (0,0)
    expect(m.getTileAt(CHUNK_PX, 0)).toBe("B-00");
  });

  it("returns null for an unloaded chunk", () => {
    const m = new ChunkedMap(N);
    m.setChunk(0, 0, grid("A"));
    expect(m.getTileAt(CHUNK_PX + 10, 0)).toBe(null); // chunk (1,0) not loaded
  });

  it("resolves negative-coordinate chunks", () => {
    const m = new ChunkedMap(N);
    m.setChunk(-1, -1, grid("Z"));
    // (-1,-1) px -> chunk (-1,-1), local (N-1, N-1)
    expect(m.getTileAt(-1, -1)).toBe(`Z-${N - 1}${N - 1}`);
  });
});

describe("ChunkedMap.isWalkable / speedAt", () => {
  it("uses tile defs; unloaded is blocked", () => {
    const m = new ChunkedMap(N, TILE_DEFS);
    m.setChunk(0, 0, [
      ["grass", "water", "mud", "grass"],
      ["grass", "grass", "grass", "grass"],
      ["grass", "grass", "grass", "grass"],
      ["grass", "grass", "grass", "grass"],
    ]);
    expect(m.isWalkable(0, 0)).toBe(true);            // grass
    expect(m.isWalkable(T, 0)).toBe(false);           // water at local (0,1)
    expect(m.speedAt(2 * T, 0)).toBe(0.5);            // mud at local (0,2)
    expect(m.speedAt(0, 0)).toBe(1);                  // grass
    expect(m.isWalkable(CHUNK_PX, 0)).toBe(false);    // unloaded chunk -> blocked
    expect(m.speedAt(CHUNK_PX, 0)).toBe(1);           // unknown -> default speed 1
  });

  it("accepts an array-shaped mapTiles table too", () => {
    const arr = [{ name: "grass", walkable: true, speed: 1 }, { name: "water", walkable: false, speed: 1 }];
    const m = new ChunkedMap(N, arr);
    m.setChunk(0, 0, [["water", "grass", "grass", "grass"], ...Array.from({ length: N - 1 }, () => Array(N).fill("grass"))]);
    expect(m.isWalkable(0, 0)).toBe(false); // water via array lookup
    expect(m.isWalkable(T, 0)).toBe(true);  // grass
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `frontend/`: `npm run test -- ChunkedMap`
Expected: FAIL — cannot resolve `../ChunkedMap.js`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/games/something2/src/js/core/ChunkedMap.js`:
```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run from `frontend/`: `npm run test -- ChunkedMap`
Expected: PASS. Then `npm run test` (full suite) — all green. Then `npm run lint` — no new errors in the two added files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/ChunkedMap.js frontend/src/games/something2/src/js/core/__tests__/ChunkedMap.test.js
git commit -m "feat(chunkedworld): ChunkedMap tile resolver over loaded neighborhood (SOMET-56)"
```

---

## Self-Review

**Spec coverage (Phase 3 section of the design doc):**
- "shared module: `chunkOf`, `chunkOrigin`, `worldToChunkLocal`" → Task 1. ✓ (Placed in the frontend as ES modules — see scope note below. `worldToChunkLocal` also returns local `lr/lc`, which the spec implies and `ChunkedMap` needs.)
- "Actors get continuous world-pixel positions spanning all chunks" → the util operates purely in continuous world pixels; no per-map local coords. ✓ (Actual actor-position migration is Phase 4/5 wiring.)
- "client `ChunkedMap`: `getTileAt` / `isWalkable` / `speedAt` across the loaded neighborhood, so `Player.update` works over seams with no change to its call shape" → Task 2; `ChunkedMap` exposes `getTileAt` + `mapTiles` (the exact reads `Player.update` makes) plus `isWalkable`/`speedAt`. ✓
- Testing (spec): "`chunkOf`/`chunkOrigin`/`worldToChunkLocal` round-trip; `ChunkedMap.getTileAt` resolves across a loaded neighborhood including negative coordinates" → Task 1 round-trip/seam/negative tests, Task 2 neighborhood + negative + unloaded tests. ✓

**Placeholder scan:** No TBD/TODO/vague steps. Full code + full test assertions in every step. ✓

**Type/name consistency:** `worldToChunkLocal(worldX, worldY, chunkSize) -> {cx,cy,lr,lc}` is produced in Task 1 and consumed in Task 2 with the same destructuring. `CHUNK_KEY(cx,cy)` is defined in Task 1 and used in Task 2. `ChunkedMap` grid is `grid[lr][lc]` throughout (matches Phase 1's `generateChunk` output `grid[localRow][localCol]`). `mapTiles` object-or-array handling matches the legacy `Map`/`Player.update` lookup shape. `MAP_TILE_SIZE` is the single px-per-tile source. ✓

**Scope decision — where the coord util lives:** the design calls it "usable by backend and frontend," but the backend does not currently need world-pixel↔chunk conversion (the Phase 2 chunk route takes `cx`/`cy` directly and `generateChunk` owns its own tile math). The real consumer is the client (`ChunkedMap`, streaming, collision). To avoid a CommonJS/ESM shared-module hazard, the util lives in the **frontend ESM** for now; if the backend later needs the same conversions, port these ~4 pure functions to a CommonJS helper then. Flagged so the deviation from "shared module" is explicit.

## Out of scope for this plan (later phases, separate plans)
- Client streaming (3×3 neighborhood load/unload) + multi-chunk iso render → Phase 4 (SOMET-57).
- Wiring `Player.update`/`Game` to consume `ChunkedMap` instead of `Map` → Phase 4.
- World-space free-roaming creatures → Phase 5 (SOMET-58).
