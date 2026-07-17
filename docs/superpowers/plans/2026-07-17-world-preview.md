# World Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a wide, downsampled biome overview thumbnail of a selected world in the Worlds browser, generated deterministically from the world seed and rendered with the existing iso preview renderer.

**Architecture:** A pure `generateWorldPreview(world, dim, stride)` in `mapService` samples the biome field at strided coordinates (fixed cost = `dim*dim` samples). A memoized `GET /api/worlds/:id/preview` route serves the grid. A `WorldPreview.jsx` component (mirroring `MapPreview.jsx`) fetches it and renders with the shared `mapPreviewRenderer.js` + existing `tileColors`, wired into the preview pane.

**Tech Stack:** Node/CommonJS backend (Express, pg), `node --test`. Frontend React + TanStack Query v5, Vitest, styled-components.

## Global Constraints

- Reuse `worldConfig`/`sampleBiome` (already exported) — no duplicated biome math.
- `PREVIEW_DIM = 64`, `PREVIEW_STRIDE = 8` (biome overview ~8 chunks wide); window centered on origin: `start = -Math.floor(dim/2)*stride` so the middle cell is global tile 0.
- Preview is biome-only (no path overlay) — `sampleBiome` already excludes the path tile.
- In-memory memo keyed by world id (deterministic per seed + chunk_size; no migration, no DB table).
- Rendering reuses `mapPreviewRenderer.js` (`isoFit`/`draw`) + the existing `tileColors`; no new rendering engine.
- Frontend `API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101"` (match `useWorlds.js`).

---

### Task 1: `generateWorldPreview` in mapService

**Files:**
- Modify: `backend/src/services/mapService.js` (add function + export)
- Test: `backend/tests/worldPreview.test.js`

**Interfaces:**
- Consumes: `worldConfig(world)`, `sampleBiome(cfg, gRow, gCol)` (existing, same file).
- Produces: `generateWorldPreview(world, dim, stride) -> string[][]` — `world = {seed, chunkSize, tileTypes}`; a `dim × dim` grid of biome tile names, sampled at stride, centered on origin. Deterministic.

- [ ] **Step 1: Write the failing test**

`backend/tests/worldPreview.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { generateWorldPreview, worldConfig } = require('../src/services/mapService');

// Two biomes + a path tile (path excluded from biome sampling).
const tileTypes = { grass: {}, water: {}, path: {} };
const world = { seed: 7, chunkSize: 64, tileTypes };

test('generateWorldPreview returns a dim x dim grid of biome names', () => {
  const grid = generateWorldPreview(world, 64, 8);
  assert.equal(grid.length, 64);
  assert.ok(grid.every((row) => row.length === 64));
  const biomeNames = worldConfig(world).biomeNames; // ['grass','water']
  for (const row of grid) {
    for (const cell of row) assert.ok(biomeNames.includes(cell), `unexpected cell ${cell}`);
  }
});

test('generateWorldPreview is deterministic for the same seed', () => {
  const a = generateWorldPreview(world, 32, 8);
  const b = generateWorldPreview(world, 32, 8);
  assert.deepEqual(a, b);
});

test('a different seed generally yields a different grid', () => {
  const a = generateWorldPreview({ ...world, seed: 1 }, 32, 8);
  const b = generateWorldPreview({ ...world, seed: 2 }, 32, 8);
  assert.notDeepEqual(a, b);
});

test('the middle cell samples global tile 0,0', () => {
  // dim=8 → start=-Math.floor(8/2)*8=-32; middle cell pr=pc=4 → gRow=gCol=-32+4*8=0.
  const cfg = worldConfig(world);
  const grid = generateWorldPreview(world, 8, 8);
  const { sampleBiome } = require('../src/services/mapService');
  assert.equal(grid[4][4], sampleBiome(cfg, 0, 0));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/worldPreview.test.js`
Expected: FAIL — `generateWorldPreview is not a function`.

- [ ] **Step 3: Implement `generateWorldPreview`**

