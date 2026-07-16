# Connected Chunked World — Phase 4b (Render + UI + Live Wire) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chunked world playable: fetch chunks from the backend, stream a 3×3 neighborhood around the player each frame, collide against it, render all loaded chunks in isometric, and enter it from a world-select UI — verified live by walking across a seam with no reposition. (SOMET-57, part b)

**Architecture:** A chunked **mode** is added to the existing `Game` (a `chunked` flag): `initChunked({worldId, chunkSize, tileTypes, spawn})` builds a `ChunkedMap` + `ChunkStreamer` (from Phase 3/4a) with a real HTTP `fetchChunk`, seeds the neighborhood, and runs the loop against them. `Player.update` gains a chunked branch — when the map exposes `isWalkable`, it delegates to `resolveMove` (Phase 4a) with no world-bounds clamp; the legacy single-`Map` path is left intact for the editors. `RenderSystem` gains a chunked render path that iterates loaded chunks and draws each tile as an iso diamond (mirroring `Map.render`). A new "Worlds" panel in `Something2.jsx` lists/creates worlds (`GET/POST /api/worlds`) and enters chunked play. Legacy map-based play code stays but the primary play entry becomes chunked.

**Tech Stack:** Frontend ES modules + React 19, Vitest (`npm run test` from `frontend/`), TanStack Query (already used). Backend already provides `GET /api/worlds/:id/chunk` + `GET/POST /api/worlds` (Phase 2). No new dependencies.

## Global Constraints

- **ES modules** (game js) / **React** (jsx). No new deps.
- **Reuse Phase 3/4a primitives unchanged:** `ChunkedMap`, `worldCoords` (`chunkOf`, `chunkOrigin`, `parseKey`, `CHUNK_KEY`, `worldToChunkLocal`), `NeighborhoodManager`, `ChunkStreamer`, `resolveMove`. Do not reimplement chunk math.
- **`fetchChunk` returns the bare grid.** `GET /api/worlds/:id/chunk?cx=&cy=` returns `{ world_id, cx, cy, data }`; the fetcher must return `data` (a `string[][]`), never the envelope.
- **No world-bounds clamp on the chunked path.** The world is infinite; the streaming frontier (unloaded chunk → `ChunkedMap.isWalkable` false) is the only boundary. The legacy `WORLD_WIDTH/HEIGHT` clamp stays only on the legacy path.
- **Don't break the editors or legacy Map.** `Player.update`, `RenderSystem.render`, `Game` keep their legacy branches working (the tile/entity editors and any legacy map play must still function). Chunked behavior is added as a branch, selected by mode/interface — not by deleting the legacy code.
- **`ChunkStreamer.update` is called fire-and-forget** each frame (its Phase-4a `wanted`-guard makes that safe); the render reads whatever chunks are currently loaded.
- **Entity/creature simulation is out of scope** (Phase 5). Chunked mode renders tiles + the local player (+ remote players if an engine is attached, unchanged); no world objects yet.
- Commit after every task. Visual tasks (render, UI) are verified in the browser in the final task; pure logic is unit-tested per task.

## File Structure

- **Create:** `frontend/src/games/something2/useWorlds.js` (TanStack hooks) + `net/chunkFetcher.js` (`makeChunkFetcher`) + tests.
- **Modify:** `entities/Player.js` (chunked branch via `resolveMove`).
- **Modify:** `core/Game.js` (chunked mode: `initChunked`, update/render branches).
- **Modify:** `systems/RenderSystem.js` (chunked tile render) + a pure `core/chunkTiles.js` helper (+ test).
- **Modify:** `Something2.jsx` (Worlds panel → enter chunked play).

---

### Task 1: Real chunk fetcher + world hooks

**Files:**
- Create: `frontend/src/games/something2/src/js/net/chunkFetcher.js`
- Create: `frontend/src/games/something2/src/js/net/__tests__/chunkFetcher.test.js`
- Create: `frontend/src/games/something2/useWorlds.js`

