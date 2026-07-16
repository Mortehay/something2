# Connected Chunked World — Phase 1 (Deterministic Global World Field) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a coordinate-addressed, deterministic terrain generator so any chunk of an infinite world can be produced independently and adjacent chunks line up seamlessly — delivering "terrain same by connected side" (SOMET-54).

**Architecture:** New pure functions in `backend/src/services/mapService.js` that sample terrain by *absolute world tile coordinates* instead of per-map local coordinates. A `generateRegion(world, rMin, cMin, rows, cols)` workhorse generates any rectangular window of the world; `generateChunk(world, cx, cy)` is a thin wrapper over it for a fixed `chunkSize × chunkSize` window. Because two adjacent chunks are just two windows into one global function, they are exactly the two halves of one directly-generated region — seams match with zero stitching code. Existing `generateWorld`/`valueNoise`/`placeEntities` are left untouched (no regression to the current `/api/maps/generate`).

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert` (run via `npm test` → `node --test`). No new dependencies.

## Global Constraints

- **Language/module system:** CommonJS (`require`/`module.exports`), Node's built-in test runner. No ESM, no Jest.
- **No new dependencies.** Pure JS only.
- **Determinism:** every generator output must be a pure function of its arguments (`worldSeed` + coordinates). No `Math.random`, no `Date.now`, no hidden global state.
- **Chunk model:** chunks tile the world **without overlap**. Chunk `(cx, cy)` owns world tile rows `[cy·N, cy·N+N)` and cols `[cx·N, cx·N+N)`, where `N = world.chunkSize` (default **64**).
- **Backward compatibility:** do not modify or remove existing exports (`generateWFC`, `generateWorld`, `placeEntities`, `makeRng`, `valueNoise`, `detectPathTile`, `carvePaths`, `uniqueTileNames`). Only add.
- **Coordinates may be negative** (chunks exist at negative `cx`/`cy`). All coordinate math must handle negatives.
- **Tile-types shape:** `tileTypes` is an object keyed by tile name, e.g. `{ grass: {...}, dirt: {...} }` — same shape `generateWorld` already accepts.

---

## World object convention

Every new function takes a `world` config object of this shape (defaults applied by `worldConfig`):

```js
// world = {
//   seed:       integer     (required; default 0)
//   chunkSize:  integer     (default 64)      — N, tiles per chunk side
//   tileTypes:  object      (required)        — { name: {...}, ... }
//   cellSize:   integer     (default 8)       — biome-noise lattice spacing (tiles)
//   pathTile:   string|null (default detectPathTile(names)) — tile used for carved paths
//   pathCell:   integer     (default 24)      — coarse path-anchor lattice spacing (tiles)
//   pathJitter: integer     (default 6)       — max anchor offset from lattice node (tiles)
// }
```

---

## File Structure

- **Modify:** `backend/src/services/mapService.js` — append new functions and extend `module.exports`. One responsibility added: absolute-coordinate world generation. (~120 new lines; the file already owns all map generation, so this is the right home.)
- **Create:** `backend/tests/worldGen.test.js` — focused test suite for the Phase 1 functions, kept separate from `mapService.test.js` so the seam/continuity intent is legible.

---

### Task 1: Coordinate-addressed noise primitives (`hash2`, `globalValueNoise`)

**Files:**
- Modify: `backend/src/services/mapService.js` (add functions + exports)
- Test: `backend/tests/worldGen.test.js` (create)

**Interfaces:**
- Consumes: nothing (new leaf functions).
- Produces:
  - `hash2(seed, x, y) -> number` in `[0, 1)` — deterministic hash of three integers; handles negative `x`/`y`.
  - `globalValueNoise(seed, gRow, gCol, cellSize) -> number` in `[0, 1]` — smoothstep-interpolated value-noise sampled at absolute coords.
  - `smoothstep(t) -> number` (module-local helper; not exported).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/worldGen.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

const {
  hash2,
  globalValueNoise,
} = require('../src/services/mapService');

test('hash2 is deterministic and in [0,1)', () => {
  const a = hash2(1234, 7, -3);
  const b = hash2(1234, 7, -3);
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 1, `out of range: ${a}`);
});

test('hash2 varies with each argument (incl. negatives)', () => {
  assert.notEqual(hash2(1, 0, 0), hash2(2, 0, 0));       // seed
  assert.notEqual(hash2(1, 0, 0), hash2(1, 1, 0));       // x
  assert.notEqual(hash2(1, 0, 0), hash2(1, 0, 1));       // y
  assert.notEqual(hash2(1, -1, 0), hash2(1, 1, 0));      // negative vs positive x
});

test('globalValueNoise is deterministic and in [0,1]', () => {
  const a = globalValueNoise(9, 100, 250, 8);
  const b = globalValueNoise(9, 100, 250, 8);
  assert.equal(a, b);
  assert.ok(a >= 0 && a <= 1, `out of range: ${a}`);
});

test('globalValueNoise is smooth (adjacent samples stay close)', () => {
  let maxJump = 0;
  for (let gc = 1; gc < 200; gc++) {
    maxJump = Math.max(
      maxJump,
      Math.abs(globalValueNoise(5, 40, gc, 8) - globalValueNoise(5, 40, gc - 1, 8)),
    );
  }
  assert.ok(maxJump < 0.35, `noise not smooth, maxJump ${maxJump}`);
});

test('globalValueNoise agrees at negative coordinates too', () => {
  const a = globalValueNoise(3, -64, -64, 8);
  const b = globalValueNoise(3, -64, -64, 8);
  assert.equal(a, b);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — `hash2` / `globalValueNoise` are `undefined` (not yet exported).

- [ ] **Step 3: Write minimal implementation**

In `backend/src/services/mapService.js`, add near the other helpers (after `makeRng`):

```js
// Smoothstep easing for value-noise interpolation.
function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Deterministic integer hash -> float in [0,1). Pure function of (seed, x, y);
// handles negative coordinates (chunks exist at negative cx/cy). This replaces
// the sequential-rng lattice of valueNoise with a coordinate-addressable one so
// any lattice node is reproducible without generating its neighbors.
function hash2(seed, x, y) {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h ^ (y | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Value noise sampled at ABSOLUTE world coords: bilinear-interpolate the four
// hashed lattice nodes surrounding (gRow, gCol). Same coords -> same value,
// regardless of which chunk asks -> adjacent chunks are continuous.
function globalValueNoise(seed, gRow, gCol, cellSize) {
  const gy = gRow / cellSize, gx = gCol / cellSize;
  const y0 = Math.floor(gy), x0 = Math.floor(gx);
  const sy = smoothstep(gy - y0), sx = smoothstep(gx - x0);
  const v00 = hash2(seed, x0, y0),     v10 = hash2(seed, x0 + 1, y0);
  const v01 = hash2(seed, x0, y0 + 1), v11 = hash2(seed, x0 + 1, y0 + 1);
  const top = v00 + (v10 - v00) * sx;
  const bot = v01 + (v11 - v01) * sx;
  return top + (bot - top) * sy;
}
```

Extend `module.exports` (add these keys to the existing object):

```js
  hash2,
  globalValueNoise,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (all four new tests; existing suites still green).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/worldGen.test.js
git commit -m "feat(worldgen): coordinate-addressed noise primitives (SOMET-54)"
```

---

### Task 2: Biome region + chunk wrapper (`generateRegion`, `generateChunk`, seam invariant)

**Files:**
- Modify: `backend/src/services/mapService.js` (add functions + exports)
- Test: `backend/tests/worldGen.test.js` (append)

**Interfaces:**
- Consumes: `globalValueNoise`, `detectPathTile` (existing), `smoothstep`.
- Produces:
  - `worldConfig(world) -> normalized` — fills defaults (`chunkSize=64`, `cellSize=8`, `pathCell=24`, `pathJitter=6`, `pathTile=detectPathTile(names)`), computes `names` (all tile names) and `biomeNames` (names minus `pathTile` when other tiles exist), throws if `tileTypes` is empty.
  - `sampleBiome(cfg, gRow, gCol) -> string` — biome tile name at absolute coords (paths applied later in `generateRegion`).
  - `generateRegion(world, rMin, cMin, rows, cols) -> string[][]` — a `rows × cols` grid whose cell `[r][c]` is the world tile at `(rMin + r, cMin + c)`. **This task: biomes only.**
  - `generateChunk(world, cx, cy) -> string[][]` — equals `generateRegion(world, cy·N, cx·N, N, N)` where `N = cfg.chunkSize`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/worldGen.test.js`:

```js
const {
  generateRegion,
  generateChunk,
  sampleBiome,
  worldConfig,
} = require('../src/services/mapService');

// Pure biomes (no path-like name) so this task's output is biome-only.
const BIOMES = { grass: {}, forest: {}, water: {}, meadow: {} };

test('worldConfig fills defaults and rejects empty tileTypes', () => {
  const cfg = worldConfig({ seed: 1, tileTypes: BIOMES });
  assert.equal(cfg.chunkSize, 64);
  assert.equal(cfg.cellSize, 8);
  assert.deepEqual(cfg.biomeNames.sort(), ['forest', 'grass', 'meadow', 'water']);
  assert.throws(() => worldConfig({ seed: 1, tileTypes: {} }));
});

test('generateChunk returns an N x N grid of valid biome names', () => {
  const world = { seed: 1, chunkSize: 16, tileTypes: BIOMES };
  const grid = generateChunk(world, 0, 0);
  assert.equal(grid.length, 16);
  assert.equal(grid[0].length, 16);
  const names = Object.keys(BIOMES);
  for (const row of grid) for (const cell of row) assert.ok(names.includes(cell));
});

test('generateChunk is deterministic per seed and coordinate', () => {
  const world = { seed: 42, chunkSize: 16, tileTypes: BIOMES };
  assert.deepEqual(generateChunk(world, 2, -3), generateChunk(world, 2, -3));
});

test('generateChunk equals the matching window of generateRegion', () => {
  const world = { seed: 7, chunkSize: 16, tileTypes: BIOMES };
  const chunk = generateChunk(world, 1, 2);              // cx=1, cy=2
  const region = generateRegion(world, 2 * 16, 1 * 16, 16, 16); // rMin=cy*N, cMin=cx*N
  assert.deepEqual(chunk, region);
});

// THE SEAM INVARIANT: two horizontally-adjacent chunks are exactly the left and
// right halves of one directly-generated 2N-wide region -> the boundary is
// continuous (terrain same by connected side).
test('horizontally-adjacent chunks match a directly-generated region', () => {
  const world = { seed: 11, chunkSize: 16, tileTypes: BIOMES };
  const N = 16;
  const left = generateChunk(world, 0, 0);
  const right = generateChunk(world, 1, 0);
  const direct = generateRegion(world, 0, 0, N, 2 * N); // rows=N, cols=2N
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      assert.equal(left[r][c], direct[r][c], `left seam mismatch @${r},${c}`);
      assert.equal(right[r][c], direct[r][c + N], `right seam mismatch @${r},${c}`);
    }
  }
});

// The same invariant vertically (north/south seam).
test('vertically-adjacent chunks match a directly-generated region', () => {
  const world = { seed: 13, chunkSize: 16, tileTypes: BIOMES };
  const N = 16;
  const top = generateChunk(world, 0, 0);
  const bottom = generateChunk(world, 0, 1);
  const direct = generateRegion(world, 0, 0, 2 * N, N); // rows=2N, cols=N
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      assert.equal(top[r][c], direct[r][c], `top seam mismatch @${r},${c}`);
      assert.equal(bottom[r][c], direct[r + N][c], `bottom seam mismatch @${r},${c}`);
    }
  }
});

test('biomes are cohesive, not per-tile noise', () => {
  const world = { seed: 3, chunkSize: 60, tileTypes: BIOMES };
  const grid = generateChunk(world, 0, 0);
  let same = 0, total = 0;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 1; c < grid[r].length; c++) { total++; if (grid[r][c] === grid[r][c - 1]) same++; }
  }
  assert.ok(same / total > 0.6, `sameness ${same / total}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — `generateRegion` / `generateChunk` / `sampleBiome` / `worldConfig` undefined.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/services/mapService.js`, add (after the Task 1 functions; `detectPathTile` already exists above in the file):

```js
// Normalize a world config, applying defaults and deriving name lists. Throws
// on empty tileTypes (a world must have at least one tile).
function worldConfig(world = {}) {
  const tileTypes = world.tileTypes || {};
  const names = Object.keys(tileTypes);
  if (names.length === 0) throw new Error('worldConfig: tileTypes is empty');
  const pathTile = world.pathTile !== undefined
    ? world.pathTile
    : detectPathTile(names);
  const biomeNames = pathTile && names.length > 1
    ? names.filter((n) => n !== pathTile)
    : names;
  return {
    seed: world.seed || 0,
    chunkSize: world.chunkSize || 64,
    cellSize: world.cellSize || 8,
    pathCell: world.pathCell || 24,
    pathJitter: world.pathJitter || 6,
    pathTile,
    names,
    biomeNames,
  };
}

// Biome tile name at absolute world coords: band the global noise value across
// the biome names (path tile excluded — paths are stamped separately).
function sampleBiome(cfg, gRow, gCol) {
  const v = globalValueNoise(cfg.seed, gRow, gCol, cfg.cellSize);
  const idx = Math.min(cfg.biomeNames.length - 1, Math.floor(v * cfg.biomeNames.length));
  return cfg.biomeNames[idx];
}

// Generate an arbitrary rows x cols window of the world. Cell [r][c] is the
// world tile at (rMin + r, cMin + c). Biomes only for now; paths overlaid in
// Task 3. generateChunk is a fixed-size wrapper over this.
function generateRegion(world, rMin, cMin, rows, cols) {
  const cfg = worldConfig(world);
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) {
      row[c] = sampleBiome(cfg, rMin + r, cMin + c);
    }
    grid[r] = row;
  }
  return grid;
}

