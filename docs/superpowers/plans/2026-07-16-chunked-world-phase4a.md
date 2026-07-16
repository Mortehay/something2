# Connected Chunked World — Phase 4a (Streaming + Collision Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the client-side machinery to stream a 3×3 chunk neighborhood around the player and resolve movement/collision against the loaded chunks — as pure, unit-tested modules with **no change to the live game loop or rendering yet** (that's Phase 4b). Also clears the three Phase-3 carry-forward items. (SOMET-57, part a)

**Architecture:** Three additive ES-module pieces plus a small helper. `NeighborhoodManager` computes which chunk keys form the (2r+1)² block around a center and diffs two neighborhoods into `{toLoad, toDrop}`. `ChunkStreamer` holds a `ChunkedMap` and, as the player's world position moves into a new chunk, fetches the newly-adjacent ring (via an **injected** async `fetchChunk`) and drops the far ring — idempotent and de-duplicated. `resolveMove` is a map-agnostic movement/collision resolver that delegates walkability/speed to the map's `isWalkable`/`speedAt` (which `ChunkedMap` provides, treating unloaded chunks as blocked). None of this touches `Game.js`, `Player.js`, `RenderSystem.js`, or `Map.js` — Phase 4b wires it in and replaces the loop.

**Tech Stack:** Frontend ES modules (`frontend/src/games/something2/src/js/`), Vitest (`npm run test` from `frontend/`). No new dependencies.

## Global Constraints

- **ES modules**; no new deps; Vitest already configured.
- **Additive only.** Create new modules + tests, and append tests to existing test files. Do **not** modify `Game.js`, `Player.js`, `RenderSystem.js`, `Map.js`, `Camera.js`, or `constants.js`. (`worldCoords.js` gains one new export — `parseKey` — which is additive and safe.) Live-loop replacement is Phase 4b.
- **Reuse Phase 1–3 primitives:** `chunkOf`, `CHUNK_KEY`, `worldToChunkLocal` from `core/worldCoords.js`; `ChunkedMap` from `core/ChunkedMap.js`. The chunk-ownership rule is fixed by Phase 1 and must not be re-derived.
- **Negative coordinates supported** everywhere (chunks/tiles exist at negative positions).
- **`ChunkStreamer.fetchChunk` is injected** — `async (cx, cy) => string[][]` (a chunk grid). The real HTTP/TanStack-backed fetch is wired in Phase 4b; 4a tests use a fake. This keeps 4a headless and deterministic.
- **`resolveMove` delegates collision to the map** via `map.isWalkable(worldX, worldY)` and `map.speedAt(worldX, worldY)` (the `ChunkedMap` interface). It does **not** re-implement tile lookups, does **not** clamp to `WORLD_WIDTH/HEIGHT` (the world is infinite — the legacy clamp in `Player.update` is a finite-world artifact that Phase 4b drops), and does **not** handle entity collision (world-space creatures are Phase 5).
- Commit after every task.

## File Structure

- **Modify:** `core/worldCoords.js` — add `parseKey`. `core/__tests__/worldCoords.test.js` — append `parseKey` tests.
- **Modify:** `core/__tests__/ChunkedMap.test.js` — append the missing mixed-`cx`/`cy` neighborhood test (Phase-3 carry-forward).
- **Create:** `core/NeighborhoodManager.js` + `core/__tests__/NeighborhoodManager.test.js`.
- **Create:** `net/ChunkStreamer.js` + `net/__tests__/ChunkStreamer.test.js`.
- **Create:** `systems/movement.js` (`resolveMove`) + `systems/__tests__/movement.test.js`.

---

