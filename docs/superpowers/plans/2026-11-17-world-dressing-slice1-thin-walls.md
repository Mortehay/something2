# World Dressing — Slice 1: Thin Connected Walls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render built walls as ¼-tile-thick connected segments at their current height instead of full-diamond cubes.

**Architecture:** Client-only. A wall tile becomes up to five non-overlapping world-space boxes (centre post + one arm per wall neighbour), each projected with the linear iso transform and extruded by the tile's `wall_height`. Boxes draw back-to-front inside the tile's existing depth-sort slot. Collision, server, and `resolveMove` are untouched.

**Tech Stack:** Plain ES modules, Canvas 2D, vitest (`cd frontend && npx vitest run <path>`).

**Spec:** `docs/superpowers/specs/2026-11-17-world-dressing-design.md` (Slice 1)

## Global Constraints

- Thickness = ¼ tile: `WALL_THICKNESS = 25` world px (`MAP_TILE_SIZE = 100`), so half-thickness 12.5.
- Height unchanged: each tile's own `wall_height` (48 walls, 24 gates/doorways).
- Whole tile still blocks movement — do NOT touch `systems/movement.js`, `ChunkedMap.isWalkable`, or anything in `backend/`.
- A neighbour connects iff its tile def has `wall_height > 0` (walls, gates, doorways, cave walls).
- `cave_wall` keeps the old full-block draw (natural rock mass, appears as biome terrain): `BLOCK_WALL_TILES = new Set(['cave_wall'])` in `wallRenderer.js`.
- Iso projection: screen delta of world delta `(dx,dy)` = `((dx-dy)*ISO_K, (dx+dy)*ISO_K/2)`, `ISO_K = 0.64` (`core/iso.js`). World +x = grid east (col+1), +y = grid south (row+1). Camera-facing faces are the box's +y (south) and +x (east) faces.
- Work in a worktree on branch `feat/world-dressing-thin-walls` (AGENTS.md worktree rules; link `frontend/node_modules`).

## Review Focus

1. **Neighbour chunk not loaded yet** (`getTileAt` → null): expect no arm toward it and no throw; the arm appears once the chunk streams in. → test in Task 3.
2. **Gate/doorway in a ring**: the walls either side must connect to it and it must draw as a thin segment too, so the ring reads closed. → test in Task 3.
3. **Isolated single wall tile**: post only, no arms. → test in Task 1.
4. **`cave_wall` regions** must look exactly as before (full block), while a thin wall next to cave rock still connects to it. → test in Task 3.
5. **Corner (L) and T junctions** must not show painter's-order artefacts (front arm hidden by back arm). → back-to-front order test in Task 2 + browser check in Task 4.

---

### Task 1: Thin-wall geometry

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/wallRenderer.js`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/wallRenderer.test.js`

**Interfaces:**
- Produces:
  - `export const WALL_THICKNESS = 25;`
  - `export function thinWallBoxes(nb, T = 100, thick = WALL_THICKNESS)` → array of `{x0,y0,x1,y1}` world-space rects relative to tile centre, **sorted back-to-front** (ascending `(x0+x1)/2 + (y0+y1)/2`). `nb = {n,e,s,w}` booleans. Post is `[-h,h]²` (`h = thick/2`); arm N = `{x0:-h,x1:h,y0:-T/2,y1:-h}`, S = `{-h,h,h,T/2}` (x0,x1,y0,y1), E = `{x0:h,x1:T/2,y0:-h,y1:h}`, W = `{x0:-T/2,x1:-h,y0:-h,y1:h}`.
  - `export function projectBox(s, rect, H)` → `{ top:[4 pts], south:[4 pts], east:[4 pts] }` screen quads. Top corners order: (x0,y0),(x1,y0),(x1,y1),(x0,y1) lifted by H. South face: lifted (x0,y1),(x1,y1), ground (x1,y1),(x0,y1). East face: lifted (x1,y0),(x1,y1), ground (x1,y1),(x1,y0).

- [ ] **Step 1: Write the failing tests**