function generateChunk(world, cx, cy) {
  const cfg = worldConfig(world);
  const N = cfg.chunkSize;
  return generateRegion(world, cy * N, cx * N, N, N);
}
```

Extend `module.exports`:

```js
  worldConfig,
  sampleBiome,
  generateRegion,
  generateChunk,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (all Task 2 tests; Task 1 + existing suites still green).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/worldGen.test.js
git commit -m "feat(worldgen): deterministic biome region + chunk with seam invariant (SOMET-54)"
```

---

### Task 3: Global carved paths (continuous across seams)

**Files:**
- Modify: `backend/src/services/mapService.js` (add path functions; overlay into `generateRegion`)
- Test: `backend/tests/worldGen.test.js` (append)

**Interfaces:**
- Consumes: `worldConfig`, `hash2`, `makeRng` (existing), `clamp` (existing module-local helper).
- Produces:
  - `pathAnchor(cfg, pi, pj) -> [gRow, gCol]` — deterministic jittered anchor position (absolute world tile) for coarse path-lattice node `(pi, pj)`.
  - `pathSegmentCells(cfg, pi, pj, dir) -> Array<[gRow, gCol]>` — cells of the winding trail from node `(pi,pj)` to its neighbor in `dir` (`'E'` or `'S'`). Deterministic (seeded by `hash2` of node + dir).
  - `collectPathCells(cfg, rMin, cMin, rows, cols) -> Set<string>` — set of `"gRow,gCol"` keys for every path cell inside the window `[rMin,rMin+rows) × [cMin,cMin+cols)`.
  - Behavior change: `generateRegion` overlays `cfg.pathTile` on cells in `collectPathCells` (only when `cfg.pathTile` is set).

**Why paths stay continuous:** a segment's cells are a pure function of its two coarse-node ids + `seed` + `dir`, computed identically no matter which window asks. So `collectPathCells` over any window is just the global path set clipped to that window — the assembled-equals-direct invariant from Task 2 now also covers paths.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/worldGen.test.js`:

```js
const { collectPathCells } = require('../src/services/mapService');

// Tiles WITH a path-like name -> paths get carved.
const PATH_TILES = { grass: {}, forest: {}, water: {}, dirt: {} };

test('paths are carved when a path tile exists', () => {
  const world = { seed: 3, chunkSize: 48, tileTypes: PATH_TILES };
  const grid = generateChunk(world, 0, 0);
  let dirt = 0;
  for (const row of grid) for (const cell of row) if (cell === 'dirt') dirt++;
  assert.ok(dirt > 0, 'expected carved dirt path tiles');
});

test('collectPathCells is deterministic and window-consistent', () => {
  const cfg = worldConfig({ seed: 8, chunkSize: 48, tileTypes: PATH_TILES });
  const a = collectPathCells(cfg, 0, 0, 96, 96);
  const b = collectPathCells(cfg, 0, 0, 96, 96);
  assert.deepEqual([...a].sort(), [...b].sort());
  // A sub-window's path cells are exactly the full set restricted to that window.
  const sub = collectPathCells(cfg, 0, 0, 48, 48);
  for (const key of sub) assert.ok(a.has(key), `sub cell ${key} missing from full set`);
});

// SEAM INVARIANT WITH PATHS: adjacent chunks still equal one direct region,
// so any trail crossing the boundary is continuous.
test('adjacent chunks match a direct region even with paths', () => {
  const world = { seed: 21, chunkSize: 48, tileTypes: PATH_TILES };
  const N = 48;
  const left = generateChunk(world, 0, 0);
  const right = generateChunk(world, 1, 0);
  const direct = generateRegion(world, 0, 0, N, 2 * N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      assert.equal(left[r][c], direct[r][c], `left seam mismatch @${r},${c}`);
      assert.equal(right[r][c], direct[r][c + N], `right seam mismatch @${r},${c}`);
    }
  }
});

test('no path tile -> generateChunk carves nothing (pure biomes)', () => {
  const world = { seed: 3, chunkSize: 32, tileTypes: BIOMES }; // no path-like name
  const grid = generateChunk(world, 0, 0);
  const names = Object.keys(BIOMES);
  for (const row of grid) for (const cell of row) assert.ok(names.includes(cell));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — `collectPathCells` undefined, and `paths are carved` fails (no path overlay yet).

- [ ] **Step 3: Write minimal implementation**

In `backend/src/services/mapService.js`, add the path functions (after `generateChunk`). Note `clamp` already exists module-local (used by `walkPath`):

```js
// --- Global carved paths --------------------------------------------------
//
// Coarse path lattice: one anchor per `pathCell` tiles, jittered deterministically.
// Each anchor connects to its East and South neighbor via a biased random walk
// seeded ONLY by the two node ids -> the same trail cells regardless of which
// window regenerates them, so paths cross chunk seams continuously.