### Task 1: `parseKey` + Phase-3 carry-forward tests

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/worldCoords.js` (add `parseKey`)
- Modify: `frontend/src/games/something2/src/js/core/__tests__/worldCoords.test.js` (append)
- Modify: `frontend/src/games/something2/src/js/core/__tests__/ChunkedMap.test.js` (append one test)

**Interfaces:**
- Produces: `parseKey(key: string) -> { cx, cy }` — inverse of `CHUNK_KEY`; handles negatives. `parseKey(CHUNK_KEY(a,b))` round-trips.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/games/something2/src/js/core/__tests__/worldCoords.test.js`:
```js
import { parseKey } from "../worldCoords.js";

describe("parseKey", () => {
  it("is the inverse of CHUNK_KEY, incl. negatives", () => {
    for (const [cx, cy] of [[0, 0], [3, -2], [-5, 7], [-1, -1]]) {
      expect(parseKey(CHUNK_KEY(cx, cy))).toEqual({ cx, cy });
    }
  });
});
```
Append to `frontend/src/games/something2/src/js/core/__tests__/ChunkedMap.test.js` (closes the Phase-3 coverage gap — a chunk offset in BOTH axes, resolved at an off-diagonal local cell so an lr/lc transpose would be caught):
```js
describe("ChunkedMap resolves a chunk offset in both cx and cy", () => {
  it("indexes grid[lr][lc] correctly for chunk (2,-1) at an off-diagonal cell", () => {
    const m = new ChunkedMap(N);
    // grid[lr][lc] = `Q-<lr><lc>`
    m.setChunk(2, -1, Array.from({ length: N }, (_, r) =>
      Array.from({ length: N }, (_, c) => `Q-${r}${c}`)));
    // world px inside chunk (2,-1): cx*N*T .. , choose local (lr=1, lc=3):
    // gCol = 2*N + 3, gRow = -1*N + 1 ; worldX = gCol*T + 1, worldY = gRow*T + 1
    const worldX = (2 * N + 3) * T + 1;
    const worldY = (-1 * N + 1) * T + 1;
    expect(m.getTileAt(worldX, worldY)).toBe("Q-13"); // lr=1, lc=3 (NOT "Q-31")
  });
});
```
(`N`, `T` are already defined at the top of `ChunkedMap.test.js`.)

- [ ] **Step 2: Run to verify failure**

Run from `frontend/`: `npm run test -- worldCoords ChunkedMap`
Expected: FAIL — `parseKey` unresolved; the new ChunkedMap test can't run until `parseKey` import resolves in the shared module (both files import from `worldCoords.js`). (If the ChunkedMap test fails only on the transpose assertion, that would signal a real bug — investigate; but it should pass once it runs, since Phase 3 is correct.)

- [ ] **Step 3: Implement `parseKey`**

Add to `frontend/src/games/something2/src/js/core/worldCoords.js`:
```js
// Inverse of CHUNK_KEY: "cx,cy" -> { cx, cy }. Handles negative indices.
export function parseKey(key) {
  const [cx, cy] = key.split(",").map(Number);
  return { cx, cy };
}
```

- [ ] **Step 4: Run to verify passing**

Run from `frontend/`: `npm run test -- worldCoords ChunkedMap`
Expected: PASS. Then full `npm run test` — all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/worldCoords.js frontend/src/games/something2/src/js/core/__tests__/worldCoords.test.js frontend/src/games/something2/src/js/core/__tests__/ChunkedMap.test.js
git commit -m "feat(chunkedworld): parseKey + close Phase-3 test gaps (SOMET-57)"
```

---

### Task 2: `NeighborhoodManager` — ring math

**Files:**
- Create: `frontend/src/games/something2/src/js/core/NeighborhoodManager.js`
- Create: `frontend/src/games/something2/src/js/core/__tests__/NeighborhoodManager.test.js`

**Interfaces:**
- Consumes: `CHUNK_KEY` from `./worldCoords.js`.
- Produces:
  - `neighborhoodKeys(cx, cy, radius = 1) -> string[]` — the `(2·radius+1)²` chunk keys centered on `(cx, cy)` (e.g. radius 1 → 9 keys), each via `CHUNK_KEY`. Order is deterministic (row-major, dy outer, dx inner).
  - `diffNeighborhoods(prevKeys, nextKeys) -> { toLoad, toDrop }` — `toLoad` = in `next` not in `prev`; `toDrop` = in `prev` not in `next`. Arrays of keys.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/core/__tests__/NeighborhoodManager.test.js`:
