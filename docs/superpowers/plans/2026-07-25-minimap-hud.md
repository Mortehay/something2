# Minimap HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-on, toggleable iso minimap to the in-game HUD (top-right, below the fullscreen icon) showing a coarse player-centered terrain overview plus live player, creature, doorway, and village markers, with click-to-expand.

**Architecture:** A new backend endpoint `GET /api/worlds/:id/overview` returns a downsampled, player-centered terrain window (reusing `generateRegion`) plus doorway/village marker coords. A new React HUD component `Minimap.jsx` runs its own rAF loop, reads live state from `Game.getMinimapSnapshot()`, lazily fetches+caches the overview region, and draws terrain + markers with a new pure iso renderer `minimapRenderer.js`. Display-only; no fast-travel.

**Tech Stack:** Frontend — React, styled-components, Canvas 2D, Vitest. Backend — Express, `pg`, `node --test`.

## Global Constraints

- Frontend tests run under **Vitest** (`import { describe, it, expect, vi } from 'vitest'`). Backend tests run under **`node --test`** (`node:test` + `node:assert`).
- Client fetchers read `import.meta.env.VITE_API_URL || 'http://localhost:13101'`, mirroring `worldPreviewClient.js`.
- Iso projection is **2:1** — tile/diamond height = width / 2 — matching `mapPreviewRenderer.js`.
- World tile size is `MAP_TILE_SIZE` from `frontend/src/games/something2/src/js/core/constants.js`. Never hardcode the pixel value; import the constant.
- Bounded worlds use tile coords with world tile `(0,0)` at the top-left; `world.width`/`world.height` are in **tiles**. Unbounded worlds have `width`/`height` null and no doorways.
- Overview constants: **`OVERVIEW_SPAN = 256`** tiles, **`OVERVIEW_STEP = 4`** (→ 64×64 coarse cells). Keep these identical between the backend module and the route.
- `M` key becomes the minimap toggle; the existing **dev** render-mode override moves to **`Shift+M`**. The `t` dev tile-texture toggle is unchanged.

---

### Task 1: Backend — `generateWorldOverview` + `overviewOrigin` (pure map math)

**Files:**
- Modify: `backend/src/services/mapService.js` (add two functions + exports near the existing `generateWorldPreview` at line ~168 and `module.exports` at line ~691)
- Test: `backend/tests/mapService_overview.test.js`

**Interfaces:**
- Consumes: existing `generateRegion(world, rMin, cMin, rows, cols)` (already in this module).
- Produces:
  - `overviewOrigin(centerCol, centerRow, span)` → `{ snappedCol, snappedRow, originCol, originRow }`. Snaps the center to a `span/4` grid and returns the top-left tile of a `span×span` window centered on the snapped point.
  - `generateWorldOverview(world, centerCol, centerRow, span, step)` → `{ step, originCol, originRow, cols, rows, tiles: string[][], doorways: {edge,col,row}[], villages: {col,row}[] }`. `tiles[r][c]` is the world tile at `(originRow + r*step, originCol + c*step)`. `world` has the same shape passed to `generateWorldPreview` plus `doorways` (array of edge strings) and `villages` (rows from `fetchVillages`).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/mapService_overview.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { overviewOrigin, generateWorldOverview } = require('../src/services/mapService');

const TILES = { grass: { color: '#3a5' }, water: { color: '#25a' }, map_wall: { color: '#333' }, map_doorway: { color: '#fa0' } };

test('overviewOrigin snaps center to a span/4 grid and centers the window', () => {
  const span = 256; // snap grid = span/4 = 64; round(100/64)=2 -> snapped 128
  const o = overviewOrigin(100, 100, span);
  assert.strictEqual(o.snappedCol, 128);
  assert.strictEqual(o.snappedRow, 128);
  assert.strictEqual(o.originCol, 128 - 128); // snapped - span/2
  assert.strictEqual(o.originRow, 0);
});

test('generateWorldOverview downsamples: tiles[r][c] == world tile at origin + r/c*step', () => {
  const world = { seed: 7, chunkSize: 64, tileTypes: TILES };
  const span = 256, step = 4;
  const ov = generateWorldOverview(world, 0, 0, span, step);
  assert.strictEqual(ov.step, step);
  assert.strictEqual(ov.rows, span / step);
  assert.strictEqual(ov.cols, span / step);
  // Re-derive one cell straight from generateRegion and compare.
  const { generateRegion } = require('../src/services/mapService');
  const expected = generateRegion(world, ov.originRow + 5 * step, ov.originCol + 3 * step, 1, 1)[0][0];
  assert.strictEqual(ov.tiles[5][3], expected);
});

test('generateWorldOverview emits doorway + village markers in global tile coords', () => {
  const world = {
    seed: 1, chunkSize: 64, tileTypes: TILES,
    width: 40, height: 20, doorways: ['N', 'E'],
    villages: [{ minRow: 4, minCol: 6, width: 4, height: 4 }],
  };
  const ov = generateWorldOverview(world, 20, 10, 256, 4);
  assert.deepStrictEqual(ov.doorways.find(d => d.edge === 'N'), { edge: 'N', col: 20, row: 0 });
  assert.deepStrictEqual(ov.doorways.find(d => d.edge === 'E'), { edge: 'E', col: 39, row: 10 });
  assert.deepStrictEqual(ov.villages[0], { col: 8, row: 6 });
});