function pathAnchor(cfg, pi, pj) {
  const jr = Math.floor(hash2(cfg.seed ^ 0x1111, pi, pj) * (2 * cfg.pathJitter + 1)) - cfg.pathJitter;
  const jc = Math.floor(hash2(cfg.seed ^ 0x2222, pi, pj) * (2 * cfg.pathJitter + 1)) - cfg.pathJitter;
  return [pi * cfg.pathCell + jr, pj * cfg.pathCell + jc];
}

function pathSegmentCells(cfg, pi, pj, dir) {
  const from = pathAnchor(cfg, pi, pj);
  const to = dir === 'E' ? pathAnchor(cfg, pi, pj + 1) : pathAnchor(cfg, pi + 1, pj);
  // Deterministic per-segment RNG: distinct integer per (node, dir).
  const segSeed = (Math.imul(hash2(cfg.seed, pi, pj) * 4294967296 >>> 0, 31)
    ^ (dir === 'E' ? 0xE : 0x5)) >>> 0;
  const rng = makeRng(segSeed || 1);
  const cells = [];
  let [r, c] = from;
  const [tr, tc] = to;
  let guard = (cfg.pathCell + 2 * cfg.pathJitter) * 6 + 8;
  while ((r !== tr || c !== tc) && guard-- > 0) {
    cells.push([r, c]);
    const dr = Math.sign(tr - r), dc = Math.sign(tc - c);
    const roll = rng();
    if (roll < 0.45 && dr !== 0) r += dr;
    else if (roll < 0.9 && dc !== 0) c += dc;
    else if (rng() < 0.5 && dr !== 0) r += dr;
    else if (dc !== 0) c += dc;
    else if (dr !== 0) r += dr;
  }
  cells.push([tr, tc]);
  return cells;
}