```js
describe('thinWallBoxes', () => {
  it('isolated wall is a centre post only', () => {
    expect(thinWallBoxes({ n: false, e: false, s: false, w: false }))
      .toEqual([{ x0: -12.5, y0: -12.5, x1: 12.5, y1: 12.5 }]);
  });
  it('adds one arm per connected side, back-to-front', () => {
    const b = thinWallBoxes({ n: true, e: true, s: false, w: false });
    expect(b).toEqual([
      { x0: -12.5, y0: -50, x1: 12.5, y1: -12.5 }, // N arm (depth -31.25)
      { x0: -12.5, y0: -12.5, x1: 12.5, y1: 12.5 }, // post (0)
      { x0: 12.5, y0: -12.5, x1: 50, y1: 12.5 },    // E arm (+31.25)
    ]);
  });
});

describe('projectBox', () => {
  it('projects the post with ISO_K 0.64 and lifts the top by H', () => {
    const p = projectBox({ x: 0, y: 0 }, { x0: -12.5, y0: -12.5, x1: 12.5, y1: 12.5 }, 48);
    expect(p.top).toEqual([{ x: 0, y: -56 }, { x: 16, y: -48 }, { x: 0, y: -40 }, { x: -16, y: -48 }]);
    expect(p.south).toEqual([{ x: -16, y: -48 }, { x: 0, y: -40 }, { x: 0, y: 8 }, { x: -16, y: 0 }]);
    expect(p.east).toEqual([{ x: 16, y: -48 }, { x: 0, y: -40 }, { x: 0, y: 8 }, { x: 16, y: 0 }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/wallRenderer.test.js`
Expected: FAIL — `thinWallBoxes is not a function`.

- [ ] **Step 3: Implement `WALL_THICKNESS`, `thinWallBoxes`, `projectBox`** in `wallRenderer.js` (import `ISO_K` from `../core/iso.js`). Sort with a stable comparator on centre depth.

- [ ] **Step 4: Run tests — PASS** (same command; existing `wallFaces` tests still pass).

- [ ] **Step 5: Commit** — `feat(walls): thin wall box geometry`

---

### Task 2: `drawThinWall`

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/wallRenderer.js`
- Test: `frontend/src/games/something2/src/js/systems/__tests__/wallRenderer.test.js`

**Interfaces:**
- Consumes: Task 1 `thinWallBoxes`, `projectBox`; existing `drawTexturedFace`, `fillQuad`, `shadeColor`.
- Produces: `export function drawThinWall(ctx, { s, def, visual, H, alpha, neighbours })` — same arg shape as `drawWall` minus `halfW/halfH/tileCache`, plus `neighbours {n,e,s,w}`.

Per box, in the order `thinWallBoxes` returns: south face (shade `rgba(0,0,0,0.12)`), east face (`rgba(0,0,0,0.22)`), then top (cap shade `rgba(255,255,255,0.10)`). Textured: `drawTexturedFace(ctx, img, crop, p0, p1, p3, p2, shade)` with p0 = lifted-left corner, p1 = lifted-right corner, p3 = ground-left, p2 = ground-right of each face (top: p0=(x0,y0), p1=(x1,y0), p3=(x0,y1), p2=(x1,y1)). Untextured: `fillQuad` with `shadeColor(color,-0.12)`, `shadeColor(color,-0.22)`, `shadeColor(color,0.08)` — note `shadeColor` must accept a positive amount (clamped at 255; it already clamps). Sets `ctx.globalAlpha = alpha`, restores to 1.

- [ ] **Step 1: Write the failing tests** (ctx spy recording `fill` calls with the current path points; reuse the spy helper the file already uses for `drawWall`, or add one recording `moveTo/lineTo` per path)

```js
describe('drawThinWall', () => {
  const def = { color: '#806040' };
  it('colour-only isolated wall fills 3 quads: south, east, top', () => {
    const ctx = spyCtx();
    drawThinWall(ctx, { s: { x: 0, y: 0 }, def, visual: null, H: 48, alpha: 1, neighbours: { n: false, e: false, s: false, w: false } });
    expect(ctx.fills.length).toBe(3);
    expect(ctx.fills[2].points).toEqual([{ x: 0, y: -56 }, { x: 16, y: -48 }, { x: 0, y: -40 }, { x: -16, y: -48 }]);
  });
  it('draws each box faces-then-top, back box before front box', () => {
    const ctx = spyCtx();
    drawThinWall(ctx, { s: { x: 0, y: 0 }, def, visual: null, H: 48, alpha: 1, neighbours: { n: false, e: false, s: true, w: false } });
    expect(ctx.fills.length).toBe(6);
    // post top (3rd fill) is drawn before the S arm's south face (4th fill)
    expect(ctx.fills[2].points[0]).toEqual({ x: 0, y: -56 });
    expect(ctx.fills[3].points[0].y).toBeGreaterThan(ctx.fills[2].points[0].y);
  });
  it('restores globalAlpha to 1', () => {
    const ctx = spyCtx();
    drawThinWall(ctx, { s: { x: 0, y: 0 }, def, visual: null, H: 24, alpha: 0.4, neighbours: { n: true, e: false, s: false, w: false } });
    expect(ctx.globalAlpha).toBe(1);
  });
});
```

- [ ] **Step 2: Run — FAIL** (`drawThinWall is not a function`).
- [ ] **Step 3: Implement `drawThinWall`.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(walls): draw thin connected wall boxes`

