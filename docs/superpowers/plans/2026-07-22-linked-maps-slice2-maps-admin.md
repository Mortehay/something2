# Linked Maps Slice 2 — Maps Admin Tab + Creature Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins full management of bounded maps — generate/rename/regenerate, count-based creature control (count + allowed types, re-roll), and set-as-entry — via a new admin **Maps** tab, and deprecate the dead discrete-map "World Browser".

**Architecture:** Extends the live chunked `worlds` system (Slice 1 added bounds columns + wall/doorway tiles + `stampBounds`). Bounded maps stop using the per-chunk `CREATURE_SPAWN_CHANCE` roll; instead a pure `placeMapCreatures()` rejection-samples `creature_count` creatures onto in-bounds, walkable, non-wall, non-doorway tiles and the admin routes write them to `world_creatures`. New backend routes (`PUT /api/worlds/:id`, `POST /api/worlds/:id/regenerate`, `POST /api/worlds/:id/creatures`) mutate config and invalidate caches; a small authority `evictWorld()` hook lets a regenerate/re-roll reload an idle world. A new `MapsAdmin.jsx` panel (mirroring `TileTypesAdmin.jsx`) drives it.

**Tech Stack:** Node/Express + `pg` (backend, `node:test` + `supertest`), React + `@tanstack/react-query` + `styled-components` + `react-hot-toast` (frontend, `vitest`), Postgres.

## Global Constraints

- Build on the **live chunked `worlds`** system. The discrete `maps`/`/api/maps` system and its "World Browser" UI are **deprecated (removed from UI), not deleted** (tables/routes stay).
- `width`/`height`: integers, **both-or-neither**, each in **[8, 4096]** tiles. NULL/NULL = infinite. (Matches `POST /api/worlds`.)
- Bounded maps use **count-based placement** (`creature_count` + `allowed_creature_types`), NOT the `CREATURE_SPAWN_CHANCE = 0.01` per-chunk roll. The infinite Overworld keeps its per-chunk roll **unchanged**.
- Creature placement is **in-bounds, walkable, non-`map_wall`, non-`map_doorway`**, and a **pure function, deterministic per seed**.
- At most **one** world has `is_entry = true` (clear the previous on set).
- Tile types already seeded (Slice 1): `map_wall` (walkable=false), `map_doorway` (walkable=true).
- Admin mutating routes go behind `adminGuard`. Response conventions: validation → `400 {error}`; missing → `404 {error}`; catch → `console.error(err)` + `500 {error}`; success → `res.json(row)` (or `201`).
- **Regenerate terrain** must invalidate BOTH the persisted `world_chunks` rows AND the in-memory `worldPreviewCache`, and must not corrupt a world with live players.
- Frontend data access is raw `fetch` inside per-domain hook files; auth via `authHeaders()` from `./src/js/net/EngineClient.js`; base `const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";`.
- Backend tests: `node --test`. Frontend tests: `npm test` (`vitest run`). Frontend build check: `npm run build`.
- Entry-map JOIN behavior and `map_links`/teleport are **Slice 3** — out of scope here. Slice 2 only persists/sets `is_entry`/`entry_spawn`.

---

## File Structure

- `backend/src/services/mapService.js` — add pure `placeMapCreatures()` and pure predicate `isBoundedWorld()`; export both. (Terrain + placement logic lives here.)
- `backend/src/authority/server.js` — `activateChunk` skips the per-chunk roll for bounded worlds (fixes Slice 1 wall-spawn bug); add `evictWorld(worldId)` to the returned handle.
- `backend/src/index.js` — module-scope authority handle + `evictAuthorityWorld()` helper; new routes `PUT /api/worlds/:id`, `POST /api/worlds/:id/regenerate`, `POST /api/worlds/:id/creatures`.
- `backend/tests/placeMapCreatures.test.js`, `backend/tests/isBoundedWorld.test.js`, `backend/tests/worldsAdminRoutes.test.js` — new tests.
- `frontend/src/games/something2/useMapsAdmin.js` — new hooks: `useUpdateWorld`, `useRegenerateWorld`, `useRerollCreatures` (reuses `useWorlds`/`useCreateWorld`/`useDeleteWorld`/`useEntityTypes`).
- `frontend/src/games/something2/MapsAdmin.jsx` — new admin panel.
- `frontend/src/games/something2/Something2.jsx` — register Maps tab (Task 7); remove World Browser (Task 8).

---

### Task 1: `placeMapCreatures()` pure creature-placement function

**Files:**
- Modify: `backend/src/services/mapService.js` (add function + export; `module.exports` at ~556-582)
- Test: `backend/tests/placeMapCreatures.test.js` (create)

**Interfaces:**
- Consumes: existing `worldConfig(world)`, `generateRegion(world, rMin, cMin, rows, cols)`, `makeRng(seed)` (all in this file). `world` config object shape: `{ seed, chunkSize, tileTypes, width, height, doorways }` where `tileTypes` maps name → `{ walkable, speed }`.
- Produces: `placeMapCreatures(world, count, allowedTypes, rngSeed, maxAttempts = 40) -> Array<{type, x, y, hp, facing, defense, resistances}>`. `allowedTypes` is `Array<{name, hp, defense, resistances}>`. Rows are shaped identically to `spawnChunkCreatures` output (pixel center = `col*100+50`, `row*100+50`).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/placeMapCreatures.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { placeMapCreatures } = require('../src/services/mapService');

// Minimal walkable tile world: one biome 'grass' (walkable) + the seeded
// bound tiles. worldConfig detects no path tile with a single biome name.
const TILE_TYPES = {
  grass: { walkable: true, speed: 1 },
  water: { walkable: false, speed: 1 },
  map_wall: { walkable: false, speed: 1 },
  map_doorway: { walkable: true, speed: 1 },
};
const boundedWorld = (over = {}) => ({
  seed: 42, chunkSize: 64, tileTypes: TILE_TYPES,
  width: 24, height: 24, doorways: new Set(['N', 'E', 'S', 'W']),
  ...over,
});

const CREATURES = [
  { name: 'goblin', hp: 12, defense: 1, resistances: {} },
  { name: 'wolf', hp: 8, defense: 0, resistances: { fire: 0.5 } },
];

test('places exactly `count` creatures when interior is walkable', () => {
  const rows = placeMapCreatures(boundedWorld(), 10, CREATURES, 123);
  assert.equal(rows.length, 10);
});