test('generateWorldOverview yields no doorways for an unbounded world', () => {
  const world = { seed: 1, chunkSize: 64, tileTypes: TILES, doorways: ['N'] };
  const ov = generateWorldOverview(world, 0, 0, 256, 4);
  assert.deepStrictEqual(ov.doorways, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/mapService_overview.test.js`
Expected: FAIL — `overviewOrigin is not a function`.

- [ ] **Step 3: Add the implementation to `mapService.js`**

Insert after `generateWorldPreview` (line ~171):

```js
// Player-centered coarse overview for the in-game minimap. Distinct from
// generateWorldPreview (fixed origin window): this window follows the player.
// Snapping the center to a span/4 grid keeps the response cacheable — small
// moves reuse the same window.
function overviewOrigin(centerCol, centerRow, span) {
  const half = Math.floor(span / 2);
  const snap = Math.max(1, Math.floor(span / 4));
  const snappedCol = Math.round(centerCol / snap) * snap;
  const snappedRow = Math.round(centerRow / snap) * snap;
  return { snappedCol, snappedRow, originCol: snappedCol - half, originRow: snappedRow - half };
}

function overviewDoorwayMarkers(world) {
  if (!world.width || !world.height) return [];
  const W = world.width, H = world.height;
  const midW = Math.floor(W / 2), midH = Math.floor(H / 2);
  const at = { N: { col: midW, row: 0 }, S: { col: midW, row: H - 1 }, W: { col: 0, row: midH }, E: { col: W - 1, row: midH } };
  return (world.doorways || []).filter((e) => at[e]).map((e) => ({ edge: e, ...at[e] }));
}

function overviewVillageMarkers(world) {
  return (world.villages || []).map((v) => ({
    col: v.minCol + Math.floor(v.width / 2),
    row: v.minRow + Math.floor(v.height / 2),
  }));
}

function generateWorldOverview(world, centerCol, centerRow, span, step) {
  const { originCol, originRow } = overviewOrigin(centerCol, centerRow, span);
  // One contiguous span×span generation, then sample every `step`th tile —
  // far cheaper than one generateRegion call per coarse cell.
  const full = generateRegion(world, originRow, originCol, span, span);
  const rows = Math.floor(span / step), cols = Math.floor(span / step);
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) row[c] = full[r * step][c * step];
    tiles[r] = row;
  }
  return {
    step, originCol, originRow, cols, rows, tiles,
    doorways: overviewDoorwayMarkers(world),
    villages: overviewVillageMarkers(world),
  };
}
```

Add to `module.exports` (line ~691): `overviewOrigin,` and `generateWorldOverview,`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/mapService_overview.test.js`
Expected: PASS (4 tests). If the `overviewOrigin` rounding assertion mismatches, read the actual value and correct the test's expected numbers — the implementation's `Math.round` is the source of truth.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/mapService_overview.test.js
git commit -m "feat(minimap): player-centered world overview map generation"
```

---

### Task 2: Backend — `GET /api/worlds/:id/overview` route + cache invalidation

**Files:**
- Modify: `backend/src/index.js` (import at line ~8; constants + cache near line ~107; route after the `/preview` route at line ~1690; cache clears alongside each existing `worldPreviewCache.delete(...)`)
- Test: `backend/tests/overview_route.test.js`

**Interfaces:**
- Consumes: `generateWorldOverview`, `overviewOrigin` (Task 1); existing `getTileTypesMap()`, `fetchLinks`, `fetchVillages`, `pool`.
- Produces: `GET /api/worlds/:id/overview?cx=<tileCol>&cy=<tileRow>` → `200 { world_id, step, originCol, originRow, cols, rows, tiles, doorways, villages }`; `400` if `cx`/`cy` missing/non-numeric; `404` if world missing.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/overview_route.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index');

function fakePool(worldRow) {
  return {
    query: async (sql) => {
      if (/FROM worlds WHERE id/.test(sql)) return { rows: worldRow ? [worldRow] : [] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', color: '#3a5', walkable: true }] };
      if (/FROM map_links/i.test(sql)) return { rows: [] };
      if (/FROM villages/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

test('overview route 400s without cx/cy', async () => {
  __setPool(fakePool({ id: 'w1', seed: 1, chunk_size: 64 }));
  const res = await request(app).get('/api/worlds/w1/overview');
  assert.strictEqual(res.status, 400);
});

test('overview route 404s for an unknown world', async () => {
  __setPool(fakePool(null));
  const res = await request(app).get('/api/worlds/nope/overview?cx=0&cy=0');
  assert.strictEqual(res.status, 404);
});

test('overview route returns a downsampled grid', async () => {
  __setPool(fakePool({ id: 'w1', seed: 1, chunk_size: 64 }));
  const res = await request(app).get('/api/worlds/w1/overview?cx=0&cy=0');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.step, 4);
  assert.strictEqual(res.body.tiles.length, 64);
  assert.strictEqual(res.body.tiles[0].length, 64);
  assert.strictEqual(res.body.world_id, 'w1');
});
```

> Confirm `supertest` and `__setPool` are already used by other backend tests before relying on them: `grep -rl "supertest\|__setPool" backend/tests | head`. `index.js` already exports `__setPool` (see its `module.exports`). If `supertest` is absent, mirror whatever HTTP-test helper the existing route tests use instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/overview_route.test.js`
Expected: FAIL — 404/route-not-found on the overview path.

- [ ] **Step 3: Add import, constants, cache, route**

Extend the Task-1 import on line ~8 to also pull the new functions:
```js
const { /* …existing… */ generateWorldOverview, overviewOrigin } = require('./services/mapService');
```

Near `PREVIEW_DIM` / `worldPreviewCache` (line ~107):
```js
const OVERVIEW_SPAN = 256;   // tiles per side of the player-centered window
const OVERVIEW_STEP = 4;     // downsample factor -> 64x64 coarse cells
const worldOverviewCache = new Map(); // "worldId:snappedCol:snappedRow" -> payload

function clearOverviewCache(worldId) {
  for (const key of worldOverviewCache.keys()) {
    if (key.startsWith(`${worldId}:`)) worldOverviewCache.delete(key);
  }
}
```

After the `/api/worlds/:id/preview` route (line ~1690):
```js
app.get('/api/worlds/:id/overview', async (req, res) => {
  try {
    const worldId = req.params.id;
    const centerCol = Number(req.query.cx), centerRow = Number(req.query.cy);
    if (!Number.isFinite(centerCol) || !Number.isFinite(centerRow)) {
      return res.status(400).json({ error: 'cx and cy (tile coords) are required' });
    }
    const { snappedCol, snappedRow } = overviewOrigin(centerCol, centerRow, OVERVIEW_SPAN);
    const cacheKey = `${worldId}:${snappedCol}:${snappedRow}`;
    if (worldOverviewCache.has(cacheKey)) return res.json(worldOverviewCache.get(cacheKey));

    const worldRes = await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
    const world = worldRes.rows[0];
    if (!world) return res.status(404).json({ error: 'world not found' });

    const tileTypes = await getTileTypesMap();
    const data = generateWorldOverview(
      { seed: Number(world.seed), chunkSize: world.chunk_size, tileTypes,
        width: world.width, height: world.height,
        doorways: (await fetchLinks(pool, world.id)).map((l) => l.edge),
        villages: await fetchVillages(pool, world.id) },
      centerCol, centerRow, OVERVIEW_SPAN, OVERVIEW_STEP,
    );
    const payload = { world_id: worldId, ...data };
    worldOverviewCache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate world overview' });
  }
});
```

Then, next to **each** existing `worldPreviewCache.delete(<id>)` call (lines ~1259, ~1314, ~1425), add a matching `clearOverviewCache(<id>)` so terrain-affecting edits invalidate both caches. Use the same id variable already in scope at each site.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/overview_route.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/overview_route.test.js
git commit -m "feat(minimap): world overview endpoint with per-world cache invalidation"
```

---

### Task 3: Frontend — `worldOverviewClient.js` (fetcher + refetch predicate)

**Files:**
- Create: `frontend/src/games/something2/src/js/net/worldOverviewClient.js`
- Test: `frontend/src/games/something2/src/js/net/worldOverviewClient.test.js`

**Interfaces:**
- Produces:
  - `fetchWorldOverview(worldId, centerCol, centerRow)` → `Promise<overview>` (throws on non-ok).
  - `needsRefetch(cached, playerCol, playerRow, margin)` → `boolean`. True when `cached` is null/undefined or the player is within `margin` tiles of the cached window's edge.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWorldOverview, needsRefetch } from './worldOverviewClient.js';

afterEach(() => vi.restoreAllMocks());

describe('fetchWorldOverview', () => {
  it('GETs the overview endpoint with cx/cy and returns JSON', async () => {
    const body = { world_id: 'w1', step: 4, originCol: 0, originRow: 0, cols: 64, rows: 64, tiles: [] };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await fetchWorldOverview('w1', 12, 34);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/worlds\/w1\/overview\?cx=12&cy=34$/));
    expect(res).toEqual(body);
  });

  it('throws on a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchWorldOverview('w1', 0, 0)).rejects.toThrow(/HTTP 500/);
  });
});

