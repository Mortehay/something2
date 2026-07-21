# Linked Maps — Slice 1: Bounded Worlds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the live `worlds` system an optional rectangular boundary — a non-walkable wall ring (with walkable doorway gaps) — so a "map" is a bounded, walk-around area, without touching networking or teleport.

**Architecture:** All chunk/region terrain flows through one funnel, `generateRegion(world, rMin, cMin, rows, cols)` in `backend/src/services/mapService.js`. We add a pure overlay, `stampBounds`, that rewrites boundary cells to a `map_wall` tile (and doorway-gap cells to a `map_doorway` tile) after biome+path fill. Collision is already tile-based (`isWalkable` reads `tile_types.walkable`), so a non-walkable wall tile blocks movement server- and client-side for free, and the client renders the new tiles as ordinary colored diamonds with no new channel.

**Tech Stack:** Node/Express + `pg`, `node-pg-migrate`, `node --test` (backend); Vite/React + Vitest (frontend, node env, NO jsdom).

## Global Constraints

- Backend is CommonJS; tests run with `node --test`. Frontend tests run with Vitest in **node env (no jsdom)**.
- New tile type names are exactly `map_wall` (walkable=false) and `map_doorway` (walkable=true). Do not rename.
- Doorway gap width is exactly `DOORWAY_TILES = 3` tiles, centered on its edge.
- Boundary columns on `worlds`: `width int NULL`, `height int NULL` (tiles; both NULL ⇒ unbounded, unchanged behavior). Also add (used by later slices, defaulted so they are inert now): `creature_count int NOT NULL DEFAULT 0`, `allowed_creature_types jsonb NOT NULL DEFAULT '[]'`, `is_entry boolean NOT NULL DEFAULT false`, `entry_spawn jsonb NULL`.
- Migration filename timestamp must be greater than the current max `1714440026000`. Use `1714440027000`.
- The infinite Overworld (width/height NULL) must generate **byte-identical** terrain to today — bounds logic only runs when both `width` and `height` are set.
- Backend migrate command (from `backend/`): `DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate -- up` (and `... -- down` to revert). Creds: user `user`, db `game_db`.
- Slice 1 gives every bounded world a doorway on **all four edges** (a default so the box is traversable for testing). Slice 3 replaces that default with link-driven doorways + teleport. Keep the doorway source isolated in one helper (`doorwaysForWorld`) so Slice 3 swaps it in one place.

---

### Task 1: Migration — bounded-world columns + wall/doorway tile types

**Files:**
- Create: `backend/migrations/1714440027000_bounded_worlds.js`
- Test: `backend/tests/bounded_worlds_migration.test.js`

**Interfaces:**
- Produces: exported constants `MAP_TILE_TYPES` (array of `{ name, color, walkable, speed }`) so later tasks/tests reference the exact seed values. Tile names `map_wall`, `map_doorway`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/bounded_worlds_migration.test.js
const test = require('node:test');
const assert = require('node:assert');
const { MAP_TILE_TYPES } = require('../migrations/1714440027000_bounded_worlds.js');