test('every creature lands strictly inside the wall ring (never on the ring or outside)', () => {
  const rows = placeMapCreatures(boundedWorld(), 25, CREATURES, 7);
  for (const c of rows) {
    const col = Math.floor(c.x / 100);
    const row = Math.floor(c.y / 100);
    assert.ok(row >= 1 && row <= 22, `row ${row} inside 1..22`);
    assert.ok(col >= 1 && col <= 22, `col ${col} inside 1..22`);
  }
});

test('every creature stands on a walkable, non-wall, non-doorway tile', () => {
  const { generateRegion } = require('../src/services/mapService');
  const world = boundedWorld();
  const rows = placeMapCreatures(world, 25, CREATURES, 99);
  for (const c of rows) {
    const col = Math.floor(c.x / 100);
    const row = Math.floor(c.y / 100);
    const name = generateRegion(world, row, col, 1, 1)[0][0];
    assert.notEqual(name, 'map_wall');
    assert.notEqual(name, 'map_doorway');
    assert.notEqual(TILE_TYPES[name].walkable, false);
  }
});

test('creature types are drawn only from allowedTypes', () => {
  const rows = placeMapCreatures(boundedWorld(), 15, CREATURES, 5);
  const allowed = new Set(['goblin', 'wolf']);
  for (const c of rows) assert.ok(allowed.has(c.type));
});

test('deterministic: same seed => identical placement', () => {
  const a = placeMapCreatures(boundedWorld(), 12, CREATURES, 555);
  const b = placeMapCreatures(boundedWorld(), 12, CREATURES, 555);
  assert.deepEqual(a, b);
});

test('different seed => different placement (very likely)', () => {
  const a = placeMapCreatures(boundedWorld(), 12, CREATURES, 1);
  const b = placeMapCreatures(boundedWorld(), 12, CREATURES, 2);
  assert.notDeepEqual(a, b);
});

test('returns [] for an unbounded world', () => {
  const rows = placeMapCreatures({ seed: 1, chunkSize: 64, tileTypes: TILE_TYPES }, 10, CREATURES, 1);
  assert.deepEqual(rows, []);
});

test('returns [] when count < 1 or allowedTypes empty', () => {
  assert.deepEqual(placeMapCreatures(boundedWorld(), 0, CREATURES, 1), []);
  assert.deepEqual(placeMapCreatures(boundedWorld(), 5, [], 1), []);
});

