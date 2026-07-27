# Wall Rendering & Occlusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render wall tiles as 3D blocks with height, make players/creatures hide behind them via one unified depth-sorted pass with a `place_order` override, and fade occluding walls to 0.3 within a radius of any actor.

**Architecture:** A data-driven `wall_height` (+ `place_order`) on tile types and `place_order` on entity types (migration + serialization). A new pure `wallRenderer.js` computes wall-block geometry, the drawable comparator, and the reveal predicate, and draws the extruded textured block. `RenderSystem.renderChunked` splits into Pass A (flat floor tiles, as today) and Pass B (walls + entities in one `place_order`-then-depth sort), fading occluding walls.

**Tech Stack:** Frontend — Canvas 2D, Vitest. Backend — Express, `pg`, `node-pg-migrate`, `node --test` (supertest + `__setPool`).

## Global Constraints

- Frontend tests: **Vitest**. Backend tests: **`node --test`** (`node:test`/`node:assert`, `supertest`, exported `__setPool`).
- Iso projection: `worldToScreen`/`depthKey` from `core/iso.js`; `depthKey(wx,wy) = wx+wy`; diamond `ISO_TILE_W=128` (`halfW=64`), `ISO_TILE_H=64` (`halfH=32`).
- New columns default so today's rendering is **byte-identical**: `tile_types.wall_height int default 0`, `tile_types.place_order int default 0`, `entity_types.place_order int default 0`.
- Seed heights (idempotent): `map_wall`/`wooden_wall` → `wall_height = 48`; `village_gate`/`map_doorway` → `wall_height = 24`. All others `0`.
- Reveal radius **`R = 150`** px. Occluding-wall test: a wall reveals an actor when `actor.depth <= wall.depth` (wall not behind the actor) AND the actor center is within `R` of the wall-tile center. Faded walls draw at `globalAlpha = 0.3`.
- Migration timestamp must be **strictly greater than `1714440037000`** (latest existing). Use `1714440038000`. Verify with `ls backend/migrations` first (repo has had a timestamp collision).
- `chunkTileCells` yields `{ worldX, worldY, tile }` (tile CENTER world coords). Tile defs reach the client via `getTileTypesMap` → `/api/map/tiles`.

---

### Task 1: Backend — schema, seed, and serialization of `wall_height` / `place_order`

**Files:**
- Create: `backend/migrations/1714440038000_wall_render_fields.js`
- Modify: `backend/src/index.js` — `getTileTypesMap` (~line 214), `getEntityTypesMap` (~line 238)
- Test: `backend/tests/wall_fields_serialization.test.js`

**Interfaces:**
- Produces: `/api/map/tiles` tile defs each carry `wall_height` (number, default 0) and `place_order` (number, default 0). `/api/map/config` entity types carry `place_order` (default 0). The renderer (Task 3) reads `def.wall_height` / `def.place_order` and `entityType.place_order`.

- [ ] **Step 1: Write the migration**

```js
// backend/migrations/1714440038000_wall_render_fields.js
exports.shorthands = undefined;

// Wall rendering: wall_height > 0 makes a tile render as a raised block that
// occludes; place_order is a manual draw-order override (default 0 => pure iso
// depth sort, i.e. today's behavior). Defaults keep every existing tile flat.
exports.up = (pgm) => {
  pgm.addColumns('tile_types', {
    wall_height: { type: 'integer', notNull: true, default: 0 },
    place_order: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addColumns('entity_types', {
    place_order: { type: 'integer', notNull: true, default: 0 },
  });
  // Seed structural tile heights (idempotent — keyed by name).
  pgm.sql(`UPDATE tile_types SET wall_height = 48 WHERE name IN ('map_wall', 'wooden_wall')`);
  pgm.sql(`UPDATE tile_types SET wall_height = 24 WHERE name IN ('village_gate', 'map_doorway')`);
};

exports.down = (pgm) => {
  pgm.dropColumns('tile_types', ['wall_height', 'place_order']);
  pgm.dropColumns('entity_types', ['place_order']);
};
```

- [ ] **Step 2: Write the failing test**