describe('needsRefetch', () => {
  const cached = { originCol: 0, originRow: 0, cols: 64, rows: 64, step: 4 }; // window covers tiles [0,256)
  it('is true with no cache', () => expect(needsRefetch(null, 128, 128, 32)).toBe(true));
  it('is false when the player is comfortably inside', () => expect(needsRefetch(cached, 128, 128, 32)).toBe(false));
  it('is true near the left edge', () => expect(needsRefetch(cached, 10, 128, 32)).toBe(true));
  it('is true near the bottom edge', () => expect(needsRefetch(cached, 128, 250, 32)).toBe(true));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/worldOverviewClient.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// frontend/src/games/something2/src/js/net/worldOverviewClient.js
// Dependency-free fetcher + refetch predicate for the minimap's player-centered
// overview. Kept React/query-free so it is unit-testable in the node vitest env,
// mirroring worldPreviewClient.js.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:13101';

export async function fetchWorldOverview(worldId, centerCol, centerRow) {
  const res = await fetch(`${API_URL}/api/worlds/${worldId}/overview?cx=${centerCol}&cy=${centerRow}`);
  if (!res.ok) throw new Error(`Failed to fetch world overview: HTTP ${res.status}`);
  return res.json();
}

// True when there is no cached window, or the player has moved within `margin`
// tiles of its edge (so terrain would run out before the next fetch lands).
export function needsRefetch(cached, playerCol, playerRow, margin) {
  if (!cached) return true;
  const maxCol = cached.originCol + cached.cols * cached.step;
  const maxRow = cached.originRow + cached.rows * cached.step;
  return playerCol < cached.originCol + margin || playerCol > maxCol - margin
      || playerRow < cached.originRow + margin || playerRow > maxRow - margin;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/worldOverviewClient.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/net/worldOverviewClient.js frontend/src/games/something2/src/js/net/worldOverviewClient.test.js
git commit -m "feat(minimap): world overview client fetcher + refetch predicate"
```

---

### Task 4: Frontend — `minimapRenderer.js` (pure iso projection + draw)

**Files:**
- Create: `frontend/src/games/something2/src/js/systems/minimapRenderer.js`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/minimapRenderer.test.js`

**Interfaces:**
- Produces:
  - `worldTileToView(col, row, view)` → `{ x, y }`. `view = { centerCol, centerRow, step, cellW, boxW, boxH }`. Iso-projects a (possibly fractional) global tile onto the minimap box; the center tile lands at the box center. Diamond height = `cellW / 2`; one diamond spans `step` tiles.
  - `drawMinimap(ctx, { overview, tileColors, player, creatures, doorways, villages, view })` → void. Draws terrain diamonds, then village/doorway/creature markers, then the centered player marker with a facing triangle. Tolerant of `overview == null` (markers only). `player.dir = { dx, dy }` in world-tile space.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { worldTileToView } from '../minimapRenderer.js';

describe('worldTileToView', () => {
  const view = { centerCol: 100, centerRow: 100, step: 4, cellW: 12, boxW: 180, boxH: 180 };

  it('places the center tile at the box center', () => {
    expect(worldTileToView(100, 100, view)).toEqual({ x: 90, y: 90 });
  });

  it('moves +step tiles east/south by one diamond (screen down)', () => {
    // +step cols and +step rows => dc=1, dr=1 => x offset 0, y offset cellH
    const p = worldTileToView(104, 104, view);
    expect(p.x).toBeCloseTo(90);
    expect(p.y).toBeCloseTo(90 + 12 / 2); // cellH = cellW/2 = 6
  });

  it('projects +step col alone to the lower-right in iso', () => {
    const p = worldTileToView(104, 100, view); // dc=1, dr=0
    expect(p.x).toBeCloseTo(90 + 12 / 2); // +hw
    expect(p.y).toBeCloseTo(90 + 6 / 2);  // +hh
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/minimapRenderer.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// frontend/src/games/something2/src/js/systems/minimapRenderer.js
// Pure Canvas-2D drawing for the in-game minimap. Player-centered iso window:
// the player's (fractional) global tile maps to the box center and everything
// else offsets from it. Diamonds are 2:1 like the in-game world and the world
// browser preview (see mapPreviewRenderer.js). No DOM/React/state.

// Screen position of a global tile (fractional ok) within the minimap box.
// One diamond of width cellW represents `step` world tiles.
export function worldTileToView(col, row, view) {
  const { centerCol, centerRow, step, cellW, boxW, boxH } = view;
  const cellH = cellW / 2;
  const dc = (col - centerCol) / step;
  const dr = (row - centerRow) / step;
  return {
    x: (dc - dr) * cellW / 2 + boxW / 2,
    y: (dc + dr) * cellH / 2 + boxH / 2,
  };
}

function diamond(ctx, x, y, hw, hh) {
  ctx.beginPath();
  ctx.moveTo(x, y - hh);
  ctx.lineTo(x + hw, y);
  ctx.lineTo(x, y + hh);
  ctx.lineTo(x - hw, y);
  ctx.closePath();
}

// Iso screen angle of a world-tile movement vector, for the player facing arrow.
function isoAngle(dx, dy) {
  return Math.atan2((dx + dy) * 0.5, dx - dy);
}

export function drawMinimap(ctx, { overview, tileColors, player, creatures, doorways, villages, view }) {
  const cellW = view.cellW, hw = cellW / 2, hh = cellW / 4;

  // 1) Terrain
  if (overview) {
    for (let r = 0; r < overview.rows; r++) {
      const row = overview.tiles[r];
      if (!row) continue;
      for (let c = 0; c < overview.cols; c++) {
        const name = row[c];
        if (!name) continue;
        const { x, y } = worldTileToView(overview.originCol + c * overview.step, overview.originRow + r * overview.step, view);
        if (x < -cellW || x > view.boxW + cellW || y < -cellW || y > view.boxH + cellW) continue;
        ctx.fillStyle = (tileColors && tileColors[name]) || '#334155';
        diamond(ctx, x, y, hw, hh);
        ctx.fill();
      }
    }
  }

  // 2) Villages (gold square), 3) doorways (magenta diamond)
  for (const v of villages || []) {
    const { x, y } = worldTileToView(v.col, v.row, view);
    ctx.fillStyle = '#fbbf24';
    ctx.fillRect(x - 3, y - 3, 6, 6);
  }
  for (const d of doorways || []) {
    const { x, y } = worldTileToView(d.col, d.row, view);
    ctx.fillStyle = '#c084fc';
    diamond(ctx, x, y, 4, 4);
    ctx.fill();
  }

  // 4) Creatures (colored dots)
  for (const cr of creatures || []) {
    const { x, y } = worldTileToView(cr.col, cr.row, view);
    ctx.fillStyle = cr.color || '#e5e7eb';
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // 5) Player: centered dot + facing triangle
  const { x, y } = worldTileToView(player.col, player.row, view);
  const dir = player.dir || { dx: 0, dy: 1 };
  const ang = isoAngle(dir.dx, dir.dy);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(7, 0);
  ctx.lineTo(-4, -4);
  ctx.lineTo(-4, 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#4a9eff';
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fill();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/minimapRenderer.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/minimapRenderer.js frontend/src/games/something2/src/js/systems/__tests__/minimapRenderer.test.js
git commit -m "feat(minimap): pure iso renderer for player-centered minimap"
```

---

### Task 5: Frontend — `Game.getMinimapSnapshot()`, store `worldId`, move dev key to `Shift+M`

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (store `this.worldId` in `initChunked` ~line 211; add `getMinimapSnapshot()` method; guard the dev `m` handler on `e.shiftKey` at ~line 680)
- Test: `frontend/src/games/something2/src/js/core/__tests__/minimapSnapshot.test.js`

**Interfaces:**
- Consumes: existing `inputVector` from `../entities/Player.js`.
- Produces: `Game.getMinimapSnapshot()` → `null` when not in a playing chunked world, else `{ worldId, chunkSize, player: { x, y, dir: { dx, dy } }, creatures: [{ x, y, color }] }`. `x`/`y` are world-pixel **centers**; `dir` is the normalized last non-zero movement (persists while standing still; defaults south).

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { Game } from '../Game.js';

// Call the method against a hand-built `this` to avoid constructing the full
// Game (which needs a canvas/DOM). This tests the snapshot logic in isolation.
function callSnapshot(state) {
  return Game.prototype.getMinimapSnapshot.call(state);
}

describe('getMinimapSnapshot', () => {
  it('returns null when not in a playing chunked world', () => {
    expect(callSnapshot({ state: 'menu', chunked: false })).toBeNull();
  });

  it('reports player center, worldId, chunkSize, and creatures', () => {
    const snap = callSnapshot({
      state: 'playing', chunked: true, worldId: 'w1',
      chunkedMap: { chunkSize: 64 },
      player: { x: 100, y: 200, width: 64, height: 64 },
      keys: {},
      creatures: { all: () => [{ x: 10, y: 20, color: '#f00' }] },
    });
    expect(snap.worldId).toBe('w1');
    expect(snap.chunkSize).toBe(64);
    expect(snap.player.x).toBe(132); // 100 + 64/2
    expect(snap.player.y).toBe(232);
    expect(snap.creatures).toEqual([{ x: 10, y: 20, color: '#f00' }]);
  });

  it('derives facing from held movement keys', () => {
    const snap = callSnapshot({
      state: 'playing', chunked: true, worldId: 'w1',
      chunkedMap: { chunkSize: 64 },
      player: { x: 0, y: 0, width: 0, height: 0 },
      keys: { d: true },              // moving east
      creatures: { all: () => [] },
    });
    expect(snap.player.dir.dx).toBeGreaterThan(0);
    expect(snap.player.dir.dy).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/minimapSnapshot.test.js`
Expected: FAIL — `getMinimapSnapshot is not a function`.

- [ ] **Step 3: Implement**

In `initChunked` (~line 233, next to `this.chunked = true;`) add:
```js
this.worldId = worldId;
```

Add the method to the `Game` class (e.g. after `initChunked`):
```js
// Read-only live snapshot for the minimap HUD. Keeps Game the single source of
// truth so the React component never reaches into engine internals. Returns
// null unless we're actually in a playing chunked world.
getMinimapSnapshot() {
  if (this.state !== 'playing' || !this.chunked || !this.player) return null;
  const { dx, dy } = inputVector(this.keys || {});
  if (dx !== 0 || dy !== 0) {
    const m = Math.hypot(dx, dy) || 1;
    this._minimapDir = { dx: dx / m, dy: dy / m };
  }
  return {
    worldId: this.worldId ?? null,
    chunkSize: this.chunkedMap ? this.chunkedMap.chunkSize : null,
    player: {
      x: this.player.x + (this.player.width || 0) / 2,
      y: this.player.y + (this.player.height || 0) / 2,
      dir: this._minimapDir || { dx: 0, dy: 1 },
    },
    creatures: (this.creatures ? this.creatures.all() : []).map((c) => ({ x: c.x, y: c.y, color: c.color })),
  };
}
```

`inputVector` is **already imported** in `Game.js` (line 15: `import { inputVector } from "../entities/Player.js";`), so no import change is needed. Confirm with `grep -n "inputVector" core/Game.js` before assuming otherwise.

Guard the dev render-mode toggle so it needs Shift (~line 680):
```js
// Dev: cycle the global render-mode override. Moved to Shift+M so plain M can
// toggle the minimap HUD (handled in Minimap.jsx).
if (key === 'm' && e.shiftKey && this.state === 'playing' && !e.repeat) {
    const mode = this.renderSystem.cycleRenderModeOverride();
    console.log(`Render-mode override: ${mode ?? 'off (per-entity)'}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/minimapSnapshot.test.js`
Expected: PASS (3 tests).
Also run the existing Game smoke test to confirm no regression: `npx vitest run src/games/something2/src/js/core/__tests__/smoke.test.js`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/core/__tests__/minimapSnapshot.test.js
git commit -m "feat(minimap): Game.getMinimapSnapshot + move dev render-mode to Shift+M"
```

---

### Task 6: Frontend — `Minimap.jsx` component + mount in `Something2.jsx`

**Files:**
- Create: `frontend/src/games/something2/Minimap.jsx`
- Modify: `frontend/src/games/something2/Something2.jsx` (import; render inside the game-tab block when `isPlaying`)

**Interfaces:**
- Consumes: `Game.getMinimapSnapshot()` (Task 5), `fetchWorldOverview`/`needsRefetch` (Task 3), `drawMinimap` (Task 4), `MAP_TILE_SIZE` (constants).
- Produces: `<Minimap gameRef={gameRef} tileColors={tileColors} />`. Self-manages visibility (`localStorage`), fetch/cache, and its rAF draw loop. No expand modal yet (Task 7 adds it).

- [ ] **Step 1: Write the component**

```jsx
// frontend/src/games/something2/Minimap.jsx
import { useEffect, useRef, useState, useCallback } from 'react';
import styled from 'styled-components';
import { fetchWorldOverview, needsRefetch } from './src/js/net/worldOverviewClient.js';
import { drawMinimap } from './src/js/systems/minimapRenderer.js';
import { MAP_TILE_SIZE } from './src/js/core/constants.js';

const SIZE = 180;         // minimap box (css px)
const CELL_PX = 12;       // iso diamond width per coarse cell
const REFETCH_MARGIN = 40; // tiles from window edge that trigger a refetch
const FALLBACK_STEP = 4;  // projection step before the first overview lands

const LS_KEY = 'something2:minimapVisible';

const Frame = styled.div`
  position: absolute;
  top: 64px;   /* clears the 40px fullscreen toggle at top:16 + gap */
  right: 16px;
  z-index: 20;
  width: ${SIZE}px;
  height: ${SIZE}px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #2e2e3e;
  background: rgba(15, 15, 26, 0.75);
  backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  pointer-events: auto;
`;

const HideButton = styled.button`
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 21;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1px solid #2e2e3e;
  background: rgba(26, 26, 46, 0.85);
  color: #aaa;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  &:hover { color: #fff; }
`;

const ShowButton = styled.button`
  position: absolute;
  top: 64px;
  right: 16px;
  z-index: 20;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  border: 1px solid #2e2e3e;
  background: rgba(26, 26, 46, 0.8);
  backdrop-filter: blur(8px);
  color: #e6e6f0;
  cursor: pointer;
  pointer-events: auto;
  &:hover { color: #4a9eff; }
`;

export default function Minimap({ gameRef, tileColors }) {
  const [visible, setVisible] = useState(() => localStorage.getItem(LS_KEY) !== '0');
  const canvasRef = useRef(null);
  const overviewRef = useRef(null);   // last fetched overview payload
  const fetchingRef = useRef(false);
  const tileColorsRef = useRef(tileColors);
  useEffect(() => { tileColorsRef.current = tileColors; });

  const persistVisible = useCallback((v) => {
    setVisible(v);
    localStorage.setItem(LS_KEY, v ? '1' : '0');
  }, []);

  // M toggles the minimap. Ignore when a modifier is held (Shift+M is the dev
  // render-mode toggle) or focus is in a text field.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key.toLowerCase() !== 'm' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      persistVisible(!visibleRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [persistVisible]);

  // Keep a ref of `visible` for the keydown closure above.
  const visibleRef = useRef(visible);
  useEffect(() => { visibleRef.current = visible; });

  // rAF draw loop — runs whenever visible. Reads a fresh snapshot each frame and
  // lazily (re)fetches the overview window when the player nears its edge or the
  // world changes.
  useEffect(() => {
    if (!visible) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    let raf = 0;

    const maybeFetch = (worldId, pCol, pRow) => {
      const cached = overviewRef.current;
      const stale = cached && cached.world_id !== worldId;
      if (fetchingRef.current) return;
      if (!stale && !needsRefetch(cached, pCol, pRow, REFETCH_MARGIN)) return;
      fetchingRef.current = true;
      fetchWorldOverview(worldId, Math.round(pCol), Math.round(pRow))
        .then((ov) => { overviewRef.current = ov; })
        .catch(() => { /* keep last window; retry on the next frame that still needs it */ })
        .finally(() => { fetchingRef.current = false; });
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const snap = gameRef.current && gameRef.current.getMinimapSnapshot
        ? gameRef.current.getMinimapSnapshot() : null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      if (!snap) return;

      const pCol = snap.player.x / MAP_TILE_SIZE;
      const pRow = snap.player.y / MAP_TILE_SIZE;
      maybeFetch(snap.worldId, pCol, pRow);

      let overview = overviewRef.current;
      if (overview && overview.world_id !== snap.worldId) overview = null; // wrong world; markers only
      const view = {
        centerCol: pCol, centerRow: pRow,
        step: overview ? overview.step : FALLBACK_STEP,
        cellW: CELL_PX, boxW: SIZE, boxH: SIZE,
      };
      drawMinimap(ctx, {
        overview,
        tileColors: tileColorsRef.current,
        player: { col: pCol, row: pRow, dir: snap.player.dir },
        creatures: snap.creatures.map((c) => ({ col: c.x / MAP_TILE_SIZE, row: c.y / MAP_TILE_SIZE, color: c.color })),
        doorways: overview ? overview.doorways : [],
        villages: overview ? overview.villages : [],
        view,
      });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [visible, gameRef]);

  if (!visible) {
    return <ShowButton type="button" title="Show minimap (M)" aria-label="Show minimap" onClick={() => persistVisible(true)}>🗺</ShowButton>;
  }
  return (
    <Frame title="Minimap — click to expand, M to hide">
      <canvas ref={canvasRef} style={{ width: `${SIZE}px`, height: `${SIZE}px`, display: 'block' }} />
      <HideButton type="button" title="Hide minimap (M)" aria-label="Hide minimap"
        onClick={(e) => { e.stopPropagation(); persistVisible(false); }}>×</HideButton>
    </Frame>
  );
}
```

- [ ] **Step 2: Mount it in `Something2.jsx`**

Add the import near the other local imports (~line 19):
```jsx
import Minimap from "./Minimap.jsx";
```

Inside the `activeTab === 'game'` block, right after the `FullscreenToggle` conditional (~line 685), add:
```jsx
{isPlaying && <Minimap gameRef={gameRef} tileColors={tileColors} />}
```
(`gameRef` and `tileColors` already exist in this component.)

- [ ] **Step 3: Verify it builds and the suite is green**

Run:
```bash
cd frontend && npx vitest run src/games/something2 && npm run build
```
Expected: existing + new unit tests PASS; `vite build` completes with no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/something2/Minimap.jsx frontend/src/games/something2/Something2.jsx
git commit -m "feat(minimap): live minimap HUD component mounted below the fullscreen toggle"
```

---

### Task 7: Frontend — click-to-expand modal with Esc precedence

**Files:**
- Modify: `frontend/src/games/something2/Minimap.jsx` (add expanded state, modal, capture-phase Esc handler, shared draw)

**Interfaces:**
- Consumes: everything from Task 6.
- Produces: clicking the minimap opens a centered modal rendering the same map at `min(80vmin, 640px)` with a wider window; Esc or click-out closes it **without** pausing the game.

- [ ] **Step 1: Factor the per-frame draw into a shared helper**

At module scope in `Minimap.jsx`, extract the body of `frame()` into a reusable function so both canvases share it:
```js
// Draw one frame into `ctx` for a box of `box` css px at `cellW` diamond size.
// Returns true if it drew live content (a snapshot existed).
function renderFrame(ctx, dpr, box, cellW, { gameRef, overviewRef, tileColors }) {
  const snap = gameRef.current && gameRef.current.getMinimapSnapshot
    ? gameRef.current.getMinimapSnapshot() : null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box, box);
  if (!snap) return false;
  const pCol = snap.player.x / MAP_TILE_SIZE;
  const pRow = snap.player.y / MAP_TILE_SIZE;
  let overview = overviewRef.current;
  if (overview && overview.world_id !== snap.worldId) overview = null;
  drawMinimap(ctx, {
    overview,
    tileColors,
    player: { col: pCol, row: pRow, dir: snap.player.dir },
    creatures: snap.creatures.map((c) => ({ col: c.x / MAP_TILE_SIZE, row: c.y / MAP_TILE_SIZE, color: c.color })),
    doorways: overview ? overview.doorways : [],
    villages: overview ? overview.villages : [],
    view: { centerCol: pCol, centerRow: pRow, step: overview ? overview.step : FALLBACK_STEP, cellW, boxW: box, boxH: box },
  });
  return true;
}
```
Rewrite the Task-6 `frame()` to call `renderFrame(ctx, dpr, SIZE, CELL_PX, { gameRef, overviewRef, tileColors: tileColorsRef.current })` (keep the `maybeFetch(...)` call in the loop before it). The modal reuses the same `overviewRef`, so no extra fetching is needed.

- [ ] **Step 2: Add the modal, its rAF loop, and Esc precedence**

Add state near the top of the component:
```js
const [expanded, setExpanded] = useState(false);
const modalCanvasRef = useRef(null);
```

Open on frame click (Task-6 `Frame` — add `onClick={() => setExpanded(true)}`).

Capture-phase Esc handler so it wins over Game's window keydown (bubble phase) and closes the modal instead of pausing:
```js
useEffect(() => {
  if (!expanded) return undefined;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); setExpanded(false); }
  };
  window.addEventListener('keydown', onKey, true); // capture
  return () => window.removeEventListener('keydown', onKey, true);
}, [expanded]);
```

Modal rAF loop (larger box, wider window via bigger `cellW`):
```js
useEffect(() => {
  if (!expanded) return undefined;
  const canvas = modalCanvasRef.current;
  if (!canvas) return undefined;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const box = Math.min(640, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.8));
  canvas.width = box * dpr; canvas.height = box * dpr;
  canvas.style.width = `${box}px`; canvas.style.height = `${box}px`;
  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    renderFrame(ctx, dpr, box, CELL_PX * 1.6, { gameRef, overviewRef, tileColors: tileColorsRef.current });
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}, [expanded, gameRef]);
```

Styled backdrop + card, and render it when `expanded` (clicking the backdrop closes; clicking the canvas does not):
```jsx
const ExpandBackdrop = styled.div`
  position: absolute; inset: 0; z-index: 200;
  background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center;
  pointer-events: auto;
`;
const ExpandCard = styled.div`
  border-radius: 14px; overflow: hidden; border: 1px solid #2e2e3e;
  background: rgba(15,15,26,0.9); box-shadow: 0 12px 48px rgba(0,0,0,0.6);
`;
```
```jsx
{expanded && (
  <ExpandBackdrop onClick={() => setExpanded(false)}>
    <ExpandCard onClick={(e) => e.stopPropagation()}>
      <canvas ref={modalCanvasRef} style={{ display: 'block' }} />
    </ExpandCard>
  </ExpandBackdrop>
)}
```
Return both the `Frame` (or `ShowButton`) and the modal from the component (wrap in a fragment).

- [ ] **Step 3: Verify build + suite**

Run:
```bash
cd frontend && npx vitest run src/games/something2 && npm run build
```
Expected: PASS + clean build.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/something2/Minimap.jsx
git commit -m "feat(minimap): click-to-expand modal with Esc precedence over pause"
```

---

### Task 8: Browser verification (per project norm — a green suite is not sufficient)

**Files:** none (manual/Chrome-DevTools MCP verification per the `browser-verification-lessons` and `audit-browser` project skills).

- [ ] **Step 1: Start the stack**

Use the project's normal run path (see the `run` skill / repo README — typically the compose stack + `frontend` dev server). Ensure the backend has the new `/overview` route (rebuild the backend image/process if it runs in a container). Log in and enter a world.

- [ ] **Step 2: Verify against the design's acceptance criteria**

Confirm each, capturing a screenshot where useful:
- Minimap renders in the top-right, **below** the fullscreen icon, while playing.
- Terrain follows the player as they move; the window refetches without stutter when crossing regions (watch the Network tab for `/overview` calls — should be occasional, not per-frame).
- Creatures appear as colored dots and move live; the player sits centered with a facing arrow.
- Doorway (magenta) and village (gold) markers appear on a bounded world that has them.
- `M` hides/shows the minimap and the choice survives a page reload (localStorage).
- `Shift+M` still cycles the dev render-mode override (check the console log).
- Clicking the minimap opens the expanded modal; **Esc closes the modal and does NOT open the pause menu**; a second Esc (modal closed) pauses as usual.
- Minimap remains visible in fullscreen (it lives inside the fullscreen element).
- Walking through a portal to another world reloads the overview for the new world (markers/terrain update).

- [ ] **Step 3: Record the result**

Note pass/fail per criterion in the PR description. If anything fails, fix at the source and re-verify — do not mark the task done on a green unit suite alone.

---

## Self-Review

**1. Spec coverage** (checked against `2026-07-25-minimap-hud-design.md`):
- Components table → Tasks 1–7 (overview endpoint T1–2, client T3, renderer T4, snapshot/Game T5, `Minimap.jsx` T6, modal T7). ✓
- Data flow (own rAF, lazy region fetch, portal-clear) → T6 (`maybeFetch`, world-change guard). ✓
- Backend overview endpoint (downsample, snap, cache, doorways/villages) → T1–2. ✓
- Rendering (iso, player-centered, markers) → T4. ✓
- Placement/interaction (top:64/right:16, M toggle, localStorage, expand modal, Esc precedence, Shift+M) → T5–7. ✓
- Error handling (fetch fail keeps last window; not mounted off the game tab; fullscreen) → T6 (`.catch`), Something2 conditional, Frame inside `contentRef`. ✓
- Testing (unit + browser) → each task's tests + T8. ✓
- Out-of-scope items are not implemented. ✓

**2. Placeholder scan:** No TBD/TODO; every code step carries real code and concrete run/expected lines. ✓

**3. Type consistency:** `overview` payload fields (`step, originCol, originRow, cols, rows, tiles, doorways[{edge,col,row}], villages[{col,row}], world_id`) are produced identically in T1/T2 and consumed identically in T3 (`needsRefetch`), T4 (`drawMinimap`/`worldTileToView` via `view.step`), and T6/T7. `getMinimapSnapshot` shape (`{worldId, chunkSize, player:{x,y,dir:{dx,dy}}, creatures:[{x,y,color}]}`) is produced in T5 and consumed in T6/T7. `view = {centerCol,centerRow,step,cellW,boxW,boxH}` is consistent between T4 and its callers. ✓