test('row shape matches spawnChunkCreatures (pixel center, carried stats)', () => {
  const rows = placeMapCreatures(boundedWorld(), 1, [CREATURES[0]], 3);
  const c = rows[0];
  assert.equal((c.x - 50) % 100, 0);
  assert.equal((c.y - 50) % 100, 0);
  assert.equal(c.facing, 'S');
  assert.equal(c.type, 'goblin');
  assert.equal(c.hp, 12);
  assert.equal(c.defense, 1);
  assert.deepEqual(c.resistances, {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/placeMapCreatures.test.js`
Expected: FAIL — `placeMapCreatures is not a function`.

- [ ] **Step 3: Implement `placeMapCreatures`**

In `backend/src/services/mapService.js`, add near the other bound helpers (after `spawnChunkCreatures`, before `doorwaysForWorld`). It reuses the module-local `CREATURE_TILE_PX` (=100), `worldConfig`, `generateRegion`, `makeRng`:

```js
// Count-based creature placement for a BOUNDED map. Rejection-samples `count`
// interior tiles (strictly inside the wall ring), keeping only walkable,
// non-wall, non-doorway tiles, and assigns a random allowed type. Pure and
// deterministic given `rngSeed`. Returns rows shaped like spawnChunkCreatures.
// Unbounded worlds return [] (they keep the per-chunk roll).
function placeMapCreatures(world, count, allowedTypes, rngSeed, maxAttempts = 40) {
  const cfg = worldConfig(world);
  if (!cfg.bounds) return [];
  if (!count || count < 1) return [];
  if (!allowedTypes || allowedTypes.length === 0) return [];
  const { width, height, wallTile, doorwayTile } = cfg.bounds;
  const rLo = 1, rHi = height - 2, cLo = 1, cHi = width - 2;
  if (rHi < rLo || cHi < cLo) return [];
  const rng = makeRng(rngSeed >>> 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < maxAttempts; a++) {
      const row = rLo + Math.floor(rng() * (rHi - rLo + 1));
      const col = cLo + Math.floor(rng() * (cHi - cLo + 1));
      const name = generateRegion(world, row, col, 1, 1)[0][0];
      if (name === wallTile || name === doorwayTile) continue;
      const def = world.tileTypes && world.tileTypes[name];
      if (def && def.walkable === false) continue;
      const t = allowedTypes[Math.floor(rng() * allowedTypes.length)];
      out.push({
        type: t.name,
        x: col * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        y: row * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        hp: t.hp || 10,
        facing: 'S',
        defense: Number(t.defense ?? 0) || 0,
        resistances: t.resistances || {},
      });
      break;
    }
  }
  return out;
}
```

Add `placeMapCreatures,` to `module.exports` (alongside `spawnChunkCreatures`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/placeMapCreatures.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/placeMapCreatures.test.js
git commit -m "feat(mapgen): pure placeMapCreatures count-based placement (in-bounds/walkable/non-wall)"
```

---

### Task 2: Bounded worlds skip the per-chunk creature roll (fixes Slice 1 wall-spawn bug)

**Files:**
- Modify: `backend/src/services/mapService.js` (add pure `isBoundedWorld` + export)
- Modify: `backend/src/authority/server.js` (`activateChunk`, ~154-201; import at line 9)
- Test: `backend/tests/isBoundedWorld.test.js` (create)

**Interfaces:**
- Produces: `isBoundedWorld(row) -> boolean` = `!!(row && row.width && row.height)`.
- Consumed by `activateChunk` to gate the `spawnChunkCreatures` call.

**Why:** Slice 1 left bounded maps spawning creatures on wall/out-of-bounds tiles because `activateChunk` still runs the per-tile roll with a config lacking bounds. Slice 2 makes bounded maps count-based (Tasks 1 + 5), so the per-chunk roll must be **skipped** for them. Their creatures come from `world_creatures` (written by the re-roll route) and are loaded by the existing x/y box query, which is untouched.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/isBoundedWorld.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { isBoundedWorld } = require('../src/services/mapService');

test('true only when both width and height are set', () => {
  assert.equal(isBoundedWorld({ width: 24, height: 24 }), true);
  assert.equal(isBoundedWorld({ width: 24, height: null }), false);
  assert.equal(isBoundedWorld({ width: null, height: 24 }), false);
  assert.equal(isBoundedWorld({}), false);
  assert.equal(isBoundedWorld(null), false);
  assert.equal(isBoundedWorld(undefined), false);
});

test('zero is treated as unbounded (falsy)', () => {
  assert.equal(isBoundedWorld({ width: 0, height: 0 }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/isBoundedWorld.test.js`
Expected: FAIL — `isBoundedWorld is not a function`.

- [ ] **Step 3: Implement `isBoundedWorld` + gate the authority spawn**

In `backend/src/services/mapService.js`, add near `doorwaysForWorld`:

```js
// A world is "bounded" (a Slice-2 map) when it has a finite width AND height.
// Bounded worlds use count-based placement (placeMapCreatures); unbounded
// worlds keep the per-chunk spawn roll.
function isBoundedWorld(row) {
  return !!(row && row.width && row.height);
}
```

Add `isBoundedWorld,` to `module.exports`.

In `backend/src/authority/server.js`, update the require at line 9 to include it:

```js
const { spawnChunkCreatures, doorwaysForWorld, isBoundedWorld } = require('../services/mapService');
```

In `activateChunk` (~161-176), wrap the per-chunk spawn so bounded worlds skip it. Change:

```js
    if (ins.rowCount > 0 && entry.creatureTypes.length) {
      const spawned = spawnChunkCreatures(
        { seed: Number(entry.row.seed), chunkSize: N, tileTypes: entry.tileTypes },
        cx, cy, entry.creatureTypes,
      );
      for (const c of spawned) {
```

to:

```js
    // Bounded maps use count-based placement (placeMapCreatures, written to
    // world_creatures by the admin re-roll route); they must NOT run the
    // per-tile roll here, which would scatter creatures onto the wall ring.
    if (ins.rowCount > 0 && entry.creatureTypes.length && !isBoundedWorld(entry.row)) {
      const spawned = spawnChunkCreatures(
        { seed: Number(entry.row.seed), chunkSize: N, tileTypes: entry.tileTypes },
        cx, cy, entry.creatureTypes,
      );
      for (const c of spawned) {
```

(The subsequent `world_creatures` box-load query is unchanged, so bounded maps still load whatever `placeMapCreatures` wrote.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/isBoundedWorld.test.js`
Expected: PASS (2 tests).

Then the full authority suite to confirm no regression:
Run: `cd backend && node --test tests/authority_creatures.test.js tests/authority_creatures_integration.test.js`
Expected: PASS (unchanged — these test `CreatureSim`, not the gate).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/src/authority/server.js backend/tests/isBoundedWorld.test.js
git commit -m "fix(authority): bounded worlds skip per-chunk creature roll (no wall spawns)"
```

---

### Task 3: Authority `evictWorld(worldId)` handle + index.js wiring

**Files:**
- Modify: `backend/src/authority/server.js` (returned handle, ~675-689)
- Modify: `backend/src/index.js` (module-scope handle + helper; call site ~968-976)

**Interfaces:**
- Produces (server.js): `attachAuthority(...)` return object gains `evictWorld(worldId) -> boolean`. Evicts a world from the in-memory `worlds` Map **only if it is present and has no connected sockets**; returns `true` if evicted, `false` if absent or in-use.
- Produces (index.js): module-scope `let authorityHandle = null;` and `function evictAuthorityWorld(worldId)` calling `authorityHandle?.evictWorld?.(worldId)` (no-op → `false` when the authority isn't attached, e.g. in route tests). Consumed by Tasks 4–5.

**Why:** Regenerate/re-roll change DB rows the authority may hold stale copies of (seed → `ServerMap`, cached `world_creatures`). The authority already `worlds.delete()` a world when it empties (server.js:532) and reloads fresh from DB on next entry, so eviction only needs to cover an **idle-but-still-cached** world; it deliberately refuses to evict a world with live players to avoid corrupting sessions.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/worldsAdminRoutes.test.js` will come in Task 4. For this task, add a focused unit test of the handle. Create `backend/tests/authority_evictWorld.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { attachAuthority } = require('../src/authority/server');

// A pool stub that answers only what attachAuthority's timers might touch.
// attachAuthority does no queries until a socket connects, so a throwing
// stub is fine for evictWorld (which never queries).
const noopPool = { query: async () => ({ rows: [], rowCount: 0 }) };

function withAuthority(fn) {
  const server = http.createServer();
  const handle = attachAuthority(server, noopPool, { jwtSecret: 'test' });
  try { return fn(handle); } finally { handle.close(); }
}

test('evictWorld returns false for a world that was never loaded', () => {
  withAuthority((h) => {
    assert.equal(h.evictWorld('missing-id'), false);
  });
});

test('evictWorld exposes a function on the handle', () => {
  withAuthority((h) => {
    assert.equal(typeof h.evictWorld, 'function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/authority_evictWorld.test.js`
Expected: FAIL — `h.evictWorld is not a function`.

- [ ] **Step 3: Implement the handle method + index wiring**

In `backend/src/authority/server.js`, add `evictWorld` to the returned object (the object literal that begins with `_heartbeatSweep: heartbeatSweep,` ~675):

```js
    _heartbeatSweep: heartbeatSweep,
    // Evict an IDLE world from the in-memory cache so the next entry reloads it
    // from the DB (fresh seed + creatures). Refuses to evict a world with live
    // sockets to avoid tearing down active sessions.
    evictWorld(worldId) {
      const entry = worlds.get(worldId);
      if (!entry) return false;
      if (entry.sockets && entry.sockets.size > 0) return false;
      worlds.delete(worldId);
      return true;
    },
    close() {
```

In `backend/src/index.js`, add a module-scope handle just above the worlds routes (near the `worldPreviewCache` declaration ~34-36):

```js
// Handle to the running authority (set only when this module is the entrypoint;
// null under tests). Lets admin mutations evict an idle cached world so its next
// load re-reads regenerated terrain/creatures from the DB.
let authorityHandle = null;
function evictAuthorityWorld(worldId) {
  return authorityHandle?.evictWorld?.(worldId) ?? false;
}
```

Update the `require.main` call site (~970-974) to capture the handle:

```js
if (require.main === module) {
  const server = app.listen(port, () => {
    console.log(`Backend server running on port ${port}`);
  });
  authorityHandle = attachAuthority(server, pool, { jwtSecret: process.env.JWT_SECRET });
  console.log('Authority WS attached at /authority');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/authority_evictWorld.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/server.js backend/src/index.js backend/tests/authority_evictWorld.test.js
git commit -m "feat(authority): evictWorld handle + index wiring for idle-world reload"
```

---

### Task 4: `PUT /api/worlds/:id` — rename + bounds + creature config + entry singleton

**Files:**
- Modify: `backend/src/index.js` (add route after `GET /api/worlds/:id`, ~903)
- Test: `backend/tests/worldsAdminRoutes.test.js` (create)

**Interfaces:**
- Consumes: `pool`, `adminGuard`, `evictAuthorityWorld`, `worldPreviewCache` (all in index.js).
- Produces: `PUT /api/worlds/:id` accepting `{ name, width, height, creature_count, allowed_creature_types, is_entry, entry_spawn }`. Persists all; enforces single `is_entry`; on a bounds change also deletes `world_chunks` + clears preview cache + evicts the world. Returns the updated row.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/worldsAdminRoutes.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) {
        if (re.test(sql)) return fn(params);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('PUT /api/worlds/:id requires a non-empty name', async () => {
  __setPool(mockPool([]));
  const res = await request(app).put('/api/worlds/w1').set(...AUTH).send({ name: '   ' });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id rejects width without height', async () => {
  __setPool(mockPool([]));
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'A', width: 24, height: null });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id rejects out-of-range bounds', async () => {
  __setPool(mockPool([]));
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'A', width: 4, height: 4 });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id updates and returns the row', async () => {
  const pool = mockPool([
    // current row (to detect bounds change)
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Renamed', width: 24, height: 24, creature_count: 5, allowed_creature_types: ['goblin'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Renamed');
});

test('PUT /api/worlds/:id 404 when the row is absent', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).put('/api/worlds/nope').set(...AUTH).send({ name: 'X' });
  assert.equal(res.status, 404);
});

test('PUT /api/worlds/:id with is_entry clears the previous entry first', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/UPDATE worlds SET is_entry = false/i, () => ({ rows: [], rowCount: 1 })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0], is_entry: true }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Entry', is_entry: true, entry_spawn: { x: 1200, y: 1200 } });
  assert.equal(res.status, 200);
  const clearedFirst = pool.calls.some(c => /UPDATE worlds SET is_entry = false/i.test(c.sql));
  assert.ok(clearedFirst, 'previous entry cleared');
});

test('PUT /api/worlds/:id deletes chunks + clears cache when bounds change', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/DELETE FROM world_chunks WHERE world_id/i, () => ({ rows: [], rowCount: 3 })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Bigger', width: 32, height: 32 });
  assert.equal(res.status, 200);
  const deleted = pool.calls.some(c => /DELETE FROM world_chunks WHERE world_id/i.test(c.sql));
  assert.ok(deleted, 'chunks invalidated on bounds change');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/worldsAdminRoutes.test.js`
Expected: FAIL — PUT route returns 404/unexpected (route not defined).

- [ ] **Step 3: Implement `PUT /api/worlds/:id`**

In `backend/src/index.js`, add immediately after the `GET /api/worlds/:id` handler (~903):

```js
app.put('/api/worlds/:id', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, width, height, creature_count, allowed_creature_types, is_entry, entry_spawn } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const w = Number.isFinite(width) ? Math.floor(width) : null;
    const h = Number.isFinite(height) ? Math.floor(height) : null;
    if ((w === null) !== (h === null)) {
      return res.status(400).json({ error: 'width and height must be provided together' });
    }
    if (w !== null && (w < 8 || w > 4096 || h < 8 || h > 4096)) {
      return res.status(400).json({ error: 'width and height must be between 8 and 4096 tiles' });
    }
    const count = Number.isFinite(creature_count) ? Math.max(0, Math.floor(creature_count)) : 0;
    const allowed = Array.isArray(allowed_creature_types)
      ? allowed_creature_types.filter((t) => typeof t === 'string')
      : [];
    const entry = is_entry === true;
    const spawn = entry_spawn && typeof entry_spawn === 'object' ? entry_spawn : null;

    const cur = await pool.query('SELECT id, width, height FROM worlds WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'world not found' });
    const before = cur.rows[0];
    const boundsChanged = (before.width ?? null) !== w || (before.height ?? null) !== h;

    // Enforce a single entry world.
    if (entry) {
      await pool.query('UPDATE worlds SET is_entry = false WHERE is_entry = true AND id <> $1', [id]);
    }
    // A bounds change reshapes the wall ring: invalidate persisted + preview terrain.
    if (boundsChanged) {
      await pool.query('DELETE FROM world_chunks WHERE world_id = $1', [id]);
      worldPreviewCache.delete(id);
    }

    const result = await pool.query(
      `UPDATE worlds SET name = $1, width = $2, height = $3, creature_count = $4,
         allowed_creature_types = $5::jsonb, is_entry = $6, entry_spawn = $7::jsonb,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 RETURNING *`,
      [name.trim(), w, h, count, JSON.stringify(allowed), entry, spawn ? JSON.stringify(spawn) : null, id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'world not found' });
    if (boundsChanged) evictAuthorityWorld(id);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update world' });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/worldsAdminRoutes.test.js`
Expected: PASS (7 tests so far).

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/worldsAdminRoutes.test.js
git commit -m "feat(api): PUT /api/worlds/:id rename + bounds + creature config + entry singleton"
```

---

### Task 5: `POST /api/worlds/:id/regenerate` + `POST /api/worlds/:id/creatures` (re-roll)

**Files:**
- Modify: `backend/src/index.js` (two routes after PUT; the mapService require at line 7)
- Test: `backend/tests/worldsAdminRoutes.test.js` (append)

**Interfaces:**
- Consumes: `pool`, `adminGuard`, `evictAuthorityWorld`, `worldPreviewCache`, and from mapService `placeMapCreatures`, `isBoundedWorld`, `doorwaysForWorld`, `getTileTypesMap` (existing helper used by the chunk route).
- Produces:
  - `POST /api/worlds/:id/regenerate` → assigns a new random seed, deletes this world's `world_chunks` + `world_creatures`, clears preview cache, evicts the world. Returns the updated row.
  - `POST /api/worlds/:id/creatures` → (bounded only) deletes this world's `world_creatures`, runs `placeMapCreatures` from the world's `creature_count` + `allowed_creature_types`, bulk-inserts, evicts the world. Returns `{ placed }`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/worldsAdminRoutes.test.js`:

```js
const TILE_ROWS = [
  { id: 1, name: 'grass', color: '#0a0', walkable: true, speed: 1, image: null, valid_neighbors: [] },
  { id: 2, name: 'map_wall', color: '#2b2b2b', walkable: false, speed: 1, image: null, valid_neighbors: [] },
  { id: 3, name: 'map_doorway', color: '#6b4f2a', walkable: true, speed: 1, image: null, valid_neighbors: [] },
];

test('POST /api/worlds/:id/regenerate reseeds and clears chunks+creatures', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', seed: '42' }] })],
    [/DELETE FROM world_chunks WHERE world_id/i, () => ({ rows: [], rowCount: 2 })],
    [/DELETE FROM world_creatures WHERE world_id/i, () => ({ rows: [], rowCount: 5 })],
    [/UPDATE worlds SET seed/i, (p) => ({ rows: [{ id: 'w1', seed: String(p[0]) }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/regenerate').set(...AUTH).send({});
  assert.equal(res.status, 200);
  const deletedChunks = pool.calls.some(c => /DELETE FROM world_chunks/i.test(c.sql));
  const deletedCreatures = pool.calls.some(c => /DELETE FROM world_creatures/i.test(c.sql));
  assert.ok(deletedChunks && deletedCreatures);
});

test('POST /api/worlds/:id/regenerate 404 when absent', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).post('/api/worlds/nope/regenerate').set(...AUTH).send({});
  assert.equal(res.status, 404);
});

test('POST /api/worlds/:id/creatures rejects an unbounded world', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: null, height: null }] })],
  ]));
  const res = await request(app).post('/api/worlds/w1/creatures').set(...AUTH).send({});
  assert.equal(res.status, 400);
});

test('POST /api/worlds/:id/creatures places creatures and reports the count', async () => {
  const world = { id: 'w1', seed: '42', chunk_size: 64, width: 24, height: 24,
    creature_count: 8, allowed_creature_types: ['goblin'] };
  const inserted = [];
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [world] })],
    [/SELECT .*FROM tile_types/i, () => ({ rows: TILE_ROWS })],
    [/SELECT .*FROM entity_types WHERE is_creature/i, () => ({
      rows: [{ id: 1, name: 'goblin', hp: 12, defense: 1, resistances: {} }] })],
    [/DELETE FROM world_creatures WHERE world_id/i, () => ({ rows: [], rowCount: 3 })],
    [/INSERT INTO world_creatures/i, (p) => { inserted.push(p); return { rows: [], rowCount: 1 }; }],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/creatures').set(...AUTH).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.placed, 8);
  assert.equal(inserted.length, 8);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/worldsAdminRoutes.test.js`
Expected: FAIL — the four new tests fail (routes not defined).

- [ ] **Step 3: Implement both routes**

First extend the mapService require at `backend/src/index.js:7` to add the two functions:

```js
const { generateWorld, placeEntities, detectPathTile, uniqueTileNames, generateChunk, generateWorldPreview, doorwaysForWorld, placeMapCreatures, isBoundedWorld } = require('./services/mapService');
```

Add both routes after the `PUT /api/worlds/:id` handler:

```js
app.post('/api/worlds/:id/regenerate', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const cur = await pool.query('SELECT id FROM worlds WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'world not found' });
    const newSeed = Math.floor(Math.random() * 2 ** 31);
    await pool.query('DELETE FROM world_chunks WHERE world_id = $1', [id]);
    await pool.query('DELETE FROM world_creatures WHERE world_id = $1', [id]);
    worldPreviewCache.delete(id);
    const result = await pool.query(
      'UPDATE worlds SET seed = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [newSeed, id],
    );
    evictAuthorityWorld(id);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to regenerate world' });
  }
});

app.post('/api/worlds/:id/creatures', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const wr = await pool.query('SELECT * FROM worlds WHERE id = $1', [id]);
    if (wr.rows.length === 0) return res.status(404).json({ error: 'world not found' });
    const world = wr.rows[0];
    if (!isBoundedWorld(world)) {
      return res.status(400).json({ error: 'creature control is only available for bounded maps' });
    }
    const allowed = Array.isArray(world.allowed_creature_types) ? world.allowed_creature_types : [];
    const count = Number(world.creature_count) || 0;

    await pool.query('DELETE FROM world_creatures WHERE world_id = $1', [id]);

    let placed = 0;
    if (count > 0 && allowed.length > 0) {
      const et = await pool.query(
        `SELECT name, hp, defense, resistances FROM entity_types
         WHERE is_creature = true AND name = ANY($1::text[])`,
        [allowed],
      );
      if (et.rows.length > 0) {
        const tileTypes = await getTileTypesMap();
        const rows = placeMapCreatures(
          { seed: Number(world.seed), chunkSize: world.chunk_size, tileTypes,
            width: world.width, height: world.height, doorways: doorwaysForWorld(world) },
          count, et.rows, Math.floor(Math.random() * 2 ** 31),
        );
        for (const c of rows) {
          await pool.query(
            `INSERT INTO world_creatures (world_id, type, x, y, hp, facing) VALUES ($1,$2,$3,$4,$5,$6)`,
            [id, c.type, c.x, c.y, c.hp, c.facing],
          );
        }
        placed = rows.length;
      }
    }
    evictAuthorityWorld(id);
    res.json({ placed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to re-roll creatures' });
  }
});
```

Note: `getTileTypesMap()` is the existing helper the chunk route uses (returns name → `{ walkable, speed, ... }`), so `placeMapCreatures`'s walkability check works against real tile data.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/worldsAdminRoutes.test.js`
Expected: PASS (11 tests).

Then the full backend suite:
Run: `cd backend && node --test`
Expected: PASS (all prior tests + the new files).

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/worldsAdminRoutes.test.js
git commit -m "feat(api): world regenerate + creature re-roll routes (count-based placement)"
```

---

### Task 6: Frontend admin hooks (`useMapsAdmin.js`)

**Files:**
- Create: `frontend/src/games/something2/useMapsAdmin.js`

**Interfaces:**
- Consumes: `authHeaders` from `./src/js/net/EngineClient.js`; `@tanstack/react-query`.
- Produces: `useUpdateWorld()`, `useRegenerateWorld()`, `useRerollCreatures()` — each a mutation invalidating `["worlds"]` + toasting. (List/create/delete already exist in `useWorlds.js`; creature-type list in `useEntityTypes` from `useMaps.js`.)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/useMapsAdmin.test.js`:

```js
import { describe, it, expect } from 'vitest';
import * as hooks from '../useMapsAdmin.js';

describe('useMapsAdmin exports', () => {
  it('exposes update/regenerate/reroll hooks', () => {
    expect(typeof hooks.useUpdateWorld).toBe('function');
    expect(typeof hooks.useRegenerateWorld).toBe('function');
    expect(typeof hooks.useRerollCreatures).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/useMapsAdmin.test.js`
Expected: FAIL — cannot resolve `../useMapsAdmin.js`.

- [ ] **Step 3: Implement the hooks**

Create `frontend/src/games/something2/useMapsAdmin.js`:

```js
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authHeaders } from "./src/js/net/EngineClient.js";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:13101";

export function useUpdateWorld() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) => {
      const res = await fetch(`${API_URL}/api/worlds/${id}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to update map");
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success("Map saved"); },
    onError: (err) => toast.error(err.message),
  });
}

export function useRegenerateWorld() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await fetch(`${API_URL}/api/worlds/${id}/regenerate`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to regenerate");
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success("Terrain regenerated"); },
    onError: (err) => toast.error(err.message),
  });
}