**Interfaces:**
- Produces:
  - `makeChunkFetcher(worldId, apiUrl, fetchImpl = fetch) -> async (cx, cy) => string[][]` — GETs `${apiUrl}/api/worlds/${worldId}/chunk?cx=${cx}&cy=${cy}`, throws on `!res.ok`, returns the parsed `data` grid (the bare `string[][]`, unwrapped from the `{world_id,cx,cy,data}` envelope). `fetchImpl` is injectable for tests.
  - `useWorlds.js`: `useWorlds()` (query `GET /api/worlds`), `useCreateWorld()` (mutation `POST /api/worlds`), following the `useMaps.js` pattern (`import.meta.env.VITE_API_URL`, toast, invalidate `['worlds']`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/net/__tests__/chunkFetcher.test.js`:
```js
import { describe, it, expect } from "vitest";
import { makeChunkFetcher } from "../chunkFetcher.js";

function fakeFetch(response, ok = true) {
  return async (url) => ({ ok, url, json: async () => response });
}

describe("makeChunkFetcher", () => {
  it("returns the bare data grid, not the envelope", async () => {
    const grid = [["grass", "grass"], ["dirt", "water"]];
    const fetchImpl = fakeFetch({ world_id: "w1", cx: 2, cy: -1, data: grid });
    const fetchChunk = makeChunkFetcher("w1", "http://api", fetchImpl);
    const out = await fetchChunk(2, -1);
    expect(out).toEqual(grid); // NOT { data: grid, ... }
  });

  it("builds the correct URL incl. negative coords", async () => {
    let seen = null;
    const fetchImpl = async (url) => { seen = url; return { ok: true, json: async () => ({ data: [] }) }; };
    const fetchChunk = makeChunkFetcher("abc", "http://api", fetchImpl);
    await fetchChunk(-3, 4);
    expect(seen).toBe("http://api/api/worlds/abc/chunk?cx=-3&cy=4");
  });

  it("throws on a non-ok response", async () => {
    const fetchChunk = makeChunkFetcher("w1", "http://api", fakeFetch({}, false));
    await expect(fetchChunk(0, 0)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run from `frontend/`: `npm run test -- chunkFetcher`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Implement**

Create `frontend/src/games/something2/src/js/net/chunkFetcher.js`:
```js
// Builds an async fetchChunk(cx,cy) -> string[][] for a specific world, hitting
// the Phase 2 chunk API and unwrapping the `data` grid from the response
// envelope. fetchImpl is injectable for tests. The backend caches chunks in
// world_chunks, so repeat requests are cheap; ChunkStreamer + ChunkedMap avoid
// re-requesting currently-loaded chunks.
export function makeChunkFetcher(worldId, apiUrl, fetchImpl = fetch) {
  return async function fetchChunk(cx, cy) {
    const url = `${apiUrl}/api/worlds/${worldId}/chunk?cx=${cx}&cy=${cy}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`chunk fetch failed (${cx},${cy})`);
    const body = await res.json();
    return body.data;
  };
}
```
Create `frontend/src/games/something2/useWorlds.js`:
```js
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

export function useWorlds() {
  const { data: worlds, isLoading: isLoadingWorlds } = useQuery({
    queryKey: ["worlds"],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/worlds`);
      if (!res.ok) throw new Error("Failed to fetch worlds");
      return res.json();
    },
  });
  return { worlds, isLoadingWorlds };
}

export function useCreateWorld() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, seed, chunk_size }) => {
      const res = await fetch(`${API_URL}/api/worlds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, seed, chunk_size }),
      });
      if (!res.ok) throw new Error("Failed to create world");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["worlds"] });
      toast.success("World created");
    },
    onError: (e) => toast.error(e.message),
  });
}
```

- [ ] **Step 4: Run to verify passing**

Run from `frontend/`: `npm run test -- chunkFetcher`
Expected: PASS (3). Then full `npm run test` — all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/net/chunkFetcher.js frontend/src/games/something2/src/js/net/__tests__/chunkFetcher.test.js frontend/src/games/something2/useWorlds.js
git commit -m "feat(chunkedworld): chunk fetcher + world hooks (SOMET-57)"
```

---

### Task 2: `Player.update` chunked branch (delegate to `resolveMove`)

**Files:**
- Modify: `frontend/src/games/something2/src/js/entities/Player.js`
- Create: `frontend/src/games/something2/src/js/entities/__tests__/Player.chunked.test.js`

**Interfaces:**
- Behavior: when `map` exposes `isWalkable` (i.e. a `ChunkedMap`), `Player.update` computes the input direction and delegates to `resolveMove(map, this, dx, dy, dt)`, applying the returned `{x, y}` with **no** `WORLD_WIDTH/HEIGHT` clamp and no entity collision (Phase 5). When `map` does not expose `isWalkable` (legacy `Map`), the existing inline collision + clamp path runs unchanged.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/entities/__tests__/Player.chunked.test.js`:
```js
import { describe, it, expect } from "vitest";
import { Player } from "../Player.js";
import { ChunkedMap } from "../../core/ChunkedMap.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