// Every path cell inside the window [rMin,rMin+rows) x [cMin,cMin+cols).
// Iterate coarse nodes whose segments could reach the window (one extra ring),
// union their segment cells, clipped to the window.
function collectPathCells(cfg, rMin, cMin, rows, cols) {
  const set = new Set();
  if (!cfg.pathTile) return set;
  const rMax = rMin + rows, cMax = cMin + cols;
  // Coarse-node index range covering the window, padded by 1 node each side so
  // trails entering from outside are included.
  const piLo = Math.floor(rMin / cfg.pathCell) - 1;
  const piHi = Math.floor((rMax - 1) / cfg.pathCell) + 1;
  const pjLo = Math.floor(cMin / cfg.pathCell) - 1;
  const pjHi = Math.floor((cMax - 1) / cfg.pathCell) + 1;
  const add = (cells) => {
    for (const [r, c] of cells) {
      if (r >= rMin && r < rMax && c >= cMin && c < cMax) set.add(`${r},${c}`);
    }
  };
  for (let pi = piLo; pi <= piHi; pi++) {
    for (let pj = pjLo; pj <= pjHi; pj++) {
      add(pathSegmentCells(cfg, pi, pj, 'E'));
      add(pathSegmentCells(cfg, pi, pj, 'S'));
    }
  }
  return set;
}
```

Then overlay paths in `generateRegion` — replace its body with:

```js
function generateRegion(world, rMin, cMin, rows, cols) {
  const cfg = worldConfig(world);
  const paths = collectPathCells(cfg, rMin, cMin, rows, cols);
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const gRow = rMin + r, gCol = cMin + c;
      row[c] = cfg.pathTile && paths.has(`${gRow},${gCol}`)
        ? cfg.pathTile
        : sampleBiome(cfg, gRow, gCol);
    }
    grid[r] = row;
  }
  return grid;
}
```

Extend `module.exports`:

```js
  pathAnchor,
  pathSegmentCells,
  collectPathCells,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (Task 3 tests; all earlier suites still green — the seam invariant now holds *with* paths).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/worldGen.test.js