export function useRerollCreatures() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const res = await fetch(`${API_URL}/api/worlds/${id}/creatures`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to re-roll creatures");
      return res.json();
    },
    onSuccess: (data) => { qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success(`Placed ${data.placed} creatures`); },
    onError: (err) => toast.error(err.message),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/useMapsAdmin.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/useMapsAdmin.js frontend/src/games/something2/__tests__/useMapsAdmin.test.js
git commit -m "feat(client): useMapsAdmin hooks (update/regenerate/reroll)"
```

---

### Task 7: `MapsAdmin.jsx` panel + register the Maps tab

**Files:**
- Create: `frontend/src/games/something2/MapsAdmin.jsx`
- Modify: `frontend/src/games/something2/Something2.jsx` (import ~14-16; `ADMIN_TAB_COLORS` line 150; TabButton block after line 714; render line after 911; import `HiOutlineMap` on line 4)

**Interfaces:**
- Consumes: `useWorlds`, `useCreateWorld`, `useDeleteWorld` (`useWorlds.js`); `useEntityTypes` (`useMaps.js`); `useUpdateWorld`, `useRegenerateWorld`, `useRerollCreatures` (`useMapsAdmin.js`).
- Produces: default-exported `<MapsAdmin />` panel. Lists bounded maps (name/size/creature count/entry flag); Generate (name + width + height + optional seed); per-map edit (rename, creature count +/-, allowed-type checkboxes, set-as-entry + spawn X/Y), Regenerate terrain, Re-roll creatures, Delete.

**Note on scope:** entry_spawn is captured as two numeric inputs (X/Y pixels), defaulting to map center `(width*100/2, height*100/2)`. A map-click spawn picker is out of scope. Play-test "Enter" is left to the existing Game-View "Worlds" panel (unchanged) — do NOT wire a new enter here.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/MapsAdmin.smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';
import MapsAdmin from '../MapsAdmin.jsx';

describe('MapsAdmin', () => {
  it('is a component export', () => {
    expect(typeof MapsAdmin).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/MapsAdmin.smoke.test.js`