```js
import { describe, it, expect } from "vitest";
import { neighborhoodKeys, diffNeighborhoods } from "../NeighborhoodManager.js";

describe("neighborhoodKeys", () => {
  it("returns the 3x3 block around the center for radius 1", () => {
    const keys = neighborhoodKeys(0, 0, 1);
    expect(keys.length).toBe(9);
    expect(new Set(keys)).toEqual(new Set([
      "-1,-1", "0,-1", "1,-1",
      "-1,0", "0,0", "1,0",
      "-1,1", "0,1", "1,1",
    ]));
  });

  it("centers on negative coordinates too", () => {
    const keys = neighborhoodKeys(-2, 3, 1);
    expect(keys).toContain("-2,3");   // center
    expect(keys).toContain("-3,2");   // corner
    expect(keys).toContain("-1,4");   // opposite corner
    expect(keys.length).toBe(9);
  });

  it("radius 0 is a single chunk; radius 2 is 25", () => {
    expect(neighborhoodKeys(5, 5, 0)).toEqual(["5,5"]);
    expect(neighborhoodKeys(0, 0, 2).length).toBe(25);
  });
});

describe("diffNeighborhoods", () => {
  it("splits into load (new) and drop (gone), keeping the overlap", () => {
    const prev = neighborhoodKeys(0, 0, 1);
    const next = neighborhoodKeys(1, 0, 1); // stepped one chunk east
    const { toLoad, toDrop } = diffNeighborhoods(prev, next);
    // moving east: load the new east column (cx=2), drop the old west column (cx=-1)
    expect(new Set(toLoad)).toEqual(new Set(["2,-1", "2,0", "2,1"]));
    expect(new Set(toDrop)).toEqual(new Set(["-1,-1", "-1,0", "-1,1"]));
  });

  it("identical neighborhoods diff to nothing", () => {
    const n = neighborhoodKeys(3, -4, 1);
    expect(diffNeighborhoods(n, n)).toEqual({ toLoad: [], toDrop: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run from `frontend/`: `npm run test -- NeighborhoodManager`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Implement**

Create `frontend/src/games/something2/src/js/core/NeighborhoodManager.js`:
```js
import { CHUNK_KEY } from "./worldCoords.js";

// The (2*radius+1)^2 chunk keys centered on (cx,cy). Row-major (dy outer).
export function neighborhoodKeys(cx, cy, radius = 1) {
  const keys = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      keys.push(CHUNK_KEY(cx + dx, cy + dy));
    }
  }
  return keys;
}

// Which keys are newly needed (toLoad) and which are no longer needed (toDrop).
export function diffNeighborhoods(prevKeys, nextKeys) {
  const prev = new Set(prevKeys);
  const next = new Set(nextKeys);
  const toLoad = nextKeys.filter((k) => !prev.has(k));
  const toDrop = prevKeys.filter((k) => !next.has(k));
  return { toLoad, toDrop };
}
```

- [ ] **Step 4: Run to verify passing**

Run from `frontend/`: `npm run test -- NeighborhoodManager`
Expected: PASS. Then full `npm run test` — all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/NeighborhoodManager.js frontend/src/games/something2/src/js/core/__tests__/NeighborhoodManager.test.js
git commit -m "feat(chunkedworld): neighborhood ring math (SOMET-57)"
```

---

### Task 3: `ChunkStreamer` — load/drop the neighborhood as the player moves

**Files:**
- Create: `frontend/src/games/something2/src/js/net/ChunkStreamer.js`
- Create: `frontend/src/games/something2/src/js/net/__tests__/ChunkStreamer.test.js`

**Interfaces:**
- Consumes: `chunkOf`, `CHUNK_KEY`, `parseKey` from `../core/worldCoords.js`; `neighborhoodKeys`, `diffNeighborhoods` from `../core/NeighborhoodManager.js`; a `ChunkedMap` instance; an injected `fetchChunk(cx, cy) -> Promise<string[][]>`.
- Produces: `class ChunkStreamer`:
  - `constructor(chunkedMap, fetchChunk, radius = 1)`.
  - `async update(worldX, worldY)` — resolves the player's center chunk; if it changed since the last `update`, diffs old→new neighborhoods, `removeChunk`s the drops, and `fetchChunk`+`setChunk`s the loads (skipping chunks already loaded or in-flight). Returns `{ loaded: string[], dropped: string[] }` for observability/tests. On the first call it loads the full neighborhood.
  - De-dup: never issues a second fetch for a key already loaded or in-flight; a fetch that rejects is swallowed (logged) and the key is left unloaded so a later `update` can retry.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/net/__tests__/ChunkStreamer.test.js`:
```js
import { describe, it, expect } from "vitest";
import { ChunkStreamer } from "../ChunkStreamer.js";
import { ChunkedMap } from "../../core/ChunkedMap.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