git commit -m "feat(worldgen): global carved paths continuous across seams (SOMET-54)"
```

---

### Task 4: Global object-density field (`densityAt`) for later entity phases

**Files:**
- Modify: `backend/src/services/mapService.js` (add function + export)
- Test: `backend/tests/worldGen.test.js` (append)

**Interfaces:**
- Consumes: `globalValueNoise`.
- Produces: `densityAt(world, gRow, gCol) -> number` in `[0,1]` — smooth object-density value at absolute coords, deterministic and seam-continuous. (Phases 2/5 read this to place clustered objects/creatures consistently across chunk boundaries; Phase 1 only establishes and tests the field.)

**Note:** density uses its own lattice frequency (independent of the biome field) by offsetting the seed, so clumps don't align 1:1 with biome bands. It intentionally does **not** reuse `placeEntities` (that's per-map, local-coordinate, and stays untouched for the legacy path).

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/worldGen.test.js`:

```js
const { densityAt } = require('../src/services/mapService');

test('densityAt is deterministic and in [0,1]', () => {
  const world = { seed: 5, tileTypes: BIOMES };
  const a = densityAt(world, 120, -40);
  assert.equal(a, densityAt(world, 120, -40));
  assert.ok(a >= 0 && a <= 1, `out of range: ${a}`);
});

test('densityAt is continuous across a chunk boundary', () => {
  const world = { seed: 5, chunkSize: 16, tileTypes: BIOMES };
  // Column 15 (last of chunk 0) vs column 16 (first of chunk 1): adjacent in
  // the field, so the density jump must be small.
  let maxJump = 0;
  for (let r = 0; r < 64; r++) {
    maxJump = Math.max(maxJump, Math.abs(densityAt(world, r, 16) - densityAt(world, r, 15)));
  }
  assert.ok(maxJump < 0.35, `density discontinuous at seam, maxJump ${maxJump}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — `densityAt` undefined.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/services/mapService.js`, add (after `collectPathCells`):

```js
// Global object-density field at absolute coords. Independent frequency + seed
// offset from the biome field so object clumps don't mirror biome bands. Read
// by later phases to place clustered objects/creatures consistently across
// chunk seams. Deterministic and continuous.
function densityAt(world, gRow, gCol) {
  const cfg = worldConfig(world);
  return globalValueNoise((cfg.seed ^ 0x9e3779b9) >>> 0, gRow, gCol, cfg.cellSize);
}
```

Extend `module.exports`:

```js
  densityAt,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS — full `worldGen.test.js` suite green, `mapService.test.js` + other backend suites still green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/worldGen.test.js