Expected: FAIL — cannot resolve `../MapsAdmin.jsx`.

- [ ] **Step 3: Implement `MapsAdmin.jsx`**

Create `frontend/src/games/something2/MapsAdmin.jsx`, mirroring the `TileTypesAdmin.jsx` container/pattern:

```jsx
import { useState } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { HiOutlinePlus, HiOutlineTrash, HiOutlineArrowPath, HiOutlineSparkles, HiOutlineStar } from 'react-icons/hi2';
import { useWorlds, useCreateWorld, useDeleteWorld } from './useWorlds.js';
import { useEntityTypes } from './useMaps.js';
import { useUpdateWorld, useRegenerateWorld, useRerollCreatures } from './useMapsAdmin.js';

const AdminContainer = styled.div`
  padding: 2rem; color: #eee; max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: #1a1a2e;
`;
const Header = styled.div`display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;`;
const Button = styled.button`
  background: ${p => p.$bg || '#4a9eff'}; color: white; border: none; border-radius: 6px;
  padding: 0.5rem 1rem; font-weight: bold; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Card = styled.div`
  background: #23233f; border: 1px solid ${p => p.$entry ? '#facc15' : '#333'};
  border-radius: 8px; padding: 1rem; margin-bottom: 1rem;
`;
const Row = styled.div`display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;`;
const Input = styled.input`background: #12121f; color: #eee; border: 1px solid #333; border-radius: 4px; padding: 0.4rem;`;
const CheckGrid = styled.div`display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 0.4rem 0;`;

