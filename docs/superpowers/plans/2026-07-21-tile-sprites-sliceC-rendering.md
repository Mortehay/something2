# Tile Sprites — Slice C (Rendering) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw each tile's approved texture (and animation) into the isometric ground diamond, cycling animated frames, with a clean fall back to the flat color and a global on/off toggle.

**Architecture:** The backend tile map gains `sprite` + `render_mode` so the client knows what to draw. Pure helpers pick the current visual (static image vs. animated atlas frame) and cache a diamond-masked canvas once per texture/frame; `RenderSystem`'s chunked tile loop draws the cached diamond (single `drawImage`) or falls back to the color fill. `Game.initChunked` preloads each tile's texture/atlas/manifest from `/api/assets/*`.

**Tech Stack:** Node/Express + `pg` (`node --test`, `__setPool`), React/Vite frontend (Vitest **node-env, no jsdom** — no canvas/DOM in tests), Canvas 2D.

## Global Constraints

- Rendering is strictly additive: a tile with `render_mode = 'color'` (every tile until one is generated+approved) must draw **exactly** as today (the flat color diamond). Missing/slow textures fall back to color — never a hole.
- The fallback chain is `animated → image → color` (mirrors the entity `animated → static → rect` degradation).
- Frontend Vitest is **node-env, no jsdom** — do NOT write tests that construct a real canvas/DOM or call `document.createElement`. Canvas drawing is verified by `vite build` + a browser pass. Pure logic (frame selection, visual resolution, cache-once orchestration) IS unit-tested.
- Storage/asset keys are bucket-prefixed (`sprites/tiles/<tile>/...`), served through `GET /api/assets/<key>` (Slice B). The client builds URLs as `${API_URL}/api/assets/${key}`.
- Backend runs `node src/index.js` (a PID, not nodemon) — restart it to load the Task 1 change; frontend source is volume-mounted (HMR).

---

### Task 1: Expose `sprite` + `render_mode` in the tile map

**Files:**
- Modify: `backend/src/index.js` — `getTileTypesMap()` (around `backend/src/index.js:67-81`)
- Test: `backend/tests/tile_map_fields.test.js`

**Interfaces:**
- Consumes: `tile_types.sprite` (jsonb), `tile_types.render_mode` (text) — Slice A columns.
- Produces: `getTileTypesMap()` output objects gain `sprite` and `render_mode`; surfaced by `GET /api/map/tiles` and `GET /api/map/config` (both already call `getTileTypesMap`). The client `mapTiles[name]` def now carries `{ id, color, walkable, speed, image, sprite, render_mode, validNeighbors }`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/tile_map_fields.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

// GET /api/map/tiles is a public passthrough of getTileTypesMap — no auth.
function mockPool(rows) {
  return { query: async () => ({ rows }) };
}