```js
// backend/tests/wall_fields_serialization.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

function poolWith(tileRows, entityRows) {
  return {
    query: async (sql) => {
      if (/FROM tile_types/i.test(sql)) return { rows: tileRows };
      if (/FROM entity_types/i.test(sql)) return { rows: entityRows };
      return { rows: [] };
    },
  };
}

test('/api/map/tiles exposes wall_height and place_order (with a wall value and a defaulted one)', async () => {
  __setPool(poolWith(
    [
      { id: 1, name: 'map_wall', color: '#888', walkable: false, speed: 1, wall_height: 48, place_order: 0 },
      { id: 2, name: 'grass', color: '#3a5', walkable: true, speed: 1 }, // no wall fields -> default 0
    ],
    [],
  ));
  const res = await request(app).get('/api/map/tiles');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.map_wall.wall_height, 48);
  assert.strictEqual(res.body.map_wall.place_order, 0);
  assert.strictEqual(res.body.grass.wall_height, 0);   // defaulted
  assert.strictEqual(res.body.grass.place_order, 0);
});

test('/api/map/config exposes entity place_order defaulting to 0', async () => {
  __setPool(poolWith(
    [],
    [{ id: 1, name: 'Wolf', color: '#777', walkable: true, place_order: 5 },
     { id: 2, name: 'Slime', color: '#5a5' }], // no place_order -> default 0
  ));
  const res = await request(app).get('/api/map/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.entityTypes.Wolf.place_order, 5);
  assert.strictEqual(res.body.entityTypes.Slime.place_order, 0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && node --test tests/wall_fields_serialization.test.js`
Expected: FAIL — `wall_height`/`place_order` are `undefined` in the response.

- [ ] **Step 4: Extend serialization**

In `getTileTypesMap` (the `tileTypes[row.name] = { ... }` object, ~line 214), add:
```js
      wall_height: row.wall_height ?? 0,
      place_order: row.place_order ?? 0,
```
In `getEntityTypesMap` (the `entityTypes[row.name] = { ... }` object, ~line 238), add:
```js
      place_order: row.place_order ?? 0,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && node --test tests/wall_fields_serialization.test.js`
Expected: PASS (2 tests). Also run the full suite once: `node --test` (expect no regressions).

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/1714440038000_wall_render_fields.js backend/src/index.js backend/tests/wall_fields_serialization.test.js
git commit -m "feat(render): wall_height + place_order columns, seed, and serialization"
```

---

### Task 2: Frontend — `wallRenderer.js` pure geometry, comparator, reveal predicate

**Files:**
- Create: `frontend/src/games/something2/src/js/systems/wallRenderer.js`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/wallRenderer.test.js`

**Interfaces:**
- Produces:
  - `wallFaces(s, halfW, halfH, H)` → `{ top:[{x,y}×4], left:[{x,y}×4], right:[{x,y}×4] }`. `top` is the diamond lifted by `H`; `left`/`right` are the two camera-facing vertical faces.
  - `compareDrawables(a, b)` → number. Sort key `(order asc, then depth asc)`.
  - `wallRevealed(wall, actors, R)` → boolean. `wall={x,y,depth}`, `actors=[{x,y,depth}]`. True iff some actor has `actor.depth <= wall.depth` and is within `R` of `(wall.x, wall.y)`.
  - `drawWall(ctx, { s, def, visual, H, alpha, halfW, halfH, tileCache })` → void (canvas; added in Task 3-adjacent but defined here). Verified in the browser task, not unit-tested.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { wallFaces, compareDrawables, wallRevealed } from '../wallRenderer.js';

describe('wallFaces', () => {
  it('lifts the top diamond by H and builds the two south faces', () => {
    const f = wallFaces({ x: 100, y: 100 }, 64, 32, 48);
    // top diamond corners, each lifted by H=48: top, right, bottom, left
    expect(f.top).toEqual([
      { x: 100, y: 20 }, { x: 164, y: 52 }, { x: 100, y: 84 }, { x: 36, y: 52 },
    ]);
    // left (SW) face: liftedLeft, liftedBottom, groundBottom, groundLeft
    expect(f.left).toEqual([
      { x: 36, y: 52 }, { x: 100, y: 84 }, { x: 100, y: 132 }, { x: 36, y: 100 },
    ]);
    // right (SE) face: liftedBottom, liftedRight, groundRight, groundBottom
    expect(f.right).toEqual([
      { x: 100, y: 84 }, { x: 164, y: 52 }, { x: 164, y: 100 }, { x: 100, y: 132 },
    ]);
  });
});