function bounded(w) { return !!(w.width && w.height); }

function MapCard({ world, creatureTypes }) {
  const update = useUpdateWorld();
  const regen = useRegenerateWorld();
  const reroll = useRerollCreatures();
  const del = useDeleteWorld();
  const [name, setName] = useState(world.name);
  const [count, setCount] = useState(world.creature_count ?? 0);
  const [allowed, setAllowed] = useState(new Set(world.allowed_creature_types || []));
  const [isEntry, setIsEntry] = useState(!!world.is_entry);
  const cx = world.width ? Math.floor((world.width * 100) / 2) : 0;
  const cy = world.height ? Math.floor((world.height * 100) / 2) : 0;
  const [spawnX, setSpawnX] = useState(world.entry_spawn?.x ?? cx);
  const [spawnY, setSpawnY] = useState(world.entry_spawn?.y ?? cy);

  const toggle = (n) => setAllowed(prev => {
    const next = new Set(prev); next.has(n) ? next.delete(n) : next.add(n); return next;
  });
  const save = () => update.mutate({
    id: world.id, name, width: world.width, height: world.height,
    creature_count: Number(count), allowed_creature_types: [...allowed],
    is_entry: isEntry, entry_spawn: isEntry ? { x: Number(spawnX), y: Number(spawnY) } : null,
  });

  return (
    <Card $entry={world.is_entry}>
      <Row>
        <Input value={name} onChange={e => setName(e.target.value)} />
        <span style={{ color: '#888' }}>{world.width}×{world.height} tiles</span>
        {world.is_entry && <HiOutlineStar style={{ color: '#facc15' }} title="Player entry" />}
        <HiOutlineTrash style={{ color: '#ef4444', cursor: 'pointer', marginLeft: 'auto' }}
          onClick={() => window.confirm('Delete this map?') && del.mutate(world.id)} />
      </Row>
      <Row>
        <label style={{ color: '#aaa' }}>Creatures:</label>
        <Button $bg="#555" onClick={() => setCount(c => Math.max(0, Number(c) - 1))}>−</Button>
        <Input type="number" min="0" value={count} style={{ width: 70 }}
          onChange={e => setCount(e.target.value)} />
        <Button $bg="#555" onClick={() => setCount(c => Number(c) + 1)}>＋</Button>
      </Row>
      <CheckGrid>
        {creatureTypes.map(t => (
          <label key={t.id} style={{ color: '#ccc' }}>
            <input type="checkbox" checked={allowed.has(t.name)} onChange={() => toggle(t.name)} /> {t.name}
          </label>
        ))}
      </CheckGrid>
      <Row>
        <label style={{ color: '#aaa' }}>
          <input type="checkbox" checked={isEntry} onChange={e => setIsEntry(e.target.checked)} /> Player entry
        </label>
        {isEntry && (<>
          <span style={{ color: '#888' }}>spawn X</span>
          <Input type="number" value={spawnX} style={{ width: 90 }} onChange={e => setSpawnX(e.target.value)} />
          <span style={{ color: '#888' }}>Y</span>
          <Input type="number" value={spawnY} style={{ width: 90 }} onChange={e => setSpawnY(e.target.value)} />
        </>)}
      </Row>
      <Row>
        <Button onClick={save} disabled={update.isPending}>Save</Button>
        <Button $bg="#8b5cf6" onClick={() => regen.mutate(world.id)} disabled={regen.isPending}>
          <HiOutlineArrowPath /> Regenerate terrain
        </Button>
        <Button $bg="#10b981" onClick={() => reroll.mutate(world.id)} disabled={reroll.isPending}>
          <HiOutlineSparkles /> Re-roll creatures
        </Button>
      </Row>
    </Card>
  );
}