const N = 4;                       // tiles per chunk
const CHUNK_PX = N * MAP_TILE_SIZE; // px per chunk

// fake fetch: records requested keys, returns a grid tagged with its coords.
function makeFetch() {
  const requested = [];
  const fetchChunk = async (cx, cy) => {
    requested.push(`${cx},${cy}`);
    return Array.from({ length: N }, () => Array.from({ length: N }, () => `t-${cx}-${cy}`));
  };
  return { fetchChunk, requested };
}

it("loads the full 3x3 neighborhood on first update", async () => {
  const map = new ChunkedMap(N);
  const { fetchChunk, requested } = makeFetch();
  const s = new ChunkStreamer(map, fetchChunk, 1);
  const res = await s.update(0, 0); // center chunk (0,0)
  expect(map.loadedKeys().length).toBe(9);
  expect(new Set(requested)).toEqual(new Set([
    "-1,-1", "0,-1", "1,-1", "-1,0", "0,0", "1,0", "-1,1", "0,1", "1,1",
  ]));
  expect(res.loaded.length).toBe(9);
  expect(res.dropped.length).toBe(0);
});

it("does nothing while the player stays in the same chunk", async () => {
  const map = new ChunkedMap(N);
  const { fetchChunk, requested } = makeFetch();
  const s = new ChunkStreamer(map, fetchChunk, 1);
  await s.update(0, 0);
  const before = requested.length;
  const res = await s.update(MAP_TILE_SIZE, MAP_TILE_SIZE); // still chunk (0,0)
  expect(requested.length).toBe(before); // no new fetches
  expect(res.loaded.length).toBe(0);
});

it("streams the new ring and drops the far ring when crossing a seam", async () => {
  const map = new ChunkedMap(N);
  const { fetchChunk, requested } = makeFetch();
  const s = new ChunkStreamer(map, fetchChunk, 1);
  await s.update(0, 0);                 // center (0,0)
  requested.length = 0;                 // reset
  const res = await s.update(CHUNK_PX, 0); // step east into chunk (1,0)
  expect(new Set(res.loaded)).toEqual(new Set(["2,-1", "2,0", "2,1"]));
  expect(new Set(res.dropped)).toEqual(new Set(["-1,-1", "-1,0", "-1,1"]));
  // only the new column was fetched; the shared 6 chunks were not re-fetched.
  expect(new Set(requested)).toEqual(new Set(["2,-1", "2,0", "2,1"]));
  expect(map.hasChunk(-1, 0)).toBe(false); // dropped
  expect(map.hasChunk(2, 0)).toBe(true);   // loaded
  expect(map.loadedKeys().length).toBe(9);
});

it("handles negative-chunk neighborhoods", async () => {
  const map = new ChunkedMap(N);
  const { fetchChunk } = makeFetch();
  const s = new ChunkStreamer(map, fetchChunk, 1);
  await s.update(-CHUNK_PX - 1, -CHUNK_PX - 1); // some negative chunk
  expect(map.loadedKeys().length).toBe(9);
});

it("does not re-fetch an already-loaded chunk", async () => {
  const map = new ChunkedMap(N);
  const { fetchChunk, requested } = makeFetch();
  const s = new ChunkStreamer(map, fetchChunk, 1);
  await s.update(0, 0);
  // Move east then back west: the chunks around (0,0) that survived are not re-fetched.
  await s.update(CHUNK_PX, 0);
  requested.length = 0;
  await s.update(0, 0); // back to center (0,0); its neighborhood chunks (0,*) etc still loaded
  // only the re-entered west column (-1,*) should be fetched, not the whole 3x3.
  expect(new Set(requested)).toEqual(new Set(["-1,-1", "-1,0", "-1,1"]));
});
```

- [ ] **Step 2: Run to verify failure**

Run from `frontend/`: `npm run test -- ChunkStreamer`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Implement**

Create `frontend/src/games/something2/src/js/net/ChunkStreamer.js`:
```js
import { chunkOf, CHUNK_KEY, parseKey } from "../core/worldCoords.js";
import { neighborhoodKeys, diffNeighborhoods } from "../core/NeighborhoodManager.js";