In `backend/src/services/mapService.js`, add the function (near `generateRegion`/`sampleBiome`):
```js
// Downsampled biome overview for a world preview: a dim x dim grid sampled at
// `stride` world tiles per cell, centered on origin. Biomes only (sampleBiome
// excludes the path tile). Pure + deterministic — cost is fixed at dim*dim
// samples regardless of the covered extent.
function generateWorldPreview(world, dim, stride) {
  const cfg = worldConfig(world);
  const start = -Math.floor(dim / 2) * stride;
  const grid = [];
  for (let pr = 0; pr < dim; pr++) {
    const row = new Array(dim);
    for (let pc = 0; pc < dim; pc++) {
      row[pc] = sampleBiome(cfg, start + pr * stride, start + pc * stride);
    }
    grid[pr] = row;
  }
  return grid;
}
```
Add `generateWorldPreview` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/worldPreview.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/worldPreview.test.js
git commit -m "feat(world-preview): generateWorldPreview downsampled biome overview"
```

---

### Task 2: `GET /api/worlds/:id/preview` route + memo

**Files:**
- Modify: `backend/src/index.js` (add route + module-level memo; add `generateWorldPreview` to the mapService require)
- Test: `backend/tests/worldPreviewRoute.test.js`

**Interfaces:**
- Consumes: `generateWorldPreview` (Task 1), `getTileTypesMap()` (existing in index.js), the pg `pool`.
- Produces: `GET /api/worlds/:id/preview` → `{ world_id, data }` where `data` is a `64×64` tile-name grid; 404 for unknown world. Memoized per world id.

- [ ] **Step 1: Write the failing test**

`backend/tests/worldPreviewRoute.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}
const tileRows = { rows: [
  { name: 'grass', color: '#3a3', walkable: true, speed: 1 },
  { name: 'water', color: '#36f', walkable: false, speed: 1 },
  { name: 'path', color: '#ca8', walkable: true, speed: 1 },
] };

test('GET /preview returns a 64x64 grid for a known world', async () => {
  __setPool(mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', seed: '7', chunk_size: 64 }] })],
    [/FROM tile_types/i, () => tileRows],
  ]));
  const res = await request(app).get('/api/worlds/w1/preview');
  assert.equal(res.status, 200);
  assert.equal(res.body.world_id, 'w1');
  assert.equal(res.body.data.length, 64);
  assert.ok(res.body.data.every((row) => row.length === 64));
});

test('GET /preview 404s for an unknown world', async () => {
  __setPool(mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).get('/api/worlds/nope/preview');
  assert.equal(res.status, 404);
});