function MapsAdmin() {
  const { worlds, isLoadingWorlds } = useWorlds();
  const { entityTypes } = useEntityTypes();
  const createWorld = useCreateWorld();
  const [name, setName] = useState('');
  const [width, setWidth] = useState(24);
  const [height, setHeight] = useState(24);

  const creatureTypes = (entityTypes || []).filter(t => t.is_creature);
  const boundedMaps = (worlds || []).filter(bounded);

  const generate = () => {
    if (!name.trim()) return toast.error('Name is required');
    createWorld.mutate({ name: name.trim(), width: Number(width), height: Number(height) },
      { onSuccess: () => setName('') });
  };

  if (isLoadingWorlds) return <AdminContainer>Loading maps…</AdminContainer>;

  return (
    <AdminContainer>
      <Header><h2>Maps</h2></Header>
      <Card>
        <Row>
          <Input placeholder="New map name" value={name} onChange={e => setName(e.target.value)} />
          <span style={{ color: '#888' }}>W</span>
          <Input type="number" min="8" max="4096" value={width} style={{ width: 80 }} onChange={e => setWidth(e.target.value)} />
          <span style={{ color: '#888' }}>H</span>
          <Input type="number" min="8" max="4096" value={height} style={{ width: 80 }} onChange={e => setHeight(e.target.value)} />
          <Button onClick={generate} disabled={createWorld.isPending}><HiOutlinePlus /> Generate map</Button>
        </Row>
      </Card>
      {boundedMaps.length === 0 && <p style={{ color: '#888' }}>No bounded maps yet. Generate one above.</p>}
      {boundedMaps.map(w => <MapCard key={w.id} world={w} creatureTypes={creatureTypes} />)}
    </AdminContainer>
  );
}