// Keeps a ChunkedMap populated with the (2*radius+1)^2 neighborhood around the
// player. Fetching is injected (async fetchChunk(cx,cy) -> grid) so this is
// transport-agnostic and unit-testable. Phase 4b supplies a real HTTP/TanStack
// fetch; Phase 4b also calls update() from the game loop.
export class ChunkStreamer {
  constructor(chunkedMap, fetchChunk, radius = 1) {
    this.map = chunkedMap;
    this.fetchChunk = fetchChunk;
    this.radius = radius;
    this.centerKey = null;     // last center chunk "cx,cy"
    this.inflight = new Set(); // keys currently being fetched
  }

  async update(worldX, worldY) {
    const { cx, cy } = chunkOf(worldX, worldY, this.map.chunkSize);
    const key = CHUNK_KEY(cx, cy);
    if (key === this.centerKey) return { loaded: [], dropped: [] };

    const prev = this.centerKey
      ? neighborhoodKeys(...Object.values(parseKey(this.centerKey)), this.radius)
      : [];
    const next = neighborhoodKeys(cx, cy, this.radius);
    this.centerKey = key;

    const { toLoad, toDrop } = diffNeighborhoods(prev, next);

    for (const k of toDrop) {
      const { cx: dcx, cy: dcy } = parseKey(k);
      this.map.removeChunk(dcx, dcy);
    }

    const loaded = [];
    await Promise.all(
      toLoad.map(async (k) => {
        const { cx: lcx, cy: lcy } = parseKey(k);
        if (this.map.hasChunk(lcx, lcy) || this.inflight.has(k)) return;
        this.inflight.add(k);
        try {
          const grid = await this.fetchChunk(lcx, lcy);
          this.map.setChunk(lcx, lcy, grid);
          loaded.push(k);
        } catch (err) {
          // Leave unloaded; a later update() retries. Don't crash the loop.
          console.error(`ChunkStreamer: failed to load ${k}`, err);
        } finally {
          this.inflight.delete(k);
        }
      }),
    );

    return { loaded, dropped: toDrop };
  }
}
```
Note: `neighborhoodKeys(...Object.values(parseKey(key)), radius)` — `parseKey` returns `{cx,cy}`; `Object.values` yields `[cx, cy]` in insertion order (cx first, cy second, matching the object literal), spread as the first two args. This is correct for the object shape defined in Task 1.

- [ ] **Step 4: Run to verify passing**

Run from `frontend/`: `npm run test -- ChunkStreamer`
Expected: PASS (all 5). Then full `npm run test` — all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/net/ChunkStreamer.js frontend/src/games/something2/src/js/net/__tests__/ChunkStreamer.test.js
git commit -m "feat(chunkedworld): ChunkStreamer neighborhood load/unload (SOMET-57)"
```

---

### Task 4: `resolveMove` — map-agnostic movement/collision against the loaded world

**Files:**
- Create: `frontend/src/games/something2/src/js/systems/movement.js`
- Create: `frontend/src/games/something2/src/js/systems/__tests__/movement.test.js`

**Interfaces:**
- Consumes: a map with `isWalkable(worldX, worldY) -> boolean` and `speedAt(worldX, worldY) -> number` (the `ChunkedMap` interface).
- Produces: `resolveMove(map, actor, dirX, dirY, dt) -> { x, y, moved }` where `actor = { x, y, width, height, speed }`. Pure (returns a new position, does not mutate `actor`). Normalizes the direction, scales the step by `speed * dt * speedAt(center)`, tests each axis independently at the actor's center against `map.isWalkable`, and moves only on axes that are walkable. **No world-bounds clamp** (infinite world) and **no entity collision** (Phase 5). Delegating to `map.isWalkable` means an unloaded chunk (`ChunkedMap.isWalkable` → `false`) blocks movement — the streaming frontier.