test('GET /preview memoizes: a second request does not re-query the world', async () => {
  const pool = mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [{ id: 'memo1', seed: '9', chunk_size: 64 }] })],
    [/FROM tile_types/i, () => tileRows],
  ]);
  __setPool(pool);
  const a = await request(app).get('/api/worlds/memo1/preview');
  const b = await request(app).get('/api/worlds/memo1/preview');
  assert.deepEqual(a.body.data, b.body.data);
  const worldQueries = pool.calls.filter((c) => /FROM worlds WHERE id/i.test(c.sql)).length;
  assert.equal(worldQueries, 1, 'second request should hit the memo, not the DB');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/worldPreviewRoute.test.js`
Expected: FAIL — route returns 404/500 or the memo assertion fails (route not implemented).

- [ ] **Step 3: Implement the route + memo**

In `backend/src/index.js`, add `generateWorldPreview` to the mapService require (the line destructuring from `./services/mapService`). Near the other module-level state (e.g. by the `pool`/helpers), add:
```js
const PREVIEW_DIM = 64;
const PREVIEW_STRIDE = 8;
const worldPreviewCache = new Map(); // world_id -> data (dim x dim biome grid)
```
Add the route (near the other `/api/worlds/:id/...` routes):
```js
app.get('/api/worlds/:id/preview', async (req, res) => {
  try {
    const worldId = req.params.id;
    if (worldPreviewCache.has(worldId)) {
      return res.json({ world_id: worldId, data: worldPreviewCache.get(worldId) });
    }
    const worldRes = await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
    const world = worldRes.rows[0];
    if (!world) return res.status(404).json({ error: 'world not found' });

    const tileTypes = await getTileTypesMap();
    const data = generateWorldPreview(
      { seed: Number(world.seed), chunkSize: world.chunk_size, tileTypes },
      PREVIEW_DIM, PREVIEW_STRIDE,
    );
    worldPreviewCache.set(worldId, data);
    res.json({ world_id: worldId, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate world preview' });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/worldPreviewRoute.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full backend suite (no regressions)**

Run: `cd backend && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.js backend/tests/worldPreviewRoute.test.js
git commit -m "feat(world-preview): GET /api/worlds/:id/preview (memoized)"
```

---

### Task 3: `fetchWorldPreview` fetcher + `WorldPreview.jsx`

**Repo testing note:** the frontend vitest env is `node` and there are NO component/JSX tests (`MapPreview.jsx` itself is untested — rendering components are verified by build + browser). So this task unit-tests only the plain fetcher (node-env, `global.fetch` mock) and leaves `WorldPreview.jsx` untested like `MapPreview`. The fetcher lives in its own `net/` module (the convention used by the former `chunkFetcher`/`creatureClient`) so the test imports no React/query code.

**Files:**
- Create: `frontend/src/games/something2/src/js/net/worldPreviewClient.js` (plain `fetchWorldPreview`)
- Create: `frontend/src/games/something2/src/js/net/worldPreviewClient.test.js`
- Create: `frontend/src/games/something2/WorldPreview.jsx`

**Interfaces:**
- Consumes: `isoFit`/`draw` from `src/js/systems/mapPreviewRenderer.js`; `tileColors` prop (name→color).
- Produces: `fetchWorldPreview(worldId) -> Promise<{ world_id, data }>`; `WorldPreview({ worldId, tileColors })` React component rendering an iso thumbnail.

- [ ] **Step 1: Write the failing fetcher test**

`frontend/src/games/something2/src/js/net/worldPreviewClient.test.js`:
```js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWorldPreview } from './worldPreviewClient.js';

afterEach(() => vi.restoreAllMocks());

describe('fetchWorldPreview', () => {
  it('GETs the preview endpoint for the world and returns JSON', async () => {
    const body = { world_id: 'w1', data: [['grass', 'water']] };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await fetchWorldPreview('w1');
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/worlds\/w1\/preview$/));
    expect(res).toEqual(body);
  });

  it('throws on a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchWorldPreview('nope')).rejects.toThrow(/HTTP 404/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/worldPreviewClient.test.js`
Expected: FAIL — cannot resolve `./worldPreviewClient.js`.

- [ ] **Step 3: Implement the fetcher**

`frontend/src/games/something2/src/js/net/worldPreviewClient.js`:
```js
// Plain fetcher for a world's downsampled biome preview grid. Kept dependency-
// free (no React/query) so it is unit-testable in the node vitest env.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:13101';

export async function fetchWorldPreview(worldId) {
  const res = await fetch(`${API_URL}/api/worlds/${worldId}/preview`);
  if (!res.ok) throw new Error(`Failed to fetch world preview: HTTP ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run the fetcher test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/worldPreviewClient.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `WorldPreview.jsx`** (no unit test — mirrors `MapPreview.jsx`; verified by build + browser)

`frontend/src/games/something2/WorldPreview.jsx`:
```jsx
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import styled from 'styled-components';
import { fetchWorldPreview } from './src/js/net/worldPreviewClient.js';
import { isoFit, draw } from './src/js/systems/mapPreviewRenderer.js';

const REVEAL_MS = 700;

const Wrap = styled.div`position: relative; width: 100%; height: 100%;`;
const Canvas = styled.canvas`width: 100%; height: 100%; display: block;`;
const Overlay = styled.div`
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: rgba(255,255,255,0.4); font-size: 14px; pointer-events: none;
`;

export default function WorldPreview({ worldId, tileColors }) {
  const canvasRef = useRef(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['worldPreview', worldId],
    enabled: !!worldId,
    queryFn: () => fetchWorldPreview(worldId),
  });

  const tiles = Array.isArray(data?.data) && data.data.length ? data.data : null;

  // Live inputs read by the loop without restarting it.
  const tilesRef = useRef(null);
  const colorsRef = useRef(null);
  useEffect(() => { tilesRef.current = tiles; colorsRef.current = tileColors; });

  // Reveal then static; restarts when the selected world changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    let raf = 0, start = null;

    const sizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    };
    sizeCanvas();

    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const t = tilesRef.current;
      const cw = canvas.width, ch = canvas.height;
      const boxW = cw / dpr, boxH = ch / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, boxW, boxH);
      if (!t) return;
      if (start == null) start = now;
      const rows = t.length, cols = t[0].length;
      const fit = isoFit(rows, cols, boxW, boxH, 12);
      const progress = Math.min(1, (now - start) / REVEAL_MS);
      draw(ctx, { tiles: t, tileColors: colorsRef.current, entities: null, fit, revealProgress: progress });
    };
    raf = requestAnimationFrame(frame);

    const onResize = () => sizeCanvas();
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  }, [worldId]);

  return (
    <Wrap>
      <Canvas ref={canvasRef} />
      {(isLoading || isError || !tiles) && (
        <Overlay>{isError ? 'Preview unavailable' : (isLoading ? 'Loading preview…' : 'No preview')}</Overlay>
      )}
    </Wrap>
  );
}
```

- [ ] **Step 6: Run the frontend suite (no regressions)**

Run: `cd frontend && npm test`
Expected: all pass (existing + the new fetcher test). `WorldPreview.jsx` has no unit test by design (mirrors `MapPreview.jsx`).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/src/js/net/worldPreviewClient.js frontend/src/games/something2/src/js/net/worldPreviewClient.test.js frontend/src/games/something2/WorldPreview.jsx
git commit -m "feat(world-preview): fetchWorldPreview fetcher + WorldPreview component"
```

---

### Task 4: Wire `WorldPreview` into the preview pane

**Files:**
- Modify: `frontend/src/games/something2/Something2.jsx`

**Interfaces:**
- Consumes: `WorldPreview` (Task 3), the existing `selectedWorldId`/`selectedMapId`/`tileColors`.
- Produces: the preview pane shows the world's thumbnail when a world is selected.

- [ ] **Step 1: Import `WorldPreview`**

Near the `MapPreview` import (`import MapPreview from "./MapPreview.jsx";`), add:
```jsx
import WorldPreview from "./WorldPreview.jsx";
```

- [ ] **Step 2: Add the world branch in the preview pane**

In the preview-pane block, the current structure is:
```jsx
          {!isPlaying && selectedMapId && (
            <MapPreview mapId={selectedMapId} tileColors={tileColors} />
          )}
          {!isPlaying && !selectedMapId && (
            <div style={{ /* placeholder */ }}>
              Select a world to preview it, then Enter World.
            </div>
          )}
```
Change the second block so a selected world renders `WorldPreview`, and the placeholder only shows when neither is selected:
```jsx
          {!isPlaying && selectedMapId && (
            <MapPreview mapId={selectedMapId} tileColors={tileColors} />
          )}
          {!isPlaying && !selectedMapId && selectedWorldId && (
            <WorldPreview worldId={selectedWorldId} tileColors={tileColors} />
          )}
          {!isPlaying && !selectedMapId && !selectedWorldId && (
            <div style={{
              width: '100%', height: '100%', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'rgba(255,255,255,0.35)', fontSize: '15px'
            }}>
              Select a world to preview it, then Enter World.
            </div>
          )}
```

- [ ] **Step 3: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: all pass (existing + WorldPreview tests).

- [ ] **Step 4: Production build**

Run: `cd frontend && npm run build`
Expected: build succeeds (no unresolved imports).

- [ ] **Step 5: Live browser verification**

With the backend running and a world created:
1. Open the Worlds browser; select a world.
2. Confirm the preview pane shows an iso biome thumbnail (colored diamonds) of the world, with the reveal animation, replacing the "Select a world…" placeholder.
3. Select a different-seed world → the preview changes (different biome layout).
4. Console clean (one `GET /api/worlds/:id/preview` per selected world; cached on repeat).
Record observations in the task report. If browser runtime isn't available, note it and rely on the suite + build.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/Something2.jsx
git commit -m "feat(world-preview): show WorldPreview in the worlds browser"
```

---

## Self-Review

**1. Spec coverage:**
- `generateWorldPreview(world, dim, stride)` strided biome sampling, centered on origin → Task 1. ✓
- `GET /api/worlds/:id/preview` + in-memory memo + 404 → Task 2. ✓
- `fetchWorldPreview` + `WorldPreview.jsx` reusing `mapPreviewRenderer` + `tileColors` → Task 3. ✓
- Wire into the preview pane's world branch → Task 4. ✓
- `PREVIEW_DIM=64`, `PREVIEW_STRIDE=8`, biome-only, no migration → Tasks 1-2 + Global Constraints. ✓
- Error/overlay states → Task 3 component. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has full code. Task 3 Step 5 flags a real dependency check (RTL availability) rather than assuming — acceptable (it names the check + fallback).

**3. Type consistency:**
- `generateWorldPreview(world, dim, stride) -> string[][]` consistent between Task 1 def and Task 2 call (`PREVIEW_DIM`, `PREVIEW_STRIDE`). ✓
- Route response `{ world_id, data }` produced in Task 2, consumed by `fetchWorldPreview` → `data.data` grid in Task 3. ✓
- `WorldPreview({ worldId, tileColors })` signature identical in Task 3 def and Task 4 usage. ✓
- `isoFit(rows, cols, boxW, boxH, pad)` / `draw(ctx, {tiles, tileColors, entities, fit, revealProgress})` match the existing `mapPreviewRenderer.js` signatures used by `MapPreview`. ✓

---