git commit -m "feat(worldgen): global object-density field for cross-seam placement (SOMET-54)"
```

---

## Self-Review

**1. Spec coverage (Phase 1 section of the design doc):**
- "biome field sampled by absolute world coords" → Task 2 (`sampleBiome`/`generateRegion`). ✓
- "`globalValueNoise(worldSeed, globalRow, globalCol, cellSize)` with hashed lattice, no per-map storage" → Task 1. ✓
- "`generateChunk(world, cx, cy)` returns N×N window" → Task 2. ✓
- "paths from a global path graph; each chunk renders the portion passing through it; fallback to no paths when no path tile" → Task 3 (`collectPathCells` + `no path tile` test). ✓
- "object-density noise sampled globally" → Task 4 (`densityAt`). ✓
- Acceptance "adjacent chunk edges match byte-for-byte; determinism; path continuity; no-path fallback" → Task 2 (biome seam invariant, determinism), Task 3 (path seam invariant, carve + fallback), Task 1 (noise determinism). ✓ (Formulated as the stronger *assembled-equals-direct-region* invariant, correct for non-overlapping chunks.)
- "This phase alone delivers requirement 1" → yes; no API/schema/frontend touched, all pure + unit-tested. Phase 2 (API/schema) and beyond are separate plans. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows complete code; every test step shows complete assertions. ✓

**3. Type consistency:** `world` object shape is identical across tasks (normalized once by `worldConfig`); `cfg` fields (`seed`, `chunkSize`, `cellSize`, `pathCell`, `pathJitter`, `pathTile`, `names`, `biomeNames`) are defined in Task 2 and used unchanged in Tasks 3–4. `generateRegion(world, rMin, cMin, rows, cols)` signature is stable; Task 3 changes only its body. `collectPathCells(cfg, rMin, cMin, rows, cols)` takes the normalized `cfg` (not raw `world`) — matches its one call site inside `generateRegion` and the test. Path cell key format `"gRow,gCol"` is identical in `collectPathCells` and `generateRegion`. ✓

## Out of scope for this plan (later phases, separate plans)
- `worlds` / `world_chunks` tables, `GET /api/worlds/:id/chunk`, `POST /api/worlds` → Phase 2 (SOMET-55).
- World-space coordinate util + client `ChunkedMap` → Phase 3 (SOMET-56).
- Client streaming + multi-chunk render → Phase 4 (SOMET-57).
- World-space free-roaming creatures → Phase 5 (SOMET-58).