**Note:** this mirrors the per-axis tile logic of the legacy `Player.update` but is map-agnostic and free of the finite-world clamp and the inline `null → walkable` rule. Phase 4b rewires `Player.update` (or `Game`) to call `resolveMove` against the streamed `ChunkedMap`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/systems/__tests__/movement.test.js`:
```js
import { describe, it, expect } from "vitest";
import { resolveMove } from "../movement.js";
import { ChunkedMap } from "../../core/ChunkedMap.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

const N = 4;
const T = MAP_TILE_SIZE;
const DEFS = { grass: { walkable: true, speed: 1 }, water: { walkable: false, speed: 1 }, mud: { walkable: true, speed: 0.5 } };

function mapWith(rows) {
  const m = new ChunkedMap(N, DEFS);
  m.setChunk(0, 0, rows);
  return m;
}
const allGrass = () => Array.from({ length: N }, () => Array(N).fill("grass"));

// actor sized so its center is inside chunk (0,0)
const actor = () => ({ x: 10, y: 10, width: 20, height: 20, speed: 100 });

it("moves on grass in the requested direction", () => {
  const m = mapWith(allGrass());
  const r = resolveMove(m, actor(), 1, 0, 1); // 1 second east
  expect(r.x).toBeGreaterThan(10);
  expect(r.y).toBe(10);
  expect(r.moved).toBe(true);
});

it("is blocked by a water tile on that axis", () => {
  // Put water at local (0,1) so a step east from center of (0,0) hits it.
  const rows = allGrass();
  rows[0][1] = "water";
  const m = mapWith(rows);
  // actor center near right edge of tile (0,0) so a small east step crosses into (0,1)
  const a = { x: T - 30, y: 10, width: 20, height: 20, speed: 100 };
  const r = resolveMove(m, a, 1, 0, 1);
  expect(r.x).toBe(a.x); // blocked east
});

it("scales step by the current tile's speed", () => {
  const fast = resolveMove(mapWith(allGrass()), actor(), 1, 0, 1).x - 10;
  const rows = allGrass(); rows[0][0] = "mud"; // mud under the actor's center
  const slow = resolveMove(mapWith(rows), actor(), 1, 0, 1).x - 10;
  expect(slow).toBeCloseTo(fast * 0.5, 5);
});

it("normalizes diagonal movement (no speed boost)", () => {
  const straight = resolveMove(mapWith(allGrass()), actor(), 1, 0, 1).x - 10;
  const diag = resolveMove(mapWith(allGrass()), actor(), 1, 1, 1);
  const dist = Math.hypot(diag.x - 10, diag.y - 10);
  expect(dist).toBeCloseTo(straight, 5);
});

it("is blocked when stepping into an unloaded chunk (streaming frontier)", () => {
  const m = mapWith(allGrass()); // only chunk (0,0) loaded
  // actor near the east edge of chunk (0,0); a step east crosses into chunk (1,0), unloaded.
  const a = { x: N * T - 30, y: 10, width: 20, height: 20, speed: 100 };
  const r = resolveMove(m, a, 1, 0, 1);
  expect(r.x).toBe(a.x); // blocked at the frontier
});