---

### Task 3: Wire into the render pass

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/wallRenderer.js` (neighbour helper + `BLOCK_WALL_TILES`)
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js:~596-604` (wall drawable gets `neighbours`) and `:~736` (dispatch)
- Test: `frontend/src/games/something2/src/js/systems/__tests__/wallRenderer.test.js`, `.../__tests__/wallPass.test.js`

**Interfaces:**
- Consumes: `chunkedMap.getTileAt(worldX, worldY)` (null when unloaded), `chunkedMap._tileDef(name)` or the same def lookup RenderSystem uses; Task 2 `drawThinWall`.
- Produces:
  - `export const BLOCK_WALL_TILES = new Set(['cave_wall']);`
  - `export function wallNeighbours(getTile, getDef, worldX, worldY, T = 100)` → `{n,e,s,w}`; `n` checks `(worldX, worldY - T)`, `e` `(worldX + T, worldY)`, `s` `(worldX, worldY + T)`, `w` `(worldX - T, worldY)`; true iff tile non-null and `getDef(tile)?.wall_height > 0`.
  - Wall drawables gain `neighbours`; dispatch: `BLOCK_WALL_TILES.has(d.def?.name) ? drawWall(...) : drawThinWall(...)`. Neighbours are computed only for wall drawables (H > 0) and not for `order !== 0` floor overlays with H = 0 (those keep `drawWall`).

- [ ] **Step 1: Write the failing tests**

```js
describe('wallNeighbours', () => {
  const defs = { wooden_wall: { wall_height: 48 }, village_gate: { wall_height: 24 }, cave_wall: { wall_height: 48 }, grass: { wall_height: 0 } };
  const grid = new Map([['150,50', 'wooden_wall'], ['50,150', 'village_gate'], ['-50,50', 'grass']]);
  const getTile = (x, y) => grid.get(`${x},${y}`) ?? null; // (50,-50) absent = unloaded chunk
  const getDef = (n) => defs[n] || null;
  it('connects to walls and gates, not floor, not unloaded', () => {
    expect(wallNeighbours(getTile, getDef, 50, 50)).toEqual({ n: false, e: true, s: true, w: false });
  });
  it('connects to cave_wall', () => {
    const g = (x, y) => (x === 50 && y === -50 ? 'cave_wall' : null);
    expect(wallNeighbours(g, getDef, 50, 50).n).toBe(true);
  });
});
```

In `wallPass.test.js` add: a wooden_wall drawable dispatches to the thin path (assert by spy on fill count = 3 for an isolated wall vs 3 diamond-shaped fills whose top quad spans ±64 px for `cave_wall`: the cave_wall top's right corner x equals `s.x + 64`, the wooden_wall's equals `s.x + 16`). Follow the file's existing harness for building a pass.

- [ ] **Step 2: Run both files — FAIL.**
- [ ] **Step 3: Implement** `BLOCK_WALL_TILES`, `wallNeighbours`, and the RenderSystem changes (pass `(x,y) => chunkedMap.getTileAt(x,y)` and the existing def lookup).
- [ ] **Step 4: Run the full frontend suite** — `cd frontend && npx vitest run` — PASS, no new failures vs. `main` baseline (record baseline count before Task 1).
- [ ] **Step 5: Commit** — `feat(walls): render built walls as thin connected segments`

---

### Task 4: Browser verification

**Files:** none (evidence only; screenshots to the session scratchpad).

- [ ] **Step 1:** Run the dev stack per memory `dev-run-browser-verify` (headless Chrome with `--mute-audio`). Use the worktree's frontend build or the dev server pointed at the worktree.
- [ ] **Step 2:** Screenshot (a) a village ring with its gate, (b) a map-edge corner, (c) a cave_wall area (Umbral Warren / Deepvault world). Expected: (a) closed thin ring, gate thinner/lower and connected; (b) clean L corner, no front arm hidden; (c) cave rock unchanged full blocks.
- [ ] **Step 3:** Walk the player up to a thin wall from the south and east: player stops at the tile edge (unchanged collision); a player behind a wall still triggers the see-through fade.
- [ ] **Step 4:** Check frame time didn't regress noticeably: compare `performance` trace of a village view before/after (≤5 boxes per tile vs 1; expect small). Record numbers in the Plane ticket.
- [ ] **Step 5:** Merge to `main` (fast-forward, standing merge+push authorization per memory), push, remove worktree, move Plane item to Done with evidence.