test('GET /api/map/tiles exposes sprite and render_mode per tile', async () => {
  __setPool(mockPool([
    { id: 1, name: 'grass', color: '#0f0', walkable: true, speed: 1,
      image: 'sprites/tiles/grass/static.png', valid_neighbors: ['grass'],
      sprite: null, render_mode: 'image' },
    { id: 2, name: 'water', color: '#00f', walkable: false, speed: 0,
      image: '', valid_neighbors: ['water'],
      sprite: { atlas_key: 'sprites/tiles/water/atlas.png', manifest_key: 'sprites/tiles/water/atlas.json', frames: 4 },
      render_mode: 'animated' },
  ]));
  const res = await request(app).get('/api/map/tiles');
  assert.equal(res.status, 200);
  assert.equal(res.body.grass.render_mode, 'image');
  assert.equal(res.body.grass.image, 'sprites/tiles/grass/static.png');
  assert.equal(res.body.grass.sprite, null);
  assert.equal(res.body.water.render_mode, 'animated');
  assert.deepEqual(res.body.water.sprite, { atlas_key: 'sprites/tiles/water/atlas.png', manifest_key: 'sprites/tiles/water/atlas.json', frames: 4 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/tile_map_fields.test.js`
Expected: FAIL — `res.body.grass.render_mode` is `undefined` (fields not in the map yet).

- [ ] **Step 3: Add the two fields to `getTileTypesMap`**

In `backend/src/index.js`, change the mapping object inside `getTileTypesMap`:

```js
    tileTypes[row.name] = {
      id: row.id,
      color: row.color,
      walkable: row.walkable,
      speed: row.speed,
      image: row.image,
      validNeighbors: row.valid_neighbors || []
    };
```
to:
```js
    tileTypes[row.name] = {
      id: row.id,
      color: row.color,
      walkable: row.walkable,
      speed: row.speed,
      image: row.image,
      sprite: row.sprite || null,
      render_mode: row.render_mode || 'color',
      validNeighbors: row.valid_neighbors || []
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/tile_map_fields.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && node --test`
Expected: all pass (a single flaky `connection terminated` integration failure can be re-run once).

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.js backend/tests/tile_map_fields.test.js
git commit -m "feat(tiles): expose sprite + render_mode in the tile map"
```

---

### Task 2: Pure render helpers — frame selection, visual resolution, diamond cache

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/spriteAtlas.js` (add `tileFrameKey`, `resolveTileVisual`)
- Create: `frontend/src/games/something2/src/js/systems/tileTexture.js` (`TileDiamondCache`)
- Test: `frontend/src/games/something2/src/js/systems/__tests__/tileTexture.test.js`

**Interfaces:**
- Consumes: `frameRect(manifest, key)` (existing in spriteAtlas.js); an `imageManager` with `.get(key) -> img|null`; a tile `def` `{ color, image, sprite, render_mode }`; the animation manifest `{ cell, frames: { "0":[x,y,w,h], ... } }`.
- Produces:
  - `tileFrameKey(manifest, timeMs, fps=4) -> string|null` — the current frame index key (`"0"`,`"1"`,…) cycling at `fps`, or null if no frames.
  - `resolveTileVisual(tileName, def, imageManager, nowMs, override=null) -> { img, crop, cacheKey } | null` — the source image + optional `[x,y,w,h]` crop + a stable cache key; `null` means "draw the color". Fallback order animated→image→color.
  - `class TileDiamondCache { constructor(buildFn); get(cacheKey, img, crop) -> canvas }` — memoizes one built canvas per `cacheKey`, calling `buildFn(img, crop)` at most once per key.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/systems/__tests__/tileTexture.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { tileFrameKey, resolveTileVisual } from '../spriteAtlas.js';
import { TileDiamondCache } from '../tileTexture.js';

const MANIFEST = { cell: [10, 10], frames: { '0': [0, 0, 10, 10], '1': [10, 0, 10, 10],
  '2': [0, 10, 10, 10], '3': [10, 10, 10, 10] } };

describe('tileFrameKey', () => {
  it('cycles frame indices at fps over time', () => {
    // fps=4 → each frame lasts 250ms; at t=0 → "0", t=300 → "1", t=600 → "2".
    expect(tileFrameKey(MANIFEST, 0, 4)).toBe('0');
    expect(tileFrameKey(MANIFEST, 300, 4)).toBe('1');
    expect(tileFrameKey(MANIFEST, 600, 4)).toBe('2');
    // wraps after the last frame
    expect(tileFrameKey(MANIFEST, 1000, 4)).toBe('0');
  });
  it('returns null when there are no frames', () => {
    expect(tileFrameKey({ frames: {} }, 0)).toBeNull();
    expect(tileFrameKey(null, 0)).toBeNull();
  });
});

describe('resolveTileVisual', () => {
  const loadedImg = { _tag: 'img' };
  const loadedAtlas = { _tag: 'atlas' };

  it('returns null for color mode (draw the flat diamond)', () => {
    const def = { color: '#0f0', render_mode: 'color' };
    expect(resolveTileVisual('grass', def, { get: () => null }, 0)).toBeNull();
  });

  it('image mode returns the whole static image (no crop) when loaded', () => {
    const def = { render_mode: 'image', image: 'k/static.png' };
    const im = { get: (k) => (k === 'k/static.png' ? loadedImg : null) };
    const v = resolveTileVisual('grass', def, im, 0);
    expect(v).toEqual({ img: loadedImg, crop: null, cacheKey: 'grass|image' });
  });

  it('image mode returns null while the texture is still loading (→ color)', () => {
    const def = { render_mode: 'image', image: 'k/static.png' };
    expect(resolveTileVisual('grass', def, { get: () => null }, 0)).toBeNull();
  });

  it('animated mode crops the current atlas frame when atlas+manifest are ready', () => {
    const def = { render_mode: 'animated', image: 'w/static.png',
      sprite: { atlas_key: 'w/atlas.png' }, _manifest: MANIFEST };
    const im = { get: (k) => (k === 'w/atlas.png' ? loadedAtlas : null) };
    const v = resolveTileVisual('water', def, im, 300);  // frame "1"
    expect(v).toEqual({ img: loadedAtlas, crop: [10, 0, 10, 10], cacheKey: 'water|animated|1' });
  });

  it('animated mode falls back to the static image when the manifest is missing', () => {
    const def = { render_mode: 'animated', image: 'w/static.png',
      sprite: { atlas_key: 'w/atlas.png' } /* no _manifest */ };
    const im = { get: (k) => (k === 'w/static.png' ? loadedImg : null) };
    const v = resolveTileVisual('water', def, im, 0);
    expect(v).toEqual({ img: loadedImg, crop: null, cacheKey: 'water|image' });
  });

  it('override forces the mode', () => {
    const def = { render_mode: 'animated', image: 'k/static.png', color: '#0f0' };
    // override 'color' → null even though the def says animated
    expect(resolveTileVisual('grass', def, { get: () => ({}) }, 0, 'color')).toBeNull();
  });
});

describe('TileDiamondCache', () => {
  it('builds a canvas once per cache key and returns the cached instance', () => {
    const build = vi.fn((img, crop) => ({ built: img, crop }));
    const cache = new TileDiamondCache(build);
    const a1 = cache.get('grass|image', { i: 1 }, null);
    const a2 = cache.get('grass|image', { i: 1 }, null);
    expect(a1).toBe(a2);
    expect(build).toHaveBeenCalledTimes(1);
    cache.get('water|animated|1', { i: 2 }, [0, 0, 8, 8]);
    expect(build).toHaveBeenCalledTimes(2);  // new key → rebuild
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/tileTexture.test.js`
Expected: FAIL — `tileFrameKey`/`resolveTileVisual` not exported; `tileTexture.js` missing.

- [ ] **Step 3: Add `tileFrameKey` and `resolveTileVisual` to `spriteAtlas.js`**

Append to `frontend/src/games/something2/src/js/systems/spriteAtlas.js`:

```js
// --- Tiles -----------------------------------------------------------------
// Tile atlases are keyed by bare frame index ("0","1",...), not "DIR/idx".

// The current tile animation frame key at `timeMs`, cycling at `fps`. Null if
// the manifest has no frames.
export function tileFrameKey(manifest, timeMs, fps = 4) {
  const frames = (manifest && manifest.frames) || {};
  const idxs = Object.keys(frames)
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!idxs.length) return null;
  const i = Math.floor((timeMs / 1000) * fps) % idxs.length;
  return String(idxs[i]);
}

// Decide what to draw for a tile: the animated atlas frame, the static image,
// or nothing (draw the flat color). Returns { img, crop, cacheKey } or null.
// `crop` is an [x,y,w,h] rect into `img`, or null to use the whole image.
// Pure: reads imageManager.get(key) (null until loaded) so a not-yet-loaded
// texture degrades to color rather than a hole.
export function resolveTileVisual(tileName, def, imageManager, nowMs, override = null) {
  if (!def || !imageManager) return null;
  const mode = override || def.render_mode || def.renderMode || 'color';
  if (mode === 'color') return null;

  if (mode === 'animated' && def.sprite && def._manifest) {
    const fkey = tileFrameKey(def._manifest, nowMs);
    const rect = fkey ? frameRect(def._manifest, fkey) : null;
    const atlas = def.sprite.atlas_key ? imageManager.get(def.sprite.atlas_key) : null;
    if (atlas && rect) {
      return { img: atlas, crop: rect, cacheKey: `${tileName}|animated|${fkey}` };
    }
    // fall through to the static image if the atlas/manifest isn't usable
  }

  if (def.image) {
    const img = imageManager.get(def.image);
    if (img) return { img, crop: null, cacheKey: `${tileName}|image` };
  }
  return null;
}
```

- [ ] **Step 4: Create `tileTexture.js`**

Create `frontend/src/games/something2/src/js/systems/tileTexture.js`:

```js
import { ISO_TILE_W, ISO_TILE_H } from '../core/constants.js';

// Build an ISO_TILE_W x ISO_TILE_H canvas with `img` (optionally the `crop`
// sub-rect) clipped to the iso diamond, so the render loop can blit it with a
// single drawImage. Canvas-only — never called in the node test env.
export function buildDiamondCanvas(img, crop) {
  const W = ISO_TILE_W, H = ISO_TILE_H;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = false;
  cx.beginPath();
  cx.moveTo(W / 2, 0);
  cx.lineTo(W, H / 2);
  cx.lineTo(W / 2, H);
  cx.lineTo(0, H / 2);
  cx.closePath();
  cx.clip();
  if (crop) {
    const [sx, sy, sw, sh] = crop;
    cx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  } else {
    cx.drawImage(img, 0, 0, W, H);
  }
  return c;
}

// Memoizes one built canvas per cacheKey so the diamond mask is applied ONCE
// per texture/frame, not once per visible cell per frame. `buildFn` defaults to
// buildDiamondCanvas but is injectable for testing.
export class TileDiamondCache {
  constructor(buildFn = buildDiamondCanvas) {
    this._build = buildFn;
    this._cache = new Map();
  }

  get(cacheKey, img, crop) {
    let canvas = this._cache.get(cacheKey);
    if (!canvas) {
      canvas = this._build(img, crop);
      this._cache.set(cacheKey, canvas);
    }
    return canvas;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/tileTexture.test.js`
Expected: PASS (all cases).

- [ ] **Step 6: Run the full frontend test suite (no regressions)**

Run: `cd frontend && npx vitest run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/spriteAtlas.js \
        frontend/src/games/something2/src/js/systems/tileTexture.js \
        frontend/src/games/something2/src/js/systems/__tests__/tileTexture.test.js
git commit -m "feat(tiles): pure tile-visual resolver + diamond-mask cache"
```

---

### Task 3: Render textured diamonds in the chunked tile loop

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js` (constructor; `renderChunked` tile loop `:95-116`; add a toggle method)
- Test: none automated (canvas — no jsdom). `vite build` + browser.

**Interfaces:**
- Consumes: `resolveTileVisual`, `tileFrameKey` (Task 2), `TileDiamondCache`, `buildDiamondCanvas` (Task 2); the def now carries `sprite`/`render_mode` (Task 1) and `_manifest` (attached by Task 4's preload).
- Produces: the chunked tile loop draws a cached masked diamond when a texture is resolved, else the flat color; `this.nowMs` set each chunked frame; `toggleTileTextures()` flips `this.tileTexturesOff`.

> **No unit test:** the change is Canvas 2D drawing with no jsdom harness. The cache-once and resolver logic it uses are unit-tested in Task 2. Verify via `vite build` + the Task 4 browser pass.

- [ ] **Step 1: Add imports and constructor state**

In `RenderSystem.js`, add to the imports at the top:

```js
import { resolveTileVisual } from "./spriteAtlas.js";
import { TileDiamondCache } from "./tileTexture.js";
```
(`resolveTileVisual` may be added to the existing `spriteAtlas` import line instead.)

In the constructor (after `this.renderModeOverride = null;` at `:24`), add:

```js
    this.tileTexturesOff = false;
    this._tileCache = new TileDiamondCache();
```

Add the toggle method next to `cycleRenderModeOverride` (`:37`):

```js
  // Dev toggle: textured tiles on/off (falls back to flat color when off).
  toggleTileTextures() {
    this.tileTexturesOff = !this.tileTexturesOff;
    return !this.tileTexturesOff;
  }
```

- [ ] **Step 2: Set `nowMs` and draw textured/fallback diamonds in the tile loop**

In `renderChunked`, add the frame timestamp right after the background fill (`this.ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);` at `:96`), because — unlike `render()` — `renderChunked` never set it:

```js
    this.nowMs = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
```

Replace the tile-fill body of the loop. Change:

```js
      const def = mapTiles ? (mapTiles[cell.tile] || (Array.isArray(mapTiles) ? mapTiles.find(t => t.name === cell.tile || t.type === cell.tile) : null)) : null;
      this.ctx.fillStyle = def ? def.color : "#123";
      this.ctx.beginPath();
      this.ctx.moveTo(s.x, s.y - halfH);
      this.ctx.lineTo(s.x + halfW, s.y);
      this.ctx.lineTo(s.x, s.y + halfH);
      this.ctx.lineTo(s.x - halfW, s.y);
      this.ctx.closePath();
      this.ctx.fill();
```
to:
```js
      const def = mapTiles ? (mapTiles[cell.tile] || (Array.isArray(mapTiles) ? mapTiles.find(t => t.name === cell.tile || t.type === cell.tile) : null)) : null;
      const visual = this.tileTexturesOff ? null
        : resolveTileVisual(cell.tile, def, this.imageManager, this.nowMs);
      if (visual) {
        const cv = this._tileCache.get(visual.cacheKey, visual.img, visual.crop);
        this.ctx.drawImage(cv, s.x - halfW, s.y - halfH);
      } else {
        this.ctx.fillStyle = def ? def.color : "#123";
        this.ctx.beginPath();
        this.ctx.moveTo(s.x, s.y - halfH);
        this.ctx.lineTo(s.x + halfW, s.y);
        this.ctx.lineTo(s.x, s.y + halfH);
        this.ctx.lineTo(s.x - halfW, s.y);
        this.ctx.closePath();
        this.ctx.fill();
      }
```

(The masked canvas is `ISO_TILE_W x ISO_TILE_H` with the diamond spanning it, so drawing at `s.x - halfW, s.y - halfH` centers it on the tile — the same center the color diamond uses.)

- [ ] **Step 3: Build the frontend**

Run: `cd frontend && npx vite build`
Expected: `✓ built` with no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/RenderSystem.js
git commit -m "feat(tiles): draw textured/animated diamonds with color fallback"
```

---

### Task 4: Preload tile assets + wire the toggle key; browser-verify in-world

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (`initChunked` `:214-240`; the keydown handler near `cycleRenderModeOverride` at `:632-638`)
- Test: none automated (network + canvas). `vite build` + browser.

**Interfaces:**
- Consumes: `this.imageManager.load(key, url)` (existing); `API_URL` (`:35`); the `tileTypes` map passed into `initChunked`, which is stored as `chunkedMap.mapTiles` (same object the renderer reads — mutating a def's `_manifest` is visible to the renderer).
- Produces: on chunked join, each tile's static texture + animation atlas are loaded into `imageManager` from `/api/assets/*`, and each animated tile's manifest JSON is fetched and attached as `def._manifest`; the `t` key toggles tile textures.

> **No unit test:** network fetch + canvas render, no jsdom. Verify with `vite build` + the browser pass in Step 3.

- [ ] **Step 1: Preload tile assets in `initChunked`**

In `Game.js`, add a helper method to the class (e.g. right after `initChunked`):

```js
    // Preload approved tile textures/atlases so the renderer can draw them.
    // Fire-and-forget image loads (the renderer falls back to color until they
    // arrive); animated tiles also need their atlas manifest, fetched inline
    // and attached to the shared def so RenderSystem can crop frames.
    async _preloadTileAssets(tileTypes) {
      if (!tileTypes) return;
      for (const def of Object.values(tileTypes)) {
        const mode = def.render_mode || def.renderMode;
        if (def.image) {
          this.imageManager.load(def.image, `${API_URL}/api/assets/${def.image}`);
        }
        if (mode === 'animated' && def.sprite) {
          if (def.sprite.atlas_key) {
            this.imageManager.load(def.sprite.atlas_key, `${API_URL}/api/assets/${def.sprite.atlas_key}`);
          }
          if (def.sprite.manifest_key && !def._manifest) {
            try {
              const r = await fetch(`${API_URL}/api/assets/${def.sprite.manifest_key}`);
              if (r.ok) def._manifest = await r.json();
            } catch (_) { /* leave unset → renderer uses the static image or color */ }
          }
        }
      }
    }
```

Call it in `initChunked` right after the chunked map is created (`this.chunkedMap = new ChunkedMap(chunkSize, tileTypes);` at `:238`):

```js
        this.chunkedMap = new ChunkedMap(chunkSize, tileTypes);
        this._preloadTileAssets(tileTypes);
```

(Do not `await` it — loads are fire-and-forget so join isn't blocked on textures.)

- [ ] **Step 2: Wire the `t` toggle key**

Find the keydown handling near the render-mode toggle (`Game.js:632-638`, where `'m'` calls `cycleRenderModeOverride`). Add a `t` case alongside it, e.g.:

```js
            } else if (key === 't' && this.renderSystem && this.chunked) {
                const on = this.renderSystem.toggleTileTextures();
                if (this.toast) this.toast(`Tile textures ${on ? 'on' : 'off'}`);
            }
```

Match the surrounding structure exactly (the real anchor may differ slightly — locate the `key === 'm'` branch and mirror its shape; if there is no `this.toast`, omit the toast line).

- [ ] **Step 3: Build the frontend**

Run: `cd frontend && npx vite build`
Expected: `✓ built` with no errors.

- [ ] **Step 4: Restart the backend (Task 1 change) and browser-verify in-world**

The backend runs a long-lived `node` process (not nodemon):
```bash
BPID=$(docker exec something2-backend-1 sh -c "pgrep -f 'node src/index.js'")
docker exec something2-backend-1 sh -c "kill $BPID"
docker exec -d something2-backend-1 sh -c 'cd /app && nohup node src/index.js > /tmp/backend.log 2>&1 &'
sleep 3 && curl -s http://localhost:13101/api/health
```

Then, signed in as admin in the browser:
1. **TILE_TYPES Admin → Edit grass → Generate texture → Approve texture** (stub gives a small coloured disc). Confirm `render_mode` is `image` (re-open Edit).
   - Ground-truth: `curl -s http://localhost:13101/api/map/tiles | ` inspect — `grass.render_mode === 'image'`, `grass.image` set, and `curl -s -o /dev/null -w '%{http_code}' http://localhost:13101/api/assets/<grass image key>` → 200.
2. Go to **Game View**, select a chunked world (e.g. **Overworld**), **Enter World (chunked)**. The grass diamonds now render the generated texture (masked into the diamond) instead of flat green; un-generated tiles still draw their flat color.
3. Press **`t`** → tiles revert to flat color; press again → textures return.
4. (Animation) Approve an **animation** on **water**, re-enter → water diamonds cycle frames. Un-approved tiles unaffected.

> If a tile still shows flat color after approving + entering: check the texture actually loaded (`Network` tab shows `200` for `/api/assets/<key>`), and that `mapTiles` came from a fresh `/api/map/tiles` fetch (React Query key `['mapTiles']` is invalidated on approve). A stale Vite bundle or the backend not restarted (Task 1) are the usual causes — reload / restart before suspecting the code.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js
git commit -m "feat(tiles): preload tile textures/atlases + 't' texture toggle"
```

---

## Notes for the executor

- This slice makes approved tiles finally render in-world — it is the payoff of Slices A/B. Un-generated tiles (`render_mode = 'color'`, the default for all 11 seeded tiles) must look identical to before.
- Everything runs on `stub` today (placeholder discs), so the in-world texture will be a coloured blob, not real art — that is expected; real SD is the `SPRITE_BACKEND` env flip from Slice B.
- The `_manifest` attached to a def during preload is read by `resolveTileVisual`; because `chunkedMap.mapTiles` is the same object passed to `initChunked`, the attachment is visible to the renderer without extra plumbing.
- After all tasks, the whole-branch review should confirm: color-mode tiles unchanged, the diamond mask is cached once per texture/frame (not per cell), animated frames cycle off `nowMs`, and a missing/slow texture degrades to color rather than a hole.