it("does not mutate the actor", () => {
  const a = actor();
  resolveMove(mapWith(allGrass()), a, 1, 0, 1);
  expect(a.x).toBe(10);
  expect(a.y).toBe(10);
});
```

- [ ] **Step 2: Run to verify failure**

Run from `frontend/`: `npm run test -- movement`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Implement**

Create `frontend/src/games/something2/src/js/systems/movement.js`:
```js
// Map-agnostic movement/collision resolution. Delegates walkability + speed to
// the map (ChunkedMap: isWalkable / speedAt), so an unloaded chunk blocks
// movement (streaming frontier). Pure: returns a new {x,y,moved}, never mutates
// the actor. No world-bounds clamp (infinite world) and no entity collision
// (Phase 5). Mirrors the per-axis tile logic of the legacy Player.update.
export function resolveMove(map, actor, dirX, dirY, dt) {
  if (dirX === 0 && dirY === 0) return { x: actor.x, y: actor.y, moved: false };

  // Normalize so diagonal isn't faster.
  const len = Math.hypot(dirX, dirY);
  const nx = dirX / len;
  const ny = dirY / len;

  const cx = actor.x + actor.width / 2;
  const cy = actor.y + actor.height / 2;

  const tileSpeed = map.speedAt(cx, cy);
  const stepX = nx * actor.speed * dt * tileSpeed;
  const stepY = ny * actor.speed * dt * tileSpeed;

  let x = actor.x;
  let y = actor.y;
  let moved = false;

  // Test each axis independently at the (moved) center.
  if (stepX !== 0 && map.isWalkable(cx + stepX, cy)) {
    x += stepX;
    moved = true;
  }
  if (stepY !== 0 && map.isWalkable(cx, cy + stepY)) {
    y += stepY;
    moved = true;
  }

  return { x, y, moved };
}
```

- [ ] **Step 4: Run to verify passing**

Run from `frontend/`: `npm run test -- movement`
Expected: PASS (all 6). Then full `npm run test` — all green. Then `npm run lint` — no new errors in the added files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/movement.js frontend/src/games/something2/src/js/systems/__tests__/movement.test.js
git commit -m "feat(chunkedworld): map-agnostic movement/collision resolver (SOMET-57)"
```

---

## Self-Review

**Spec coverage (Phase 4 "streaming + collision" half; render + UI are Phase 4b):**
- "client keeps a 3×3 chunk neighborhood; load newly-adjacent ring, drop the far ring" → Task 2 (ring math) + Task 3 (ChunkStreamer load/drop). ✓
- "collision/prediction works over seams" → Task 4 (`resolveMove` delegates to `ChunkedMap.isWalkable`/`speedAt`, tested across a seam and at an unloaded frontier). ✓
- Fetch is injected → real TanStack/HTTP fetch + calling `update()`/`resolveMove` from the game loop + rendering are **Phase 4b**. ✓ (Explicitly out of scope here.)

**Phase-3 carry-forwards cleared:**
- (2) `parseKey` helper for render-loop key parsing → Task 1. ✓
- (3) mixed-`cx`/`cy` `ChunkedMap` test → Task 1. ✓
- (1) `Player.update` inline `null → walkable` → addressed structurally: `resolveMove` (Task 4) delegates to `ChunkedMap.isWalkable` (unloaded → blocked). The actual `Player.update`/`Game` rewire to use `resolveMove` is Phase 4b (it modifies the live loop, out of 4a's additive scope) — flagged for 4b.

**Placeholder scan:** No TBD/TODO/vague steps; complete code + assertions throughout. ✓

**Type/name consistency:** `parseKey(key) -> {cx,cy}` (Task 1) consumed in Task 3 (`Object.values` → `[cx,cy]`). `neighborhoodKeys`/`diffNeighborhoods` (Task 2) consumed in Task 3. `ChunkedMap` interface (`chunkSize`, `loadedKeys`, `hasChunk`, `setChunk`, `removeChunk`, `isWalkable`, `speedAt`) used by Tasks 3–4 matches Phase 3. `CHUNK_KEY`/`chunkOf`/`chunkOf` from `worldCoords`. `resolveMove(map, actor, dirX, dirY, dt) -> {x,y,moved}` is self-contained. ✓

## Out of scope for this plan (Phase 4b + Phase 5, separate plans)
- Real HTTP/TanStack-Query `fetchChunk` (`GET /api/worlds/:id/chunk`) → Phase 4b.
- Rewiring `Game.js`/`Player.update` to call `ChunkStreamer.update` + `resolveMove` against a streamed `ChunkedMap`, and **removing the legacy single-map play path + the `WORLD_WIDTH/HEIGHT` clamp** (per the "replace the game loop with chunked" decision) → Phase 4b.
- Multi-chunk isometric rendering (iterate `loadedKeys()`, `worldToScreen`, depth-sort across seams) → Phase 4b.
- World-entry UI (select/create world → enter chunked game) → Phase 4b.
- Live browser verification of seam-crossing → Phase 4b.
- World-space free-roaming creatures + entity collision → Phase 5.