const N = 4;
const T = MAP_TILE_SIZE;
const DEFS = { grass: { walkable: true, speed: 1 }, water: { walkable: false } };
const allGrass = () => Array.from({ length: N }, () => Array(N).fill("grass"));

function chunkedMapWith(cx, cy, grid) {
  const m = new ChunkedMap(N, DEFS);
  m.setChunk(cx, cy, grid);
  return m;
}

describe("Player.update chunked branch", () => {
  it("moves via resolveMove on a ChunkedMap (no world clamp)", () => {
    const m = chunkedMapWith(0, 0, allGrass());
    const p = new Player();
    p.x = 50; p.y = 50; p.width = 20; p.height = 20; p.speed = 100; p.speedMultiplier = 1;
    const before = p.x;
    p.update(0.1, { d: true }, m); // move east
    expect(p.x).toBeGreaterThan(before);
    expect(p.y).toBe(50);
  });

  it("is blocked at an unloaded chunk frontier", () => {
    const m = chunkedMapWith(0, 0, allGrass()); // only (0,0) loaded
    const p = new Player();
    // place near east edge of chunk (0,0); a step east enters unloaded (1,0)
    p.x = N * T - 30; p.y = 50; p.width = 20; p.height = 20; p.speed = 100; p.speedMultiplier = 1;
    const before = p.x;
    p.update(1, { d: true }, m); // big dt, tries to cross frontier
    expect(p.x).toBe(before); // blocked
  });

  it("can move to negative world coordinates (no clamp to 0)", () => {
    const m = chunkedMapWith(-1, 0, allGrass()); // chunk (-1,0) loaded
    const p = new Player();
    p.x = 5; p.y = 50; p.width = 20; p.height = 20; p.speed = 100; p.speedMultiplier = 1;
    p.update(0.1, { a: true }, m); // move west, toward negative x
    expect(p.x).toBeLessThan(5); // not clamped at 0
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run from `frontend/`: `npm run test -- Player.chunked`
Expected: FAIL — the current `Player.update` clamps to `[0, WORLD_WIDTH]` (so the negative-move test fails) and doesn't use `resolveMove`.

- [ ] **Step 3: Implement the chunked branch**

In `frontend/src/games/something2/src/js/entities/Player.js`, add the import at the top:
```js
import { resolveMove } from "../systems/movement.js";
```
Then at the **start of the `update(dt, keys, map)` body**, before the existing logic, insert the chunked branch:
```js
    update(dt, keys, map){
        let dx = 0, dy = 0;
        if(keys['w'] || keys['arrowup']) dy -= 1;
        if(keys['s'] || keys['arrowdown']) dy += 1;
        if(keys['a'] || keys['arrowleft']) dx -= 1;
        if(keys['d'] || keys['arrowright']) dx += 1;

        // Chunked world: delegate collision to the ChunkedMap via resolveMove.
        // No world-bounds clamp (infinite world); the streaming frontier
        // (unloaded chunk -> isWalkable false) is the only boundary.
        if (map && typeof map.isWalkable === 'function') {
            if (dx !== 0 || dy !== 0) {
                const speed = this.speed * (this.speedMultiplier || 1);
                const r = resolveMove(map, { x: this.x, y: this.y, width: this.width, height: this.height, speed }, dx, dy, dt);
                this.x = r.x;
                this.y = r.y;
            }
            return;
        }

        // --- legacy single-Map path (unchanged) ---
        if(dx !== 0 || dy !== 0){
            // ... existing normalize/collision/clamp code stays exactly as-is ...
```
Keep everything from the existing `if(dx !== 0 || dy !== 0){` block onward **unchanged** (the legacy path). Only the two `dx/dy` computation lines are hoisted above the new branch (delete the duplicate `let dx=0,dy=0` + key checks that were originally inside — they now live at the top). Verify by reading the file that the legacy branch still computes movement + clamp identically.

- [ ] **Step 4: Run to verify passing**

Run from `frontend/`: `npm run test -- Player.chunked`
Expected: PASS (3). Then full `npm run test` (legacy Player behavior covered by existing tests, if any, still green) and `npm run lint` (no new errors).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/entities/Player.js frontend/src/games/something2/src/js/entities/__tests__/Player.chunked.test.js
git commit -m "feat(chunkedworld): Player collision via resolveMove on chunked maps (SOMET-57)"
```

---

### Task 3: Chunk-tile enumeration helper + `RenderSystem` chunked render

**Files:**
- Create: `frontend/src/games/something2/src/js/core/chunkTiles.js`
- Create: `frontend/src/games/something2/src/js/core/__tests__/chunkTiles.test.js`
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js`

**Interfaces:**
- Produces:
  - `chunkTileCells(chunkedMap) -> Array<{ worldX, worldY, tile }>` — for every loaded chunk, the **world-pixel center** of each tile cell and its tile-type name. Pure (no canvas). Uses `parseKey` + `chunkOrigin` + `MAP_TILE_SIZE`. World center of local `(lr,lc)` in chunk `(cx,cy)`: `origin = chunkOrigin(cx,cy,N)`, `worldX = origin.x + lc*T + T/2`, `worldY = origin.y + lr*T + T/2`.
  - `RenderSystem.renderChunked(player, camera, chunkedMap, remotePlayers, localUserId)` — background, `camera.apply`, draw all chunk tiles as iso diamonds (via `chunkTileCells` + `worldToScreen`, colored from `chunkedMap.mapTiles`, culled by screen distance from `camera.screenX/Y`), then the depth-sorted player(s) (reuse the existing `drawCreature` path), `camera.reset`, HUD. `RenderSystem.render` is unchanged (legacy path).

- [ ] **Step 1: Write the failing test (helper only)**

Create `frontend/src/games/something2/src/js/core/__tests__/chunkTiles.test.js`:
```js
import { describe, it, expect } from "vitest";
import { chunkTileCells } from "../chunkTiles.js";
import { ChunkedMap } from "../ChunkedMap.js";
import { MAP_TILE_SIZE } from "../constants.js";

const N = 2;
const T = MAP_TILE_SIZE;

describe("chunkTileCells", () => {
  it("enumerates world-pixel tile centers for loaded chunks", () => {
    const m = new ChunkedMap(N);
    m.setChunk(0, 0, [["grass", "dirt"], ["water", "grass"]]); // grid[lr][lc]
    const cells = chunkTileCells(m);
    expect(cells.length).toBe(4);
    // local (lr=0,lc=0) -> world center (T/2, T/2), tile grid[0][0] = grass
    expect(cells).toContainEqual({ worldX: T / 2, worldY: T / 2, tile: "grass" });
    // local (lr=1,lc=0) -> (T/2, T + T/2), tile grid[1][0] = water
    expect(cells).toContainEqual({ worldX: T / 2, worldY: T + T / 2, tile: "water" });
  });

  it("offsets by chunk origin incl. negative chunks", () => {
    const m = new ChunkedMap(N);
    m.setChunk(-1, 0, [["a", "b"], ["c", "d"]]);
    const cells = chunkTileCells(m);
    // chunk (-1,0) origin.x = -1*N*T = -2T; local (0,0) center = -2T + T/2
    expect(cells).toContainEqual({ worldX: -2 * T + T / 2, worldY: T / 2, tile: "a" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run from `frontend/`: `npm run test -- chunkTiles`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Implement the helper + the RenderSystem chunked path**

Create `frontend/src/games/something2/src/js/core/chunkTiles.js`:
```js
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
```
In `frontend/src/games/something2/src/js/systems/RenderSystem.js`, add imports (`ISO_TILE_W`, `ISO_TILE_H` from constants if not present; `chunkTileCells`), and add a `renderChunked` method mirroring the legacy `render` but drawing chunk tiles:
```js
  renderChunked(player, camera, chunkedMap, remotePlayers, localUserId) {
    this.ctx.fillStyle = "#0f3460";
    this.ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    camera.apply(this.ctx);

    const halfW = ISO_TILE_W / 2;
    const halfH = ISO_TILE_H / 2;
    const mapTiles = chunkedMap.mapTiles;
    for (const cell of chunkTileCells(chunkedMap)) {
      const s = worldToScreen(cell.worldX, cell.worldY);
      const relX = s.x - camera.screenX;
      const relY = s.y - camera.screenY;
      if (relX < -camera.width || relX > camera.width || relY < -camera.height || relY > camera.height) continue;
      const def = mapTiles ? (mapTiles[cell.tile] || (Array.isArray(mapTiles) ? mapTiles.find(t => t.name === cell.tile || t.type === cell.tile) : null)) : null;
      this.ctx.fillStyle = def ? def.color : "#123";
      this.ctx.beginPath();
      this.ctx.moveTo(s.x, s.y - halfH);
      this.ctx.lineTo(s.x + halfW, s.y);
      this.ctx.lineTo(s.x, s.y + halfH);
      this.ctx.lineTo(s.x - halfW, s.y);
      this.ctx.closePath();
      this.ctx.fill();
    }

    // Players on top (reuse the depth-sorted creature drawing; no world entities yet).
    const drawables = RenderSystem.buildDrawables(player, { entities: [] }, remotePlayers);
    for (const d of drawables) {
      if (d.kind === "player") this.drawCreature(d.ref, "player", 1);
      else if (d.kind === "remote") this.drawCreature(d.ref, "player", 0.85, d.userId);
    }

    camera.reset(this.ctx);
    this.renderHud(player, remotePlayers, localUserId);
  }
```
(If `GAME_WIDTH`/`GAME_HEIGHT`/`ISO_TILE_W`/`ISO_TILE_H`/`worldToScreen`/`depthKey` aren't already imported at the top of RenderSystem, add them from `../core/constants.js` / `../core/iso.js`. `drawCreature`, `buildDrawables`, `renderHud` already exist.)

- [ ] **Step 4: Run to verify passing**

Run from `frontend/`: `npm run test -- chunkTiles`
Expected: PASS (2). Then full `npm run test` (all green) and `npm run lint` (no new errors in the changed files).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/chunkTiles.js frontend/src/games/something2/src/js/core/__tests__/chunkTiles.test.js frontend/src/games/something2/src/js/systems/RenderSystem.js
git commit -m "feat(chunkedworld): multi-chunk isometric tile render (SOMET-57)"
```

---

### Task 4: `Game` chunked mode (init + loop wiring)

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js`

**Interfaces:**
- Produces on `Game`:
  - `async initChunked({ worldId, chunkSize, tileTypes, spawnX = 0, spawnY = 0 })` — sets `this.chunked = true`; builds `this.chunkedMap = new ChunkedMap(chunkSize, tileTypes)` and `this.streamer = new ChunkStreamer(this.chunkedMap, makeChunkFetcher(worldId, API_URL), 1)`; places the player at `(spawnX, spawnY)`; `await this.streamer.update(spawnCenterX, spawnCenterY)` so the first neighborhood is loaded before the first frame; creates the `RenderSystem`, wires input/resize, and starts the loop (same lifecycle as `init`).
  - `update(dt)` chunked branch: `this.streamer.update(centerX, centerY)` **fire-and-forget** (no await) using the player's center; `this.player.update(dt, this.keys, this.chunkedMap)`; `this.camera.update(this.player)`. (Engine push, if any, unchanged.)
  - `render()` chunked branch: `this.renderSystem.renderChunked(this.player, this.camera, this.chunkedMap, this.remotePlayers, this.localUserId)`.
  - Legacy `init`/`update`/`render` paths untouched when `this.chunked` is falsy.

- [ ] **Step 1: Add the chunked mode (no unit test — integration; verified in Task 6)**

At the top of `Game.js`, add imports:
```js
import { ChunkedMap } from "./ChunkedMap.js";
import { ChunkStreamer } from "../net/ChunkStreamer.js";
import { makeChunkFetcher } from "../net/chunkFetcher.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";
```
In the constructor, add `this.chunked = false; this.chunkedMap = null; this.streamer = null;`.

Add `initChunked`:
```js
  async initChunked({ worldId, chunkSize, tileTypes, spawnX = 0, spawnY = 0 }) {
    if (!this.canvas) { console.error("Canvas not found!"); return; }
    this.ctx = this.canvas.getContext("2d");
    this.state = "playing";
    this.chunked = true;
    this.renderSystem = new RenderSystem(this.canvas, this.imageManager);
    this.chunkedMap = new ChunkedMap(chunkSize, tileTypes);
    this.streamer = new ChunkStreamer(this.chunkedMap, makeChunkFetcher(worldId, API_URL), 1);

    this.player.x = spawnX;
    this.player.y = spawnY;
    await this.imageManager.loadAll();
    // Load the initial neighborhood before the first frame so we don't render empty.
    await this.streamer.update(this.player.x + this.player.width / 2, this.player.y + this.player.height / 2);
    this.camera.update(this.player);

    this.resizeCanvas();
    this._resizeHandler = () => this.resizeCanvas();
    window.addEventListener("resize", this._resizeHandler);
    this.setupInput();

    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    this.lastTime = performance.now();
    this.animationFrameId = requestAnimationFrame((t) => this.gameLoop(t));
    console.log(`chunked game loop started (world ${worldId})`);
  }
```
In `update(dt)`, branch at the top:
```js
  update(dt) {
    if (this.state !== "playing") return;
    if (this.chunked) {
      const cx = this.player.x + this.player.width / 2;
      const cy = this.player.y + this.player.height / 2;
      this.streamer.update(cx, cy); // fire-and-forget; wanted-guard makes it safe
      this.player.update(dt, this.keys, this.chunkedMap);
      this.camera.update(this.player);
      if (this.engine && this.engine.joined) this.engine.sendMove(cx, cy);
      return;
    }
    // ... existing legacy update body unchanged ...
```
In `render()`, branch:
```js
  render() {
    if (this.state === "menu") { /* unchanged */ }
    else if (this.chunked) {
      this.renderSystem.renderChunked(this.player, this.camera, this.chunkedMap, this.remotePlayers, this.localUserId);
    } else {
      this.renderSystem.render(this.player, this.camera, this.map, this.remotePlayers, this.localUserId);
    }
  }
```
Guard any legacy-map-only work that runs each frame (e.g. minimap building over `this.map.entities`) with `if (!this.chunked)` so it doesn't run in chunked mode. Read the file and add the guard where such code exists.

- [ ] **Step 2: Lint + full suite**

Run from `frontend/`: `npm run lint && npm run test`
Expected: no new lint errors; all existing tests still pass (this task adds no unit tests — it's integration, verified in Task 6). `npm run build` from `frontend/` must succeed (catches import/wiring errors across the game).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js
git commit -m "feat(chunkedworld): Game chunked mode — stream + collide + render loop (SOMET-57)"
```

---

### Task 5: World-entry UI — enter chunked play

**Files:**
- Modify: `frontend/src/games/something2/Something2.jsx`

**Interfaces:**
- Adds a "Worlds" panel (in the Game View tab, near the existing map browser) using `useWorlds()` / `useCreateWorld()`: lists worlds, a create-world form (name + optional seed + chunk_size default 64), and an **"Enter World"** button that calls `gameRef.current.initChunked({ worldId, chunkSize, tileTypes, spawnX, spawnY })` and sets `isPlaying`. `tileTypes` comes from the existing tile-types query (the same object the legacy path already loads); spawn defaults to the center of chunk (0,0): `spawnX = spawnY = chunkSize * MAP_TILE_SIZE / 2`.

- [ ] **Step 1: Add the Worlds panel + enter handler**

Read `Something2.jsx` to match its existing structure (styled components, tabs, `gameRef`, tile-types source). Add:
- imports: `useWorlds`, `useCreateWorld` from `./useWorlds`; `MAP_TILE_SIZE` from the game constants.
- state: `selectedWorldId`, `newWorldName`, `newWorldSeed`.
- a panel listing `worlds` with select + a create form (calls `useCreateWorld().mutate`).
- `handleEnterChunkedWorld`: fetch the selected world (for `chunk_size`), get `tileTypes` (reuse whatever the page already uses for the legacy path — the tile-types map), then:
  ```js
  const chunkSize = world.chunk_size || 64;
  const spawn = (chunkSize * MAP_TILE_SIZE) / 2;
  await gameRef.current.initChunked({ worldId: world.id, chunkSize, tileTypes, spawnX: spawn, spawnY: spawn });
  setIsPlaying(true);
  ```
Match the file's existing dark-palette styling (hardcoded hex is intentional here). Keep the legacy map browser present (don't delete it) — the chunked Worlds panel is the primary play entry per the "replace" decision, but the editors and legacy browser stay.

- [ ] **Step 2: Lint + build**

Run from `frontend/`: `npm run lint && npm run build`
Expected: no new lint errors; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/something2/Something2.jsx
git commit -m "feat(chunkedworld): world-select UI to enter chunked play (SOMET-57)"
```

---

### Task 6: Live browser verification (seam-crossing)

**Files:** none (verification).

- [ ] **Step 1: Bring up the stack + servers**

`make up`; ensure backend is serving (`docker exec -d something2-backend-1 sh -c 'cd /app && npm start > /tmp/backend.log 2>&1'`) and run the frontend dev server (host, pointed at the backend). Create a world via `POST /api/worlds` (or the UI).

- [ ] **Step 2: Drive the browser**

Load `/game-something2`, open the Worlds panel, create/select a world, **Enter World**. Confirm the canvas renders a multi-chunk isometric field.

- [ ] **Step 3: Verify seam-crossing**

Walk with WASD in one direction across at least one chunk boundary (≥ `chunkSize` tiles). Confirm via screenshots + console:
- Tiles render as a continuous diamond field with **no visible seam, no reposition, no load flicker** as you cross a boundary.
- The HUD position keeps increasing smoothly (crossing a seam doesn't reset it).
- The console shows chunk fetches for newly-adjacent chunks and no errors; the `world_chunks` table gains rows for visited chunks.
- Walking back and forth doesn't re-fetch already-loaded chunks (dedup) and doesn't leak (dropped chunks are re-fetched, not duplicated).

- [ ] **Step 4: Record the result**

If all pass, note it (screenshots). If anything fails, treat as a bug and use superpowers:systematic-debugging before claiming done.

---

## Self-Review

**Spec coverage (Phase 4 "render + UI + streaming into the loop" half):**
- "client keeps a 3×3 neighborhood; load newly-adjacent ring, drop far ring; TanStack-cached fetch" → Task 1 (fetcher, hooks) + Task 4 (streamer wired into loop, fire-and-forget). ✓
- "RenderSystem/Map iterate loaded chunks, draw world→screen iso; depth-sort across seams" → Task 3 (`chunkTileCells` + `renderChunked`; tiles under players). ✓ (Tiles never overlap sprites incorrectly since tiles draw first; cross-seam tile ordering is inherent — each tile is drawn at its own projected position.)
- "player walks across a seam with no visible load and no reposition" → Task 6 acceptance. ✓
- Enter chunked play → Task 5. ✓

**Phase-4a must-dos addressed:**
- (1) fetcher returns bare `.data` grid → Task 1 (+ test asserting it's not the envelope). ✓
- (2) `Player.update` → `resolveMove` on chunked maps → Task 2. ✓
- (3) remove `WORLD_WIDTH/HEIGHT` clamp on the chunked path → Task 2 (chunked branch has no clamp; test asserts negative-coord movement). ✓
- (4) `ChunkedMap` built with real `tileTypes` → Task 4/5 (`initChunked` takes `tileTypes`; UI passes the tile-types map). ✓
- (5) `streamer.update` fire-and-forget from loop + render `loadedKeys()` multi-chunk → Task 4 + Task 3. ✓
- (6) world-entry UI + browser verify → Task 5 + Task 6. ✓

**Placeholder scan:** No TBD/vague steps in the code tasks; the two integration/UI tasks (4, 5) give concrete method bodies + wiring and are visually verified in Task 6. ✓

**Type/name consistency:** `makeChunkFetcher(worldId, apiUrl, fetchImpl?) -> (cx,cy)=>grid` (Task 1) consumed by `ChunkStreamer` in Task 4. `chunkTileCells(chunkedMap)` (Task 3) consumed by `renderChunked` (Task 3). `resolveMove(map, actor, dx, dy, dt)` (Phase 4a) consumed by `Player.update` (Task 2). `initChunked({worldId,chunkSize,tileTypes,spawnX,spawnY})` (Task 4) called by the UI (Task 5). `ChunkedMap(chunkSize, tileTypes)` / `ChunkStreamer(map, fetch, radius)` match Phase 3/4a signatures. ✓

**Risk note:** Tasks 4–5 modify the live `Game.js`/`Something2.jsx` and are not fully unit-testable; the `npm run build` gate (Task 4) catches wiring errors, and Task 6 is the real acceptance. Legacy paths are guarded by `this.chunked`, so the editors and legacy map play remain functional.

## Out of scope for this plan (Phase 5, separate plan)
- World-space free-roaming creatures + entity collision/rendering in chunked mode → Phase 5 (SOMET-58).
- Fully removing the legacy single-`Map` play code (kept as an inactive path here).
- Off-screen chunk baking / render perf tuning if 3×3 × 64² proves heavy (mitigation noted in the spec; revisit if Task 6 shows frame drops).