test('seeds a non-walkable map_wall and a walkable map_doorway tile type', () => {
  const byName = Object.fromEntries(MAP_TILE_TYPES.map((t) => [t.name, t]));
  assert.ok(byName.map_wall, 'map_wall must be seeded');
  assert.equal(byName.map_wall.walkable, false, 'map_wall must block movement');
  assert.ok(byName.map_doorway, 'map_doorway must be seeded');
  assert.equal(byName.map_doorway.walkable, true, 'map_doorway must be passable');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/bounded_worlds_migration.test.js`
Expected: FAIL — `Cannot find module '../migrations/1714440027000_bounded_worlds.js'`.

- [ ] **Step 3: Write the migration**

```js
// backend/migrations/1714440027000_bounded_worlds.js
exports.shorthands = undefined;

// Two tile types that make a world's boundary: a solid wall and a passable
// doorway. Colors are plain hex; no single quotes so direct SQL interpolation
// is safe (matches the create_tile_types seed style).
const MAP_TILE_TYPES = [
  { name: 'map_wall', color: '#2b2b2b', walkable: false, speed: 1.0 },
  { name: 'map_doorway', color: '#6b4f2a', walkable: true, speed: 1.0 },
];

exports.up = (pgm) => {
  pgm.addColumns('worlds', {
    width: { type: 'integer', notNull: false },
    height: { type: 'integer', notNull: false },
    creature_count: { type: 'integer', notNull: true, default: 0 },
    allowed_creature_types: { type: 'jsonb', notNull: true, default: '[]' },
    is_entry: { type: 'boolean', notNull: true, default: false },
    entry_spawn: { type: 'jsonb', notNull: false },
  });

  // Idempotent seed: skip a name that already exists (ON CONFLICT on the unique
  // `name`). valid_neighbors is '[]' — these tiles are stamped, not WFC-placed.
  for (const t of MAP_TILE_TYPES) {
    pgm.sql(
      `INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors)
       VALUES ('${t.name}', '${t.color}', ${t.walkable}, ${t.speed}, '', '[]')
       ON CONFLICT (name) DO NOTHING`
    );
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM tile_types WHERE name IN ('map_wall', 'map_doorway')`);
  pgm.dropColumns('worlds', [
    'width', 'height', 'creature_count', 'allowed_creature_types', 'is_entry', 'entry_spawn',
  ]);
};

exports.MAP_TILE_TYPES = MAP_TILE_TYPES;
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cd backend && node --test tests/bounded_worlds_migration.test.js`
Expected: PASS (2 assertions in 1 test).

- [ ] **Step 5: Apply the migration and verify the schema**

Run:
```bash
cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate -- up
```
Expected: output lists `> Migrating files: > 1714440027000_bounded_worlds` and `Migrations complete!`.

Verify columns + tiles exist:
```bash
docker exec something2-backend-1 node -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});(async()=>{const c=await p.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='worlds' AND column_name IN ('width','height','creature_count','allowed_creature_types','is_entry','entry_spawn')\");const t=await p.query(\"SELECT name,walkable FROM tile_types WHERE name IN ('map_wall','map_doorway') ORDER BY name\");console.log('cols',c.rows.map(r=>r.column_name).sort());console.log('tiles',t.rows);await p.end()})()"
```
Expected: all 6 columns listed; tiles `[{name:'map_doorway',walkable:true},{name:'map_wall',walkable:false}]`.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/1714440027000_bounded_worlds.js backend/tests/bounded_worlds_migration.test.js
git commit -m "feat(server): bounded-world columns + map_wall/map_doorway tile types"
```

---

### Task 2: Pure `stampBounds` overlay

**Files:**
- Modify: `backend/src/services/mapService.js` (add functions + exports near `spawnChunkCreatures`, around line 349; extend `module.exports` at line 503)
- Test: `backend/tests/stampBounds.test.js`

**Interfaces:**
- Produces:
  - `DOORWAY_TILES` (number, = 3).
  - `stampBounds(grid, rMin, cMin, rows, cols, bounds) -> grid` where `bounds = { width, height, wallTile, doorwayTile, doorways }`, `doorways` is a `Set<'N'|'E'|'S'|'W'>`. Mutates and returns `grid`. `grid[r][c]` maps to absolute tile `(rMin + r, cMin + c)`.
- Consumes: nothing from other tasks (pure).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/stampBounds.test.js
const test = require('node:test');
const assert = require('node:assert');
const { stampBounds, DOORWAY_TILES } = require('../src/services/mapService');

// Build a rows x cols grid of a sentinel biome, absolute origin (rMin,cMin).
function fill(rMin, cMin, rows, cols, v = 'grass') {
  const g = [];
  for (let r = 0; r < rows; r++) g.push(new Array(cols).fill(v));
  return g;
}
const BOUNDS = (doorways) => ({
  width: 10, height: 10, wallTile: 'map_wall', doorwayTile: 'map_doorway',
  doorways: new Set(doorways),
});

test('DOORWAY_TILES is 3', () => assert.equal(DOORWAY_TILES, 3));

test('boundary ring becomes wall, interior untouched', () => {
  const g = fill(0, 0, 10, 10);
  stampBounds(g, 0, 0, 10, 10, BOUNDS([]));
  assert.equal(g[0][5], 'map_wall');   // north ring
  assert.equal(g[9][5], 'map_wall');   // south ring
  assert.equal(g[5][0], 'map_wall');   // west ring
  assert.equal(g[5][9], 'map_wall');   // east ring
  assert.equal(g[5][5], 'grass');      // interior unchanged
});

test('cells outside [0,width)x[0,height) become wall', () => {
  // Window starts one tile north/west of the origin.
  const g = fill(-1, -1, 3, 3);
  stampBounds(g, -1, -1, 3, 3, BOUNDS([]));
  assert.equal(g[0][0], 'map_wall');   // (-1,-1) outside
  assert.equal(g[0][1], 'map_wall');   // (-1,0) outside (north of row 0)
  assert.equal(g[1][1], 'map_wall');   // (0,0) corner ring
});

test('a doorway edge carves a centered 3-tile passable gap', () => {
  const g = fill(0, 0, 10, 10);
  stampBounds(g, 0, 0, 10, 10, BOUNDS(['N']));
  // width=10 -> mid col = 5, halfGap=1 -> cols 4,5,6 are doorway on row 0.
  assert.equal(g[0][4], 'map_doorway');
  assert.equal(g[0][5], 'map_doorway');
  assert.equal(g[0][6], 'map_doorway');
  assert.equal(g[0][3], 'map_wall');   // just outside the gap
  assert.equal(g[0][7], 'map_wall');
  assert.equal(g[9][5], 'map_wall');   // south edge has no doorway
});

test('a window fully interior is left unchanged', () => {
  const g = fill(3, 3, 4, 4);
  stampBounds(g, 3, 3, 4, 4, BOUNDS(['N', 'E', 'S', 'W']));
  for (const row of g) for (const v of row) assert.equal(v, 'grass');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/stampBounds.test.js`
Expected: FAIL — `stampBounds` is not exported (`undefined is not a function`).

- [ ] **Step 3: Implement `stampBounds`**

Add near line 349 (after `spawnChunkCreatures`) in `backend/src/services/mapService.js`:

```js
// --- Bounded-world boundary overlay ---------------------------------------
//
// A bounded world is a width x height tile rectangle. Its outer ring is a solid
// wall; each edge listed in `doorways` gets a centered DOORWAY_TILES-wide
// passable gap. Cells outside the rectangle are wall too, so a chunk fetched
// beyond the bound reads as solid. Pure overlay applied after biome+path fill.

const DOORWAY_TILES = 3; // width of a doorway gap, in tiles (centered on its edge)

function isDoorwayCell(gRow, gCol, width, height, doorways) {
  const half = Math.floor(DOORWAY_TILES / 2);
  const midCol = Math.floor(width / 2);
  const midRow = Math.floor(height / 2);
  if (doorways.has('N') && gRow === 0 && gCol >= midCol - half && gCol <= midCol + half) return true;
  if (doorways.has('S') && gRow === height - 1 && gCol >= midCol - half && gCol <= midCol + half) return true;
  if (doorways.has('W') && gCol === 0 && gRow >= midRow - half && gRow <= midRow + half) return true;
  if (doorways.has('E') && gCol === width - 1 && gRow >= midRow - half && gRow <= midRow + half) return true;
  return false;
}

function stampBounds(grid, rMin, cMin, rows, cols, bounds) {
  const { width, height, wallTile, doorwayTile, doorways } = bounds;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gRow = rMin + r, gCol = cMin + c;
      const outside = gRow < 0 || gRow >= height || gCol < 0 || gCol >= width;
      if (outside) { grid[r][c] = wallTile; continue; }
      const onRing = gRow === 0 || gRow === height - 1 || gCol === 0 || gCol === width - 1;
      if (onRing) {
        grid[r][c] = isDoorwayCell(gRow, gCol, width, height, doorways) ? doorwayTile : wallTile;
      }
    }
  }
  return grid;
}
```

Extend `module.exports` (line ~503) — add these entries to the existing object:

```js
    stampBounds,
    DOORWAY_TILES,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/stampBounds.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/stampBounds.test.js
git commit -m "feat(server): pure stampBounds wall/doorway overlay"
```

---

### Task 3: Apply bounds in `worldConfig` + `generateRegion`

**Files:**
- Modify: `backend/src/services/mapService.js` (`worldConfig` ~line 180; `generateRegion` line 212-227)
- Test: `backend/tests/generateRegion_bounds.test.js`

**Interfaces:**
- Consumes: `stampBounds`, `DOORWAY_TILES` (Task 2).
- Produces: `worldConfig(world)` now returns `cfg.bounds` = `{ width, height, wallTile, doorwayTile, doorways:Set }` when both `world.width` and `world.height` are set, else `null`. `generateRegion` applies `stampBounds` when `cfg.bounds` is present. World-object fields read: `world.width`, `world.height`, `world.wallTile` (default `'map_wall'`), `world.doorwayTile` (default `'map_doorway'`), `world.doorways` (array or Set of edges).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/generateRegion_bounds.test.js
const test = require('node:test');
const assert = require('node:assert');
const { generateRegion, worldConfig } = require('../src/services/mapService');

const BIOMES = { grass: {}, forest: {}, water: {}, meadow: {} };

test('worldConfig.bounds is null when unbounded, set when width+height given', () => {
  assert.equal(worldConfig({ seed: 1, tileTypes: BIOMES }).bounds, null);
  const b = worldConfig({ seed: 1, tileTypes: BIOMES, width: 10, height: 10 }).bounds;
  assert.equal(b.width, 10);
  assert.equal(b.wallTile, 'map_wall');
  assert.ok(b.doorways instanceof Set);
});

test('bounded generateRegion walls the boundary; unbounded is unchanged', () => {
  const unbounded = { seed: 5, chunkSize: 12, tileTypes: BIOMES };
  const plain = generateRegion(unbounded, 0, 0, 12, 12);
  assert.ok(!plain.flat().includes('map_wall'), 'unbounded region has no walls');

  const bounded = { seed: 5, chunkSize: 12, tileTypes: BIOMES, width: 12, height: 12 };
  const walled = generateRegion(bounded, 0, 0, 12, 12);
  assert.equal(walled[0][6], 'map_wall');   // north ring
  assert.equal(walled[6][0], 'map_wall');   // west ring
  assert.equal(walled[6][6], plain[6][6]);  // interior identical to unbounded
});

test('a doorway edge produces a passable gap in the ring', () => {
  const bounded = { seed: 5, chunkSize: 12, tileTypes: BIOMES,
    width: 12, height: 12, doorways: ['N'] };
  const g = generateRegion(bounded, 0, 0, 12, 12);
  assert.equal(g[0][6], 'map_doorway'); // mid of width 12 = col 6
  assert.equal(g[0][2], 'map_wall');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/generateRegion_bounds.test.js`
Expected: FAIL — `worldConfig(...).bounds` is `undefined`, first assertion `assert.equal(undefined, null)` fails (or interior/wall assertions fail).

- [ ] **Step 3: Implement**

In `worldConfig` (the returned object, currently ending with `biomeNames`), add a `bounds` field. Replace the `return { ... };` block so it ends:

```js
  return {
    seed: world.seed || 0,
    chunkSize: world.chunkSize || 64,
    cellSize: world.cellSize || 8,
    pathCell: world.pathCell || 24,
    pathJitter: world.pathJitter || 6,
    pathTile,
    names,
    biomeNames,
    bounds: (world.width && world.height) ? {
      width: world.width,
      height: world.height,
      wallTile: world.wallTile || 'map_wall',
      doorwayTile: world.doorwayTile || 'map_doorway',
      doorways: world.doorways instanceof Set ? world.doorways : new Set(world.doorways || []),
    } : null,
  };
```

In `generateRegion` (line 212-227), apply the overlay just before `return grid;`:

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
  if (cfg.bounds) stampBounds(grid, rMin, cMin, rows, cols, cfg.bounds);
  return grid;
}
```

- [ ] **Step 4: Run test to verify it passes, and confirm no regression**

Run: `cd backend && node --test tests/generateRegion_bounds.test.js tests/worldGen.test.js tests/worldPreview.test.js`
Expected: all PASS (bounded behavior added; unbounded generation unchanged, so the existing worldGen/worldPreview suites stay green).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/generateRegion_bounds.test.js
git commit -m "feat(server): apply bounded wall/doorway overlay in generateRegion"
```

---

### Task 4: Thread bounds into chunk generation + accept width/height on world create

**Files:**
- Modify: `backend/src/services/mapService.js` (add + export `doorwaysForWorld`)
- Modify: `backend/src/authority/server.js` (`loadWorld` SELECT ~line 87; `activateChunk` generateChunk call ~line 165)
- Modify: `backend/src/index.js` (`POST /api/worlds` ~line 842-855; chunk route generateChunk ~line 923; preview route generateChunk ~line 947)
- Test: `backend/tests/doorwaysForWorld.test.js`, and extend `backend/tests/worlds.test.js`

**Interfaces:**
- Consumes: `generateChunk` / `worldConfig` bounds (Task 3).
- Produces: `doorwaysForWorld(worldRow) -> Set<edge>` — returns all four edges for a bounded world (width&height set), empty Set otherwise. This is the single seam Slice 3 will change to link-driven doorways. Chunk-generation callers pass `{ ..., width: row.width, height: row.height, doorways: doorwaysForWorld(row) }`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/doorwaysForWorld.test.js
const test = require('node:test');
const assert = require('node:assert');
const { doorwaysForWorld } = require('../src/services/mapService');

test('unbounded world has no doorways', () => {
  assert.equal(doorwaysForWorld({ width: null, height: null }).size, 0);
});

test('bounded world defaults to a doorway on every edge (Slice 1)', () => {
  const d = doorwaysForWorld({ width: 20, height: 20 });
  assert.deepEqual([...d].sort(), ['E', 'N', 'S', 'W']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/doorwaysForWorld.test.js`
Expected: FAIL — `doorwaysForWorld` is not a function.

- [ ] **Step 3: Implement `doorwaysForWorld` + export**

Add near `stampBounds` in `backend/src/services/mapService.js`:

```js
// Which edges of a bounded world have a doorway. Slice 1: every edge, so a
// bounded world is traversable for testing. Slice 3 replaces the body with a
// lookup of map_links (only linked edges get a doorway). Callers pass the raw
// `worlds` DB row.
function doorwaysForWorld(worldRow) {
  if (!worldRow || !worldRow.width || !worldRow.height) return new Set();
  return new Set(['N', 'E', 'S', 'W']);
}
```

Add `doorwaysForWorld,` to `module.exports`.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cd backend && node --test tests/doorwaysForWorld.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Persist width/height on world create + thread into chunk generation**

In `backend/src/index.js`:

(a) `POST /api/worlds` (~line 842). Accept optional integer `width`/`height` and persist them. Replace the handler body's parse+insert:

```js
    const { name, seed, chunk_size, width, height } = req.body;
    // ... existing name/seed validation unchanged ...
    const chunkSize = Number.isFinite(chunk_size) ? Math.floor(chunk_size) : 64;
    if (chunkSize < 1 || chunkSize > 256) {
      return res.status(400).json({ error: 'chunk_size must be an integer between 1 and 256' });
    }
    // Optional rectangular bound (tiles). Both or neither. NULL => infinite.
    const w = Number.isFinite(width) ? Math.floor(width) : null;
    const h = Number.isFinite(height) ? Math.floor(height) : null;
    if ((w === null) !== (h === null)) {
      return res.status(400).json({ error: 'width and height must be provided together' });
    }
    if (w !== null && (w < 8 || w > 4096 || h < 8 || h > 4096)) {
      return res.status(400).json({ error: 'width and height must be between 8 and 4096 tiles' });
    }
    const result = await pool.query(
      'INSERT INTO worlds (name, seed, chunk_size, width, height) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, seedValue, chunkSize, w, h]
    );
```

> Note: keep whatever the existing code names the seed variable (it computes a seed from `seed`/random — reuse that variable in place of `seedValue` above; do not introduce a new name).

(b) Chunk route (~line 923) — pass bounds. Add `doorwaysForWorld` to the `require` at line 7, then:

```js
    const data = generateChunk(
      { seed: Number(world.seed), chunkSize: world.chunk_size, tileTypes,
        width: world.width, height: world.height, doorways: doorwaysForWorld(world) },
      cx, cy
    );
```

(c) Preview route (~line 947) — same three added fields on the world object passed to `generateChunk`.

In `backend/src/authority/server.js`:

(d) `loadWorld` SELECT (~line 87) — add width/height so the row carries them:

```js
        const wr = await pool.query('SELECT id, seed, chunk_size, width, height FROM worlds WHERE id = $1', [worldId]);
```

(e) `activateChunk` generateChunk call (~line 165) — thread bounds from `entry.row`. Require `doorwaysForWorld` at the top of the file alongside the existing `mapService` import, then:

```js
          { seed: Number(entry.row.seed), chunkSize: N, tileTypes: entry.tileTypes,
            width: entry.row.width, height: entry.row.height,
            doorways: doorwaysForWorld(entry.row) },
```

- [ ] **Step 6: Write an integration test for world create + bounded chunk**

Append to `backend/tests/worlds.test.js` (uses the existing mock-pool harness in that file — mirror its existing `POST /api/worlds` test for the request/response shape; if the file has no such test, use the `__setPool` mock pattern from `tile_types_api.test.js`):

```js
test('POST /api/worlds persists width/height together or 400s on one', async () => {
  const pool = mockPool([
    [/INSERT INTO worlds/i, (p) => ({ rows: [{ id: 'w1', name: p[0], width: p[3], height: p[4] }] })],
  ]);
  __setPool(pool);
  const ok = await request(app).post('/api/worlds').set(...AUTH)
    .send({ name: 'arena', seed: 1, width: 40, height: 30 });
  assert.equal(ok.status, 201);
  const call = pool.calls.find((c) => /INSERT INTO worlds/i.test(c.sql));
  assert.equal(Number(call.params[3]), 40);
  assert.equal(Number(call.params[4]), 30);

  const bad = await request(app).post('/api/worlds').set(...AUTH)
    .send({ name: 'x', seed: 1, width: 40 }); // height missing
  assert.equal(bad.status, 400);
});
```

> Adapt `mockPool`, `__setPool`, `AUTH`, and `app` imports to match the top of `worlds.test.js` (copy them from `tile_types_api.test.js` if that file doesn't already import them). `AUTH` is the admin bearer header those tests already use.

- [ ] **Step 7: Run tests**

Run: `cd backend && node --test tests/doorwaysForWorld.test.js tests/worlds.test.js`
Expected: PASS.

- [ ] **Step 8: Restart the backend so the running server loads the new code**

The backend container runs a plain `node src/index.js` PID (not nodemon). Restart it:
```bash
PID=$(docker exec something2-backend-1 sh -c 'pgrep -f "node src/index.js"' | head -1)
docker exec something2-backend-1 sh -c "kill $PID"
docker exec -d something2-backend-1 sh -c 'cd /app && nohup node src/index.js >/tmp/backend.log 2>&1 &'
```
Then wait for `curl -s -o /dev/null -w "%{http_code}" http://localhost:13101/api/tile-types` to return `200`.

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/mapService.js backend/src/authority/server.js backend/src/index.js backend/tests/doorwaysForWorld.test.js backend/tests/worlds.test.js
git commit -m "feat(server): thread bounds into chunk generation + accept width/height on world create"
```

---

### Task 5: Client — verify wall collision & rendering, browser pass

**Files:**
- Test: `frontend/src/games/something2/src/js/core/__tests__/boundsCollision.test.js`
- (No client source change expected — tile config for `map_wall`/`map_doorway` flows from the DB via the existing tile-config endpoint; verify and only patch if a gap is found.)

**Interfaces:**
- Consumes: the chunk grid now contains `'map_wall'`/`'map_doorway'` tile names (Task 4). The client's `ChunkedMap` mirrors server collision: `isWalkable` reads the tile-type `walkable` flag from the injected tile config.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/games/something2/src/js/core/__tests__/boundsCollision.test.js
import { describe, it, expect } from 'vitest';
import { ChunkedMap } from '../ChunkedMap.js';

// Tile config as delivered by the tile-config endpoint (name -> def).
const TILES = {
  grass: { color: '#0f0', walkable: true, speed: 1 },
  map_wall: { color: '#2b2b2b', walkable: false, speed: 1 },
  map_doorway: { color: '#6b4f2a', walkable: true, speed: 1 },
};

describe('bounded-world wall collision (client)', () => {
  it('treats map_wall as non-walkable and map_doorway/grass as walkable', () => {
    const cm = new ChunkedMap({ chunkSize: 4, tileTypes: TILES });
    // A 4x4 chunk (0,0): row 0 all wall except a doorway at col 2; interior grass.
    const grid = [
      ['map_wall', 'map_wall', 'map_doorway', 'map_wall'],
      ['map_wall', 'grass', 'grass', 'map_wall'],
      ['map_wall', 'grass', 'grass', 'map_wall'],
      ['map_wall', 'map_wall', 'map_wall', 'map_wall'],
    ];
    cm.setChunk(0, 0, grid);
    const TILE = 100; // MAP_TILE_SIZE world px per tile
    const at = (col, row) => ({ x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 });
    expect(cm.isWalkable(at(0, 0).x, at(0, 0).y)).toBe(false); // wall
    expect(cm.isWalkable(at(2, 0).x, at(2, 0).y)).toBe(true);  // doorway gap
    expect(cm.isWalkable(at(1, 1).x, at(1, 1).y)).toBe(true);  // interior grass
  });
});
```

> Before running, confirm the exact `ChunkedMap` constructor and chunk-insertion API in `frontend/src/games/something2/src/js/core/ChunkedMap.js` (it may be `new ChunkedMap({ chunkSize, tileTypes })` and `setChunk(cx, cy, grid)` / `ingestChunk` / `addChunk`, and `isWalkable(worldX, worldY)`). Adapt the constructor call, the chunk-insert method name, and world-px scale to the real signatures — do not invent methods. The assertion intent (wall=false, doorway/grass=true) is fixed.

- [ ] **Step 2: Run test to verify it fails (or reveals the real API)**

Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/boundsCollision.test.js`
Expected: FAIL initially — either method-name mismatch (fix the test to the real API per the note) or, if the API matches, it should pass immediately because collision is generic. If it passes on first correct wiring, that is the intended outcome (no client code change needed); keep the test as the regression guard.

- [ ] **Step 3: Make it pass**

If the test failed only due to method/constructor names, correct them to the real `ChunkedMap` API and re-run. If it failed because `ChunkedMap` does not consult the tile-type `walkable` flag for streamed chunks, add that lookup in `ChunkedMap.isWalkable` mirroring the server (`def ? def.walkable !== false : true`). No other client change is expected.

- [ ] **Step 4: Run the full frontend suite (no regression)**

Run: `cd frontend && npx vitest run`
Expected: all tests pass, including the new one.

- [ ] **Step 5: Browser verification (bounded world is walled + walkable)**

Create a small bounded world and confirm it renders walls and blocks movement:
```bash
# Mint an admin token the same way as prior sessions (sign via the app), then:
TOK=... # admin bearer
curl -s -X POST http://localhost:13101/api/worlds -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{"name":"BoundedArena","seed":42,"chunk_size":16,"width":24,"height":24}'
```
In the browser (admin → Game View → select "BoundedArena" → Enter World chunked): confirm a **dark wall ring** frames the map, a **doorway-colored gap** sits mid-edge on all four sides, the player **cannot walk through walls**, and **can** step onto the doorway tiles. (Vite dev server + backend must be up per the restart notes.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/src/js/core/__tests__/boundsCollision.test.js frontend/src/games/something2/src/js/core/ChunkedMap.js
git commit -m "test(client): bounded-world wall collision + rendering guard"
```

---

## Self-Review

**Spec coverage (Slice 1 scope):**
- worlds columns (width/height + creature/entry) → Task 1 ✓
- map_wall / map_doorway tile types → Task 1 ✓
- boundary-wall + doorway stamping (pure fn) → Task 2 ✓
- applied in generation, unbounded unchanged → Task 3 ✓
- in-bounds materialization (out-of-bounds cells = wall) → Task 2/3 (`outside` branch) ✓
- tile-based collision for walls → free via `isWalkable`; guarded server-side by existing suites and client-side by Task 5 ✓
- client rendering of walls/doorways → free via DB tile config; verified in Task 5 browser pass ✓
- Deliverable "walled bounded world you can walk around" → Task 5 browser pass ✓
- Deferred to later slices (correctly out of scope here): link-driven doorways + teleport (Slice 3), creature count/allowed-types replacing the 0.01 roll (Slice 2), Maps admin UI (Slice 2). `doorwaysForWorld` and the unused new columns are the seams that keep those slices to one-place changes.

**Placeholder scan:** No TBD/TODO; every code step has complete code. Two steps intentionally say "adapt to the real signature" (the seed-variable name in `POST /api/worlds`, and the `ChunkedMap` method names) — these are explicit instructions to match existing code the implementer can read, not missing content.

**Type consistency:** `stampBounds(grid, rMin, cMin, rows, cols, bounds)` and `bounds = { width, height, wallTile, doorwayTile, doorways:Set }` are identical in Tasks 2, 3. `doorwaysForWorld(row) -> Set` used identically in Task 4 callers. Tile names `map_wall`/`map_doorway` consistent across Tasks 1–5. `DOORWAY_TILES = 3` defined once (Task 2), asserted (Tasks 1-comment, 2). Column names match the migration (Task 1) everywhere they are read (Task 4).