export default MapsAdmin;
```

Note: `useCreateWorld` currently sends only `{ name, seed, chunk_size }`. The generate call passes `width`/`height`; they are ignored by the current mutation body. Fix `useCreateWorld` in `useWorlds.js` to forward them — change its `mutationFn` body to accept and send the whole object:

```js
    mutationFn: async (body) => {
      const res = await fetch(`${API_URL}/api/worlds`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to create world");
      return res.json();
    },
```

(Confirm the existing chunked "Worlds" panel still calls `useCreateWorld().mutate({ name, seed, chunk_size })` — passing a whole object is backward compatible.)

- [ ] **Step 4: Register the Maps tab in `Something2.jsx`**

1. Line 4 (react-icons import): add `HiOutlineMap` to the existing `react-icons/hi2` import.
2. Near lines 14-16, add: `import MapsAdmin from "./MapsAdmin";`
3. Line 150: `const ADMIN_TAB_COLORS = { entity: '#facc15', items: '#f472b6', maps: '#34d399' };`
4. In the `{isAdmin && (<> … </>)}` tab block (after the Items TabButton, ~line 714), add:
   ```jsx
   <TabButton $active={activeTab === 'maps'} $adminType="maps" onClick={() => setActiveTab('maps')}>
     <HiOutlineMap /> Maps
   </TabButton>
   ```
5. In the panel render region (after line 911), add:
   ```jsx
   {isAdmin && activeTab === 'maps' && <MapsAdmin />}
   ```

- [ ] **Step 5: Verify build + tests**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/MapsAdmin.smoke.test.js`
Expected: PASS.

Run: `cd frontend && npm run build`
Expected: build succeeds (no unresolved imports / syntax errors).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/MapsAdmin.jsx frontend/src/games/something2/__tests__/MapsAdmin.smoke.test.js frontend/src/games/something2/Something2.jsx frontend/src/games/something2/useWorlds.js
git commit -m "feat(client): Maps admin tab (generate/rename/regenerate/creature control/entry)"
```

---

### Task 8: Deprecate the World Browser (discrete-map UI)

**Files:**
- Modify: `frontend/src/games/something2/Something2.jsx`

**Goal:** Remove the discrete-map "World Browser" panel + "World Controls" panel and their now-unused handlers/state/imports. **Do NOT** touch: `EngineClient.js` (it exports `authHeaders`/`getStoredToken` used across hooks), the chunked "Worlds" panel, `handleEnterChunkedWorld`, or `WorldAuthorityClient`. Leave the `maps`/`map_entities` tables and `/api/maps/*` routes in place (deprecated, not deleted).

**Removal targets (verify each with grep before deleting — remove only if no OTHER reference remains):**
- JSX: the `World Browser` `<Panel>` (~817-851), the `World Controls` `<Panel>` (~853-872), and the discrete `<MapPreview mapId=… />` block (~892-894).
- Handlers: `handleEnterWorld` (~478-544), `handlePlay` (~546), `handleGenerateEntities` (~621-648), `handleSaveEntities` (~608-617).
- State/mutations: `selectedMapId` (333), `generateMapMutation`, `deleteMapMutation`, `saveEntitiesMutation`, `generateEntitiesMutation`, and the `useMaps()` list at 351 (`maps`, `isLoadingMaps`) — only if nothing else consumes them.
- Imports: `MapPreview` (line 17); the discrete-map hooks on line 8 (`useMaps, useGenerateMap, useDeleteMap, fetchMap, fetchMapEntities, useSaveEntities, useGenerateEntities`) — keep any symbol still used elsewhere (e.g. `useMapTiles`, `useEntityTypes` if imported from the same line).

- [ ] **Step 1: Baseline — capture current green state**

Run: `cd frontend && npm test`
Expected: record the passing count (baseline). Also `npm run build` succeeds.

- [ ] **Step 2: Grep every removal target for stray references**

For each symbol above, run e.g.:
Run: `cd frontend && grep -rn "handleEnterWorld\|selectedMapId\|generateEntitiesMutation\|saveEntitiesMutation\|MapPreview\|fetchMapEntities" src/games/something2/Something2.jsx`
Confirm each lives only in the World-Browser region (and its own definition). Note any symbol shared with kept code (e.g. `engineRef` is used by Sign-out — **keep** it and any chunked usage).

- [ ] **Step 3: Remove the World Browser UI + dead handlers/state/imports**

Delete the three JSX blocks and the four handlers and the discrete-only state/mutations/imports identified in Step 2. Keep everything the chunked path and Sign-out use. Do not remove `EngineClient.js` or its exports.

- [ ] **Step 4: Verify build + tests + no orphan references**

Run: `cd frontend && npm run build`
Expected: succeeds with no "is not defined" / unresolved-import errors (this catches any dangling reference to a removed symbol).

Run: `cd frontend && npm test`
Expected: passing count ≥ baseline from Step 1 (no test regressions).

Run: `cd frontend && grep -rn "World Browser\|handleEnterWorld\|selectedMapId" src/games/something2/Something2.jsx`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/Something2.jsx
git commit -m "refactor(client): remove deprecated World Browser (discrete-map UI)"
```

---

### Task 9: Browser verification pass (controller-run)

**Files:** none (manual verification against the running dev stack).

This task is run by the controller, not a fresh implementer. Restart backend + frontend to load the new code (per project dev traps: backend via `docker exec`, frontend Vite via `docker exec -d … npm run dev`), mint an admin token if needed, then verify end-to-end:

- [ ] **Step 1:** Open the app as admin → the new **Maps** tab is present; the old **World Browser** panel is gone from the Game View.
- [ ] **Step 2:** In Maps, **Generate map** "Slice2Arena" 24×24 → it appears as a bounded map card (24×24).
- [ ] **Step 3:** Set creature count = 8, check one allowed creature type, **Save**, then **Re-roll creatures** → toast "Placed N creatures"; confirm `SELECT count(*) FROM world_creatures WHERE world_id = …` = the re-rolled count, and every creature is at an interior, walkable tile (query x/y → tile is not `map_wall`/`map_doorway`; none on the ring). This confirms the Slice-1 wall-spawn bug is fixed.
- [ ] **Step 4:** Enter the map via the Game-View "Worlds" panel → creatures are visible **inside** the walls only (never embedded in the wall ring); player is still blocked at the boundary (Slice 1 regression check).
- [ ] **Step 5:** **Regenerate terrain** → the world's `world_chunks` rows are cleared (`SELECT count(*) FROM world_chunks WHERE world_id = …` = 0 until re-entered); re-enter → terrain differs (new seed) and walls/doorways still present.
- [ ] **Step 6:** Set the map as **Player entry** with a spawn, Save → `SELECT id FROM worlds WHERE is_entry = true` returns exactly this one row (singleton enforced); set a second map as entry → the first flips to false.
- [ ] **Step 7:** Record results in the SDD ledger (`.superpowers/sdd/progress.md`), noting any deferred minors.

---

## Self-Review

**1. Spec coverage** (§ from `2026-07-22-linked-maps-portals-design.md`):
- §1 data model (creature_count/allowed_creature_types/is_entry/entry_spawn) → columns exist (Slice 1); written by Task 4. `map_links` is Slice 3, not here. ✓
- §4 creatures count + allowed types, re-roll, regenerate terrain (separate actions), pure `placeMapCreatures` → Tasks 1, 5. ✓
- §5 Maps tab (list/generate/rename/regenerate/creatures/set-entry) + routes `PUT /api/worlds/:id`, `POST …/regenerate`, `POST …/creatures` + client hooks → Tasks 4, 5, 6, 7. ✓ (Link editor + play-test-here are Slice 3 / existing Worlds panel.)
- §6 player entry: Slice 2 persists `is_entry`/`entry_spawn`; the JOIN hook is Slice 3 (explicitly deferred). ✓
- §8 deprecate World Browser → Task 8. ✓
- §10 regenerate invalidates `world_chunks` + preview cache + idle-world reload → Tasks 3, 4, 5. ✓
- Slice-1 deferred "creatures on wall tiles" → fixed by Task 2. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". Every code step has full code. ✓

**3. Type consistency:** `placeMapCreatures(world, count, allowedTypes, rngSeed, maxAttempts)` and `isBoundedWorld(row)` used identically in Tasks 1/2/5. Row shape `{type,x,y,hp,facing,defense,resistances}` consistent with `spawnChunkCreatures` and the `INSERT INTO world_creatures (world_id, type, x, y, hp, facing)` columns. Route response shapes (`res.json(row)`, `{ placed }`) match the Task 6 hooks' expectations. `useCreateWorld` body widened to forward width/height (Task 7). ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-22-linked-maps-slice2-maps-admin.md`. Nine tasks; Tasks 1–5 backend (TDD with `node --test`), 6–7 client, 8 deprecation, 9 browser pass.