describe('compareDrawables', () => {
  it('sorts by order first, then depth', () => {
    expect(compareDrawables({ order: 0, depth: 10 }, { order: 0, depth: 5 })).toBeGreaterThan(0);
    expect(compareDrawables({ order: 1, depth: 0 }, { order: 0, depth: 999 })).toBeGreaterThan(0); // higher order always later
    expect(compareDrawables({ order: 0, depth: 5 }, { order: 0, depth: 5 })).toBe(0);
  });
});

describe('wallRevealed', () => {
  const wall = { x: 100, y: 100, depth: 200 };
  it('reveals when an actor is behind-or-equal and within R', () => {
    expect(wallRevealed(wall, [{ x: 120, y: 100, depth: 180 }], 150)).toBe(true); // behind (180<=200), 20px away
  });
  it('does not reveal an actor in front of the wall', () => {
    expect(wallRevealed(wall, [{ x: 110, y: 100, depth: 260 }], 150)).toBe(false); // in front (260>200)
  });
  it('does not reveal when out of radius', () => {
    expect(wallRevealed(wall, [{ x: 400, y: 400, depth: 100 }], 150)).toBe(false);
  });
  it('is false with no actors', () => {
    expect(wallRevealed(wall, [], 150)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/wallRenderer.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// frontend/src/games/something2/src/js/systems/wallRenderer.js
// Pure geometry + draw for extruded wall blocks, plus the unified-pass
// comparator and the see-through reveal predicate. Iso diamonds are 2:1;
// worldToScreen returns the tile diamond CENTRE, so faces are built around it.

// Top diamond lifted by H, and the two camera-facing (south-west / south-east)
// vertical faces extruded straight down by H.
export function wallFaces(s, halfW, halfH, H) {
  const liftedTop = { x: s.x, y: s.y - halfH - H };
  const liftedRight = { x: s.x + halfW, y: s.y - H };
  const liftedBottom = { x: s.x, y: s.y + halfH - H };
  const liftedLeft = { x: s.x - halfW, y: s.y - H };
  const groundRight = { x: s.x + halfW, y: s.y };
  const groundBottom = { x: s.x, y: s.y + halfH };
  const groundLeft = { x: s.x - halfW, y: s.y };
  return {
    top: [liftedTop, liftedRight, liftedBottom, liftedLeft],
    left: [liftedLeft, liftedBottom, groundBottom, groundLeft],
    right: [liftedBottom, liftedRight, groundRight, groundBottom],
  };
}

// Unified draw order: higher place_order always paints later (on top); within
// the same order, back-to-front by iso depth. Default order 0 => pure depth.
export function compareDrawables(a, b) {
  return (a.order - b.order) || (a.depth - b.depth);
}

// A wall "reveals" (fades for) an actor it could be occluding: the actor is
// behind-or-level with the wall (actor.depth <= wall.depth) and within R px of
// the wall tile centre. Walls the actor stands in front of never fade.
export function wallRevealed(wall, actors, R) {
  const r2 = R * R;
  for (const a of actors) {
    if (a.depth > wall.depth) continue;
    const dx = a.x - wall.x, dy = a.y - wall.y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

// Map an image (or crop) onto a parallelogram face defined by 3 corners:
// p0 (origin), p1 (image +x edge end), p3 (image +y edge end). Clips to the
// face, draws the texture skewed, then a translucent shade for a depth cue.
function drawTexturedFace(ctx, img, crop, p0, p1, p3, p2, shade) {
  const [sx, sy, sw, sh] = crop || [0, 0, img.width, img.height];
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath();
  ctx.clip();
  // Affine: image (sw×sh) -> parallelogram p0->p1 (x), p0->p3 (y).
  const ux = (p1.x - p0.x) / sw, uy = (p1.y - p0.y) / sw;
  const vx = (p3.x - p0.x) / sh, vy = (p3.y - p0.y) / sh;
  ctx.setTransform(ux, uy, vx, vy, p0.x, p0.y);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = shade;
  ctx.fill();
  ctx.restore();
}

function fillQuad(ctx, quad, style) {
  ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y);
  for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
  ctx.closePath();
  ctx.fillStyle = style;
  ctx.fill();
}

// Draw one wall block. `visual` is resolveTileVisual's {img, crop, cacheKey} or
// null (color-only tile). Faces are drawn first, top last (over them).
export function drawWall(ctx, { s, def, visual, H, alpha, halfW, halfH, tileCache }) {
  const f = wallFaces(s, halfW, halfH, H);
  ctx.globalAlpha = alpha;
  const color = (def && def.color) || '#555';
  if (visual && visual.img) {
    const crop = visual.crop || null;
    // left face p0=liftedLeft, p1=liftedBottom, p3=groundLeft, p2=groundBottom
    drawTexturedFace(ctx, visual.img, crop, f.left[0], f.left[1], f.left[3], f.left[2], 'rgba(0,0,0,0.28)');
    // right face p0=liftedBottom, p1=liftedRight, p3=groundBottom, p2=groundRight
    drawTexturedFace(ctx, visual.img, crop, f.right[0], f.right[1], f.right[3], f.right[2], 'rgba(0,0,0,0.45)');
    // top diamond via the existing tile cache, lifted by H
    const cv = tileCache.get(visual.cacheKey, visual.img, visual.crop);
    ctx.drawImage(cv, s.x - halfW, (s.y - H) - halfH);
  } else {
    fillQuad(ctx, f.left, shadeColor(color, -0.28));
    fillQuad(ctx, f.right, shadeColor(color, -0.45));
    fillQuad(ctx, f.top, color);
  }
  ctx.globalAlpha = 1;
}

// Darken a #rrggbb (or #rrggbbaa) hex by `amt` in [-1,0]; falls back to input.
function shadeColor(hex, amt) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '');
  if (!m) return hex;
  const f = (h) => Math.max(0, Math.min(255, Math.round(parseInt(h, 16) * (1 + amt))));
  return `rgb(${f(m[1])}, ${f(m[2])}, ${f(m[3])})`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/wallRenderer.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/wallRenderer.js frontend/src/games/something2/src/js/systems/__tests__/wallRenderer.test.js
git commit -m "feat(render): pure wall-block geometry, drawable comparator, reveal predicate"
```

---

### Task 3: Frontend — `RenderSystem` Pass A/B split, walls in the sort, reveal fade

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js` (the tile loop + drawables block in `renderChunked`, ~lines 91–146)
- Modify: `frontend/src/games/something2/src/js/entities/CreatureManager.js` (decorate creatures with `place_order` from their type)
- Test: `frontend/src/games/something2/src/js/systems/__tests__/wallPass.test.js`

**Interfaces:**
- Consumes: `wallFaces`/`compareDrawables`/`wallRevealed`/`drawWall` (Task 2); `def.wall_height`/`def.place_order` (Task 1); `depthKey` from `core/iso.js`; existing `resolveTileVisual`, `this._tileCache`, `RenderSystem.buildDrawables`.
- Produces: a static `RenderSystem.collectActors(player, remotePlayers, creatures)` → `[{x,y,depth}]` (actor centers, unit-testable) and the split render flow. Wall reveal radius const `WALL_REVEAL_R = 150`.

- [ ] **Step 1: Write the failing test (pure helper)**

```js
// frontend/src/games/something2/src/js/systems/__tests__/wallPass.test.js
import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';
import { depthKey } from '../../core/iso.js';

describe('RenderSystem.collectActors', () => {
  it('returns centre + depth for player, remotes, and creatures', () => {
    const player = { x: 0, y: 0, width: 64, height: 64 };
    const remotes = new Map([[7, { x: 100, y: 100, width: 64, height: 64 }]]);
    const creatures = [{ x: 200, y: 40, width: 32, height: 32 }];
    const actors = RenderSystem.collectActors(player, remotes, creatures);
    expect(actors).toContainEqual({ x: 32, y: 32, depth: depthKey(32, 32) });       // player centre
    expect(actors).toContainEqual({ x: 132, y: 132, depth: depthKey(132, 132) });   // remote
    expect(actors).toContainEqual({ x: 216, y: 56, depth: depthKey(216, 56) });     // creature
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/wallPass.test.js`
Expected: FAIL — `collectActors is not a function`.

- [ ] **Step 3: Add `collectActors` + the import**

At the top of `RenderSystem.js`, extend the imports:
```js
import { worldToScreen, depthKey } from "../core/iso.js"; // depthKey already imported
import { wallFaces, compareDrawables, wallRevealed, drawWall } from "./wallRenderer.js";
```
Add the constant near `PICKUP_RADIUS`:
```js
const WALL_REVEAL_R = 150; // px around an actor within which an occluding wall fades
```
Add the static method to the class:
```js
  // Actor centres (world px) + iso depth, for the wall reveal check. Players
  // and creatures store TOP-LEFT x/y; add half-extents to reach the centre.
  static collectActors(player, remotePlayers, creatures = []) {
    const out = [];
    const push = (o) => {
      const cx = o.x + (o.width || 64) / 2, cy = o.y + (o.height || 64) / 2;
      out.push({ x: cx, y: cy, depth: depthKey(cx, cy) });
    };
    if (player) push(player);
    if (remotePlayers) for (const [, p] of remotePlayers) push(p);
    for (const c of creatures) push(c);
    return out;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/wallPass.test.js`
Expected: PASS.

- [ ] **Step 5: Split the tile loop into Pass A (floor) + wall collection**

Replace the tile-drawing `for (const cell of chunkTileCells(...))` loop (~lines 94–115) so wall tiles are collected instead of flat-drawn:
```js
    const halfW = ISO_TILE_W / 2;
    const halfH = ISO_TILE_H / 2;
    const mapTiles = chunkedMap.mapTiles;
    const wallDrawables = [];
    for (const cell of chunkTileCells(chunkedMap, camera)) {
      const s = worldToScreen(cell.worldX, cell.worldY);
      const relX = s.x - camera.screenX;
      const relY = s.y - camera.screenY;
      if (relX < -camera.width || relX > camera.width || relY < -camera.height || relY > camera.height) continue;
      const def = mapTiles ? (mapTiles[cell.tile] || (Array.isArray(mapTiles) ? mapTiles.find(t => t.name === cell.tile || t.type === cell.tile) : null)) : null;
      const visual = this.tileTexturesOff ? null : resolveTileVisual(cell.tile, def, this.imageManager, this.nowMs);
      const H = def ? (def.wall_height || 0) : 0;
      const order = def ? (def.place_order || 0) : 0;
      if (H > 0 || order !== 0) {
        // Wall (or manually-layered) tile: defer to the depth-sorted Pass B.
        wallDrawables.push({
          kind: "wall", s, def, visual, H, order,
          x: cell.worldX, y: cell.worldY, depth: depthKey(cell.worldX, cell.worldY),
        });
        continue;
      }
      // Pass A: flat floor tile (unchanged).
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
    }
```

- [ ] **Step 6: Merge walls into the entity sort and fade occluders**

Replace the drawables block (~lines 120–146) so walls join the sort and draw with the reveal fade:
```js
    const drawables = RenderSystem.buildDrawables(player, { entities: creatures }, remotePlayers);
    for (const d of drawables) d.order = d.kind === "entity" ? (d.ref.place_order || 0) : 0;
    for (const gi of groundItems) {
      drawables.push({ kind: "grounditem", ref: gi, order: 0, depth: depthKey(gi.x - gi.width / 2, gi.y - gi.height / 2) });
    }
    for (const m of merchants) {
      drawables.push({ kind: "merchant", ref: m, order: 0, depth: depthKey(m.x, m.y) });
    }
    for (const w of wallDrawables) drawables.push(w);
    drawables.sort(compareDrawables);

    const actors = RenderSystem.collectActors(player, remotePlayers, creatures);
    for (const d of drawables) {
      if (d.kind === "wall") {
        const alpha = wallRevealed(d, actors, WALL_REVEAL_R) ? 0.3 : 1;
        drawWall(this.ctx, { s: d.s, def: d.def, visual: d.visual, H: d.H, alpha, halfW, halfH, tileCache: this._tileCache });
      } else if (d.kind === "player") this.drawCreature(d.ref, "player", 1);
      else if (d.kind === "remote") this.drawCreature(d.ref, "player", 0.85, d.userId);
      else if (d.kind === "grounditem") this.drawGroundItem(d.ref, inventory, player);
      else if (d.kind === "merchant") this.drawMerchant(d.ref);
      else this.drawEntity(d.ref);
    }
```

- [ ] **Step 7: Carry `place_order` onto creatures**

In `CreatureManager.js`, the `_decorate(creature)` method (~line 23) reads `const def = this.entityTypes && this.entityTypes[creature.type];` (with an early return when `def` is falsy) and then copies visual fields — the first is `creature.render_mode = def.render_mode || def.renderMode;` (~line 27). Right after that line, add:
```js
    creature.place_order = def.place_order || 0;
```
This is the only decoration site; confirm with `grep -n "render_mode\|place_order" CreatureManager.js`.

- [ ] **Step 8: Verify build + suite**

Run:
```bash
cd frontend && npx vitest run src/games/something2 && npm run build
```
Expected: all unit tests PASS; `vite build` clean.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/src/js/entities/CreatureManager.js frontend/src/games/something2/src/js/systems/__tests__/wallPass.test.js
git commit -m "feat(render): unified wall+entity depth sort with reveal-fade in RenderSystem"
```

---

### Task 4: Backend CRUD + admin editors for the new fields

**Files:**
- Modify: `backend/src/index.js` — `POST /api/tile-types` (~634), `PUT /api/tile-types/:id` (~657), `POST /api/entity-types` (~339), `PUT /api/entity-types/:id`
- Modify: `frontend/src/games/something2/TileTypesAdmin.jsx`, `frontend/src/games/something2/EntityTypesAdmin.jsx`
- Test: `backend/tests/wall_fields_crud.test.js`

**Interfaces:**
- Consumes: the columns from Task 1.
- Produces: tile CRUD accepts/persists `wall_height` + `place_order`; entity CRUD accepts/persists `place_order`. Admin forms expose numeric inputs for them.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/wall_fields_crud.test.js
// IMPORTANT: require the auth helper FIRST — it sets JWT_SECRET before index.js
// loads (mirrors catalogNameLength.test.js / mapsGenerateRoute.test.js).
const { adminToken, withAuth } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

test('POST /api/tile-types persists wall_height and place_order', async () => {
  let captured = null;
  // withAuth answers the adminGuard user lookup; the INSERT falls through here.
  __setPool({ query: withAuth(async (sql, params) => { captured = { sql, params }; return { rows: [{ id: 9 }] }; }) });
  const res = await request(app).post('/api/tile-types').set(...AUTH)
    .send({ name: 'brickwall', color: '#987', walkable: false, speed: 1, wall_height: 60, place_order: 2 });
  assert.strictEqual(res.status, 201);
  assert.match(captured.sql, /wall_height/);
  assert.match(captured.sql, /place_order/);
  assert.ok(captured.params.includes(60));
  assert.ok(captured.params.includes(2));
});
```

> `helpers/auth.js` exports `adminToken`, `withAuth`, `isUserLookup`, `ADMIN_USER_ROW` — the same helper `catalogNameLength.test.js` uses for admin-guarded CRUD routes. `withAuth(queryFn)` answers the `adminGuard` user lookup and passes every other query through to `queryFn`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/wall_fields_crud.test.js`
Expected: FAIL — the INSERT SQL has no `wall_height`/`place_order` columns.

- [ ] **Step 3: Add the fields to tile-types CRUD**

`POST /api/tile-types` — destructure and insert:
```js
    const { name, color, walkable, speed, image, valid_neighbors, prompt, wall_height, place_order } = req.body;
    // ...existing validation...
    const result = await pool.query(
      'INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors, prompt, wall_height, place_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
      [name, color, walkable ?? true, speed ?? 1.0, image || '', JSON.stringify(valid_neighbors || []), prompt || '', Number(wall_height) || 0, Number(place_order) || 0]
    );
```
`PUT /api/tile-types/:id` — add to the SET list:
```js
    const { name, color, walkable, speed, image, valid_neighbors, prompt, wall_height, place_order } = req.body;
    const result = await pool.query(
      "UPDATE tile_types SET name = $1, color = $2, walkable = $3, speed = $4, image = COALESCE(NULLIF($5, ''), image), valid_neighbors = $6, prompt = $7, wall_height = $8, place_order = $9, updated_at = CURRENT_TIMESTAMP WHERE id = $10 RETURNING *",
      [name, color, walkable, speed, image, JSON.stringify(valid_neighbors), prompt || '', Number(wall_height) || 0, Number(place_order) || 0, id]
    );
```
`POST`/`PUT /api/entity-types` — add `place_order` to the destructure, the column list, the `VALUES` placeholders, and the params array (append `Number(place_order) || 0`). Follow the exact existing INSERT/UPDATE shape in those handlers.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/wall_fields_crud.test.js`
Expected: PASS. Also re-run Task-1's serialization test + `node --test` full suite.

- [ ] **Step 5: Add admin form inputs**

In `TileTypesAdmin.jsx`: add `wall_height: 0` and `place_order: 0` to the `formData` initial state and to the `setFormData({...})` that loads an editing tile (mirror the existing `speed` field), and render two `<input type="number">` fields bound to them (mirror the `speed` input's markup). If `validateTileType` exists, allow non-negative integers.
In `EntityTypesAdmin.jsx`: add a `place_order` numeric input the same way, wired into its form state and the create/update mutation payload.

- [ ] **Step 6: Verify build + suite**

Run: `cd frontend && npm run build` (expect clean). `cd backend && node --test` (expect green).

- [ ] **Step 7: Commit**

```bash
git add backend/src/index.js backend/tests/wall_fields_crud.test.js frontend/src/games/something2/TileTypesAdmin.jsx frontend/src/games/something2/EntityTypesAdmin.jsx
git commit -m "feat(render): admin CRUD + editor inputs for wall_height and place_order"
```

---

### Task 5: Browser verification (per project norm — a green suite is not sufficient)

**Files:** none (Chrome DevTools MCP per `browser-verification-lessons` / `dev-run-browser-verify`).

- [ ] **Step 1: Run the stack**

Ensure the backend picked up the migration (nodemon restarts on `src/` change; the migration runs on boot — confirm the new columns exist, e.g. the app boots without migration errors). Log in and enter a world that has walls (a bounded world / the walled village).

- [ ] **Step 2: Verify against the design's acceptance criteria**

- Walls render with visible **height** and textured, shaded side faces — not flat.
- Walk **behind** a wall → the player's body is hidden by it; walk **in front** → the player draws over it.
- **Stand behind** a wall → the covering wall fades to ~0.3 opacity (body shows through); step away → it returns to solid.
- A **creature** behind a wall fades that wall too.
- **Gates** (`village_gate`/`map_doorway`) render shorter (24) than walls (48).
- Set a tile or entity `place_order` in admin to a higher value and confirm it visibly draws above its neighbors; reset to 0 restores default ordering.
- Frame rate holds inside the walled village (watch for stutter from the textured side faces).

- [ ] **Step 3: Record the result**

Note pass/fail per criterion. Fix at the source and re-verify if anything fails — do not accept a green unit suite alone.

---

## Self-Review

**1. Spec coverage:** Data model → T1 (columns/serialization) + T4 (CRUD/admin). Wall rendering (block, textured sides) → T2 (`wallFaces`/`drawWall`) + T3 (invocation). Unified sort with `place_order` → T3 (Pass A/B + `compareDrawables`). Reveal bubble → T2 (`wallRevealed`) + T3 (fade). Seed heights → T1. Testing (unit + browser) → each task + T5. ✓

**2. Placeholder scan:** No TBD/TODO. Two spots defer to existing patterns with explicit grep instructions (creature decoration site in T3.7; admin auth helper + admin form markup in T4) rather than inventing unknown code — each names what to copy and where. Real code given for all novel logic. ✓

**3. Type consistency:** Drawable shape `{ kind, order, depth, ... }` and `compareDrawables(a,b)` use `order`/`depth` consistently across T2 and T3. Wall drawable `{ kind:'wall', s, def, visual, H, order, x, y, depth }` is produced in T3.5 and consumed in T3.6 (`drawWall({ s, def, visual, H, ... })`) — field names match Task 2's `drawWall` signature. `wallRevealed(wall, actors, R)` wall uses `{x,y,depth}` — the wall drawable carries `x,y,depth`. Actors `{x,y,depth}` from `collectActors`. `def.wall_height`/`def.place_order` (T1 serialization) match T3 reads. ✓
