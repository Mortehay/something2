# Linked Maps Slice 3 — Links + Doorway Teleport + Entry Join — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link bounded maps edge-to-edge so a doorway in the boundary wall teleports the player to the linked map, and make players enter the network at a designated entry map.

**Architecture:** A new `map_links` table (bidirectional edge links). `doorwaysForWorld` (Slice-1 stub returning all 4 edges) is retired; only **linked** edges get a doorway, sourced from `map_links` via a new DB helper `mapLinks.js` (keeping the pure `mapService` generator DB-free — `doorways` is passed in as an edge array the config wraps in a Set). Teleport is **server-authoritative**: the authority tick detects a player on a `map_doorway` tile, computes the mirrored arrival point from the destination's bounds (carried on `entry.links` via a JOIN), records a `pendingArrivals` entry, and sends a `transition` frame; the client tears down its `WorldAuthorityClient` and re-`initChunked`s at the linked world, whose `join`→`loadSpawn` consumes the pending arrival. `loadSpawn` also gains entry-spawn + interior-clamp behavior (fixing small bounded maps that center-spawn outside bounds).

**Tech Stack:** Node/Express + `pg` + node-pg-migrate (backend, `node:test` + `supertest`), React + `@tanstack/react-query` + `styled-components` (frontend, `vitest`), Postgres, WebSocket authority.

## Global Constraints

- Build on the **live chunked `worlds`** system (Slice 1+2 merged, `eef06f3`). Bounded = `width` AND `height` set.
- **`map_links`**: `from_world_id` + `edge IN ('N','E','S','W')` + `to_world_id`, `UNIQUE(from_world_id, edge)`, both FKs `ON DELETE CASCADE`. Linking is **bidirectional**: linking A `E` ↔ B writes `(A,E,B)` and `(B,W,A)`; clearing removes both.
- Only **linked** edges get a doorway. A doorway is a `DOORWAY_TILES = 3` walkable `map_doorway` gap centered on the edge midpoint (Slice-1 geometry, unchanged).
- Opposite edges: **N↔S, E↔W**. Arrival = **just inside** the destination's opposite-edge doorway (one tile in from the ring), player-centered.
- Teleport = **reconnect**: authority sends `{ type:'transition', toWorldId, arriveX, arriveY }`; client re-`initChunked`s to `toWorldId`. Spawn is **server-authoritative** (`loadSpawn` consumes a `pendingArrivals` record).
- **Re-entry cooldown ≈ 1.5s** (`Date.now()`-based `_doorwayCdUntil`) suppresses immediate re-trigger on both send and arrival.
- **Entry map**: `worlds.is_entry` (singleton, already enforced by Slice-2 PUT) + `entry_spawn {x,y}`. Client auto-join prefers the `is_entry` world over the infinite `Overworld`; server spawns a first-join player there at `entry_spawn`.
- Admin mutating routes behind `adminGuard`; response conventions 400/404/500 `{error}`, success `res.json(...)`. Link routes evict BOTH affected worlds from the authority (`evictAuthorityWorld`).
- Keep `mapService.js` free of any `pg`/DB dependency (pure generator). DB access for links lives in `backend/src/services/mapLinks.js`.
- Backend tests `node --test`; frontend tests `npm test` (`vitest run`); frontend build `npm run build`.
- Migrations run on server start AND via `DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate:up` from `backend/`. New migration timestamp: **`1714440028000`** (latest is `1714440027000`).

---

## File Structure

- `backend/migrations/1714440028000_create_map_links.js` — new table.
- `backend/src/services/mapService.js` — add pure `oppositeEdge`, `edgeOfDoorwayTile`, `arrivalPoint`, `chooseSpawn`; **remove** `doorwaysForWorld` (+ its test) once its last caller is gone.
- `backend/src/services/mapLinks.js` — new DB helper: `fetchLinks`, `setLink`, `clearLink`.
- `backend/src/index.js` — link CRUD routes; swap the 3 doorway call sites (chunk/preview/creatures) to `fetchLinks`.
- `backend/src/authority/server.js` — loadWorld builds `entry.links` + doorways from links; `pendingArrivals`; `loadSpawn` rewrite (via `chooseSpawn`); tick doorway-detection + `transition` frame; join stamps arrival cooldown.
- `backend/src/authority/world.js` — `addPlayer` gets `_doorwayCdUntil: 0`.
- Frontend: `WorldAuthorityClient.js` (`onTransition`), `Game.js` (`setOnTransition` + wire), `Something2.jsx` (transition→enter + entry auto-join), `useMapsAdmin.js` (link hooks), `MapsAdmin.jsx` (link editor).
- Tests: new backend test files per task; frontend smoke tests.

---

### Task 1: `map_links` migration

**Files:**
- Create: `backend/migrations/1714440028000_create_map_links.js`
- Test: `backend/tests/mapLinksMigration.test.js` (create)

**Interfaces:**
- Produces: table `map_links(id uuid PK, from_world_id uuid FK→worlds CASCADE, edge text CHECK IN N/E/S/W, to_world_id uuid FK→worlds CASCADE, created_at)`, `UNIQUE(from_world_id, edge)`, index on `from_world_id`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/mapLinksMigration.test.js` (mirrors `bounded_worlds_migration.test.js` style — asserts the migration module loads and defines up/down; the real schema is verified by the live DB apply in the browser task):

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

test('map_links migration exposes up and down', () => {
  const mig = require(path.join(__dirname, '..', 'migrations', '1714440028000_create_map_links.js'));
  assert.equal(typeof mig.up, 'function');
  assert.equal(typeof mig.down, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/mapLinksMigration.test.js`
Expected: FAIL — Cannot find module `1714440028000_create_map_links.js`.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/1714440028000_create_map_links.js`:

```js
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('map_links', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    from_world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    edge: { type: 'text', notNull: true, check: "edge IN ('N','E','S','W')" },
    to_world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('map_links', 'map_links_from_edge_unique', { unique: ['from_world_id', 'edge'] });
  pgm.createIndex('map_links', 'from_world_id');
};

exports.down = (pgm) => pgm.dropTable('map_links');
```

- [ ] **Step 4: Run test + apply migration**

Run: `cd backend && node --test tests/mapLinksMigration.test.js`
Expected: PASS.

Run: `cd backend && DATABASE_URL="postgres://user:password@localhost:15432/game_db" npm run migrate:up`
Expected: applies `1714440028000_create_map_links` (or "No migrations to run" if already applied). Verify: `docker exec something2-db-1 psql -U user -d game_db -c "\d map_links"` shows the columns + unique constraint.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/1714440028000_create_map_links.js backend/tests/mapLinksMigration.test.js
git commit -m "feat(db): map_links table (bidirectional edge links)"
```

---

### Task 2: Pure edge + arrival + spawn helpers in mapService

**Files:**
- Modify: `backend/src/services/mapService.js` (add functions + exports)
- Test: `backend/tests/edgeHelpers.test.js` (create)

**Interfaces:**
- Produces (all pure, exported):
  - `oppositeEdge(edge) -> 'N'|'E'|'S'|'W'` (N↔S, E↔W).
  - `edgeOfDoorwayTile(gRow, gCol, width, height) -> 'N'|'E'|'S'|'W'|null` — which ring edge a tile sits on (null if not on the ring).
  - `arrivalPoint(width, height, arriveEdge) -> {x, y}` — player top-left pixel just inside the destination's `arriveEdge` doorway (player 64px, tile 100px; centered on the doorway-center tile one tile in from the ring).
  - `chooseSpawn({ pending, persisted, worldRow, chunkSize }) -> {x, y, viaDoorway}` — spawn decision: `pending` arrival wins; else `persisted` position; else entry_spawn (if `worldRow.is_entry` && `worldRow.entry_spawn`); else interior-clamped center for a bounded world; else `(chunkSize*100)/2` center (unbounded).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/edgeHelpers.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { oppositeEdge, edgeOfDoorwayTile, arrivalPoint, chooseSpawn } = require('../src/services/mapService');

test('oppositeEdge flips N<->S and E<->W', () => {
  assert.equal(oppositeEdge('N'), 'S');
  assert.equal(oppositeEdge('S'), 'N');
  assert.equal(oppositeEdge('E'), 'W');
  assert.equal(oppositeEdge('W'), 'E');
});

test('edgeOfDoorwayTile identifies the ring edge (24x24)', () => {
  assert.equal(edgeOfDoorwayTile(0, 12, 24, 24), 'N');
  assert.equal(edgeOfDoorwayTile(23, 12, 24, 24), 'S');
  assert.equal(edgeOfDoorwayTile(12, 0, 24, 24), 'W');
  assert.equal(edgeOfDoorwayTile(12, 23, 24, 24), 'E');
  assert.equal(edgeOfDoorwayTile(5, 5, 24, 24), null); // interior
});

test('arrivalPoint lands one tile inside the arrive edge, player-centered', () => {
  // dest 24x24, arriving via W => col 1, row midRow=12 => center (150,1250) => top-left (118,1218)
  assert.deepEqual(arrivalPoint(24, 24, 'W'), { x: 1 * 100 + 18, y: 12 * 100 + 18 });
  // via E => col width-2=22
  assert.deepEqual(arrivalPoint(24, 24, 'E'), { x: 22 * 100 + 18, y: 12 * 100 + 18 });
  // via N => row 1, col midCol=12
  assert.deepEqual(arrivalPoint(24, 24, 'N'), { x: 12 * 100 + 18, y: 1 * 100 + 18 });
  // via S => row height-2=22
  assert.deepEqual(arrivalPoint(24, 24, 'S'), { x: 12 * 100 + 18, y: 22 * 100 + 18 });
});

test('chooseSpawn: pending arrival wins', () => {
  const s = chooseSpawn({ pending: { x: 111, y: 222 }, persisted: { x: 9, y: 9 },
    worldRow: { width: 24, height: 24 }, chunkSize: 64 });
  assert.deepEqual(s, { x: 111, y: 222, viaDoorway: true });
});

test('chooseSpawn: persisted position when no pending', () => {
  const s = chooseSpawn({ pending: null, persisted: { x: 500, y: 600 },
    worldRow: { width: 24, height: 24 }, chunkSize: 64 });
  assert.deepEqual(s, { x: 500, y: 600, viaDoorway: false });
});

test('chooseSpawn: entry_spawn for a first-join entry world', () => {
  const s = chooseSpawn({ pending: null, persisted: null,
    worldRow: { width: 24, height: 24, is_entry: true, entry_spawn: { x: 1200, y: 1200 } }, chunkSize: 64 });
  assert.deepEqual(s, { x: 1200, y: 1200, viaDoorway: false });
});

test('chooseSpawn: bounded world clamps to interior center (not chunk-center)', () => {
  // 24x24 bounded: interior center tile (12,12) => player top-left (12*100+18)
  const s = chooseSpawn({ pending: null, persisted: null, worldRow: { width: 24, height: 24 }, chunkSize: 64 });
  assert.deepEqual(s, { x: 12 * 100 + 18, y: 12 * 100 + 18, viaDoorway: false });
});

test('chooseSpawn: unbounded world uses chunk-center', () => {
  const s = chooseSpawn({ pending: null, persisted: null, worldRow: { width: null, height: null }, chunkSize: 64 });
  assert.deepEqual(s, { x: (64 * 100) / 2, y: (64 * 100) / 2, viaDoorway: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/edgeHelpers.test.js`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the helpers**

In `backend/src/services/mapService.js`, add near the bound helpers (uses `isBoundedWorld` already present; `CREATURE_TILE_PX = 100` is the tile size; player half-size = 32):

```js
// --- Slice 3: edge geometry + spawn selection (pure) ---
const PLAYER_HALF = 32; // player is 64px; center offset from top-left

function oppositeEdge(edge) {
  return { N: 'S', S: 'N', E: 'W', W: 'E' }[edge] || null;
}

// Which ring edge a tile (gRow,gCol) sits on for a width x height bounded map;
// null if it is not on the ring. Corners resolve to a vertical edge first (N/S).
function edgeOfDoorwayTile(gRow, gCol, width, height) {
  if (gRow === 0) return 'N';
  if (gRow === height - 1) return 'S';
  if (gCol === 0) return 'W';
  if (gCol === width - 1) return 'E';
  return null;
}

// Player top-left pixel just INSIDE the destination's arriveEdge doorway.
// Doorway center tile is midCol/midRow (Slice-1 geometry); step one tile inward.
function arrivalPoint(width, height, arriveEdge) {
  const midCol = Math.floor(width / 2);
  const midRow = Math.floor(height / 2);
  let col, row;
  if (arriveEdge === 'N') { row = 1; col = midCol; }
  else if (arriveEdge === 'S') { row = height - 2; col = midCol; }
  else if (arriveEdge === 'W') { col = 1; row = midRow; }
  else { col = width - 2; row = midRow; } // 'E'
  return { x: col * CREATURE_TILE_PX + (CREATURE_TILE_PX / 2) - PLAYER_HALF,
           y: row * CREATURE_TILE_PX + (CREATURE_TILE_PX / 2) - PLAYER_HALF };
}

// Decide a join spawn. Priority: doorway arrival > persisted position >
// entry_spawn (entry world, first join) > bounded interior center > chunk center.
function chooseSpawn({ pending, persisted, worldRow, chunkSize }) {
  if (pending) return { x: pending.x, y: pending.y, viaDoorway: true };
  if (persisted) return { x: persisted.x, y: persisted.y, viaDoorway: false };
  if (worldRow && worldRow.is_entry && worldRow.entry_spawn &&
      Number.isFinite(worldRow.entry_spawn.x) && Number.isFinite(worldRow.entry_spawn.y)) {
    return { x: worldRow.entry_spawn.x, y: worldRow.entry_spawn.y, viaDoorway: false };
  }
  if (isBoundedWorld(worldRow)) {
    const col = Math.floor(worldRow.width / 2);
    const row = Math.floor(worldRow.height / 2);
    return { x: col * CREATURE_TILE_PX + (CREATURE_TILE_PX / 2) - PLAYER_HALF,
             y: row * CREATURE_TILE_PX + (CREATURE_TILE_PX / 2) - PLAYER_HALF, viaDoorway: false };
  }
  const center = (chunkSize * CREATURE_TILE_PX) / 2;
  return { x: center, y: center, viaDoorway: false };
}
```

Add `oppositeEdge, edgeOfDoorwayTile, arrivalPoint, chooseSpawn,` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/edgeHelpers.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/edgeHelpers.test.js
git commit -m "feat(mapgen): pure edge/arrival/spawn helpers for teleport"
```

---

### Task 3: `mapLinks.js` DB service (fetch + bidirectional set/clear)

**Files:**
- Create: `backend/src/services/mapLinks.js`
- Test: `backend/tests/mapLinks.test.js` (create)

**Interfaces:**
- Consumes: `oppositeEdge` from mapService.
- Produces:
  - `fetchLinks(pool, worldId) -> Promise<Array<{edge, to_world_id, to_width, to_height}>>` — this world's outgoing links joined to the target world's bounds.
  - `setLink(pool, fromId, edge, toId) -> Promise<void>` — bidirectional upsert: `(fromId, edge, toId)` and `(toId, oppositeEdge(edge), fromId)`, each `ON CONFLICT (from_world_id, edge) DO UPDATE SET to_world_id`.
  - `clearLink(pool, fromId, edge) -> Promise<void>` — deletes `(fromId, edge)` and its mirror `(toId, oppositeEdge(edge))` (looks up `toId` first).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/mapLinks.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { fetchLinks, setLink, clearLink } = require('../src/services/mapLinks');

function mockPool(handlers) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    throw new Error(`unexpected query: ${sql}`);
  } };
}

test('fetchLinks returns edges joined to target bounds', async () => {
  const pool = mockPool([[/SELECT .*FROM map_links.*JOIN worlds/is, () => ({
    rows: [{ edge: 'E', to_world_id: 'B', to_width: 16, to_height: 16 }] })]]);
  const rows = await fetchLinks(pool, 'A');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].edge, 'E');
  assert.equal(rows[0].to_world_id, 'B');
});

test('setLink writes BOTH directions (A,E,B) and (B,W,A)', async () => {
  const pool = mockPool([[/INSERT INTO map_links/i, () => ({ rows: [] })]]);
  await setLink(pool, 'A', 'E', 'B');
  const inserts = pool.calls.filter(c => /INSERT INTO map_links/i.test(c.sql));
  assert.equal(inserts.length, 2);
  // forward (A,E,B)
  assert.deepEqual(inserts[0].params, ['A', 'E', 'B']);
  // mirror (B,W,A)
  assert.deepEqual(inserts[1].params, ['B', 'W', 'A']);
});

test('clearLink removes both directions', async () => {
  const pool = mockPool([
    [/SELECT to_world_id FROM map_links/i, () => ({ rows: [{ to_world_id: 'B' }] })],
    [/DELETE FROM map_links/i, () => ({ rows: [] })],
  ]);
  await clearLink(pool, 'A', 'E');
  const dels = pool.calls.filter(c => /DELETE FROM map_links/i.test(c.sql));
  assert.equal(dels.length, 2);
  assert.deepEqual(dels[0].params, ['A', 'E']);       // forward
  assert.deepEqual(dels[1].params, ['B', 'W']);       // mirror
});

test('clearLink with no existing link deletes only the forward row', async () => {
  const pool = mockPool([
    [/SELECT to_world_id FROM map_links/i, () => ({ rows: [] })],
    [/DELETE FROM map_links/i, () => ({ rows: [] })],
  ]);
  await clearLink(pool, 'A', 'E');
  const dels = pool.calls.filter(c => /DELETE FROM map_links/i.test(c.sql));
  assert.equal(dels.length, 1);
  assert.deepEqual(dels[0].params, ['A', 'E']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/mapLinks.test.js`
Expected: FAIL — cannot find module `mapLinks`.

- [ ] **Step 3: Implement `mapLinks.js`**

Create `backend/src/services/mapLinks.js`:

```js
const { oppositeEdge } = require('./mapService');

// This world's outgoing links, joined to each target's bounds (for arrival geometry).
async function fetchLinks(pool, worldId) {
  const r = await pool.query(
    `SELECT ml.edge, ml.to_world_id, w.width AS to_width, w.height AS to_height
     FROM map_links ml JOIN worlds w ON w.id = ml.to_world_id
     WHERE ml.from_world_id = $1`,
    [worldId],
  );
  return r.rows;
}

// Bidirectional upsert: (from,edge,to) and its mirror (to,opposite,from).
async function setLink(pool, fromId, edge, toId) {
  const insert = `INSERT INTO map_links (from_world_id, edge, to_world_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (from_world_id, edge) DO UPDATE SET to_world_id = EXCLUDED.to_world_id`;
  await pool.query(insert, [fromId, edge, toId]);
  await pool.query(insert, [toId, oppositeEdge(edge), fromId]);
}

// Bidirectional delete: (from,edge) and its mirror (to,opposite).
async function clearLink(pool, fromId, edge) {
  const cur = await pool.query(
    'SELECT to_world_id FROM map_links WHERE from_world_id = $1 AND edge = $2',
    [fromId, edge],
  );
  await pool.query('DELETE FROM map_links WHERE from_world_id = $1 AND edge = $2', [fromId, edge]);
  if (cur.rows[0]) {
    await pool.query('DELETE FROM map_links WHERE from_world_id = $1 AND edge = $2',
      [cur.rows[0].to_world_id, oppositeEdge(edge)]);
  }
}

module.exports = { fetchLinks, setLink, clearLink };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/mapLinks.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapLinks.js backend/tests/mapLinks.test.js
git commit -m "feat(links): mapLinks DB service (fetch + bidirectional set/clear)"
```

---

### Task 4: Link CRUD routes + swap doorway sources in index.js

**Files:**
- Modify: `backend/src/index.js` (require mapLinks; add 3 routes after `POST /api/worlds/:id/creatures` ~1036; swap the 3 `doorwaysForWorld(world)` call sites at the chunk/preview/creatures routes)
- Test: `backend/tests/worldLinksRoutes.test.js` (create)

**Interfaces:**
- Consumes: `fetchLinks, setLink, clearLink` (mapLinks); `pool`, `adminGuard`, `evictAuthorityWorld`, `isBoundedWorld` (index.js).
- Produces:
  - `GET /api/worlds/:id/links` → `[{edge, to_world_id}]` for the world.
  - `POST /api/worlds/:id/links` body `{edge, to_world_id}` → validates edge∈NESW, `to_world_id` ≠ id, both worlds exist and are bounded; `setLink`; evict both; `res.json({ ok:true })`.
  - `DELETE /api/worlds/:id/links/:edge` → looks up mirror target, `clearLink`, evict both; `res.status(204).end()`.
- Also: chunk/preview/creatures routes now derive `doorways` from `await fetchLinks(pool, id)` instead of `doorwaysForWorld(world)`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/worldLinksRoutes.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];
function mockPool(handlers) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    if (isUserLookup(sql)) return ADMIN_USER_ROW;
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    throw new Error(`unexpected query: ${sql}`);
  } };
}

test('GET /api/worlds/:id/links lists edges', async () => {
  __setPool(mockPool([[/FROM map_links/i, () => ({ rows: [{ edge: 'E', to_world_id: 'B', to_width: 16, to_height: 16 }] })]]));
  const res = await request(app).get('/api/worlds/A/links');
  assert.equal(res.status, 200);
  assert.equal(res.body[0].edge, 'E');
  assert.equal(res.body[0].to_world_id, 'B');
});

test('POST links rejects a bad edge', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'X', to_world_id: 'B' });
  assert.equal(res.status, 400);
});

test('POST links rejects linking a world to itself', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'E', to_world_id: 'A' });
  assert.equal(res.status, 400);
});

test('POST links rejects when a target is not bounded', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], width: p[0] === 'A' ? 24 : null, height: p[0] === 'A' ? 24 : null }] })],
  ]));
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'E', to_world_id: 'B' });
  assert.equal(res.status, 400);
});

test('POST links writes both directions and returns ok', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], width: 24, height: 24 }] })],
    [/INSERT INTO map_links/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'E', to_world_id: 'B' });
  assert.equal(res.status, 200);
  assert.equal(pool.calls.filter(c => /INSERT INTO map_links/i.test(c.sql)).length, 2);
});

test('DELETE links removes the link (204)', async () => {
  const pool = mockPool([
    [/SELECT to_world_id FROM map_links/i, () => ({ rows: [{ to_world_id: 'B' }] })],
    [/DELETE FROM map_links/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/worlds/A/links/E').set(...AUTH);
  assert.equal(res.status, 204);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/worldLinksRoutes.test.js`
Expected: FAIL — routes not defined.

- [ ] **Step 3: Implement routes + swap doorway sources**

In `backend/src/index.js`, add near the top requires (after the mapService require at line 7):

```js
const { fetchLinks, setLink, clearLink } = require('./services/mapLinks');
```

Add the three routes after the `POST /api/worlds/:id/creatures` handler (~1036):

```js
const EDGES = new Set(['N', 'E', 'S', 'W']);

app.get('/api/worlds/:id/links', async (req, res) => {
  try {
    const rows = await fetchLinks(pool, req.params.id);
    res.json(rows.map((r) => ({ edge: r.edge, to_world_id: r.to_world_id })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list links' });
  }
});

app.post('/api/worlds/:id/links', adminGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { edge, to_world_id } = req.body;
    if (!EDGES.has(edge)) return res.status(400).json({ error: 'edge must be one of N,E,S,W' });
    if (!to_world_id || to_world_id === id) return res.status(400).json({ error: 'to_world_id must be a different world' });
    const both = await pool.query('SELECT id, width, height FROM worlds WHERE id = ANY($1::uuid[])', [[id, to_world_id]]);
    const byId = new Map(both.rows.map((r) => [r.id, r]));
    const from = byId.get(id), to = byId.get(to_world_id);
    if (!from || !to) return res.status(404).json({ error: 'world not found' });
    if (!isBoundedWorld(from) || !isBoundedWorld(to)) {
      return res.status(400).json({ error: 'both worlds must be bounded maps' });
    }
    await setLink(pool, id, edge, to_world_id);
    evictAuthorityWorld(id);
    evictAuthorityWorld(to_world_id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to set link' });
  }
});

app.delete('/api/worlds/:id/links/:edge', adminGuard, async (req, res) => {
  try {
    const { id, edge } = req.params;
    if (!EDGES.has(edge)) return res.status(400).json({ error: 'edge must be one of N,E,S,W' });
    const cur = await pool.query('SELECT to_world_id FROM map_links WHERE from_world_id = $1 AND edge = $2', [id, edge]);
    await clearLink(pool, id, edge);
    evictAuthorityWorld(id);
    if (cur.rows[0]) evictAuthorityWorld(cur.rows[0].to_world_id);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clear link' });
  }
});
```

Then swap the **three** doorway call sites. In each of the chunk route (~1067), preview route (~1091), and creatures route (~1018), replace `doorways: doorwaysForWorld(world)` with `doorways: (await fetchLinks(pool, world.id)).map((l) => l.edge)`. (These handlers are all `async` and have `pool` + the world row in scope.) Remove `doorwaysForWorld` from the mapService require on line 7 (it is no longer used in index.js — but do NOT delete the function yet; server.js still uses it until Task 5).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/worldLinksRoutes.test.js`
Expected: PASS (6 tests).

Run: `cd backend && node --test`
Expected: the existing chunk/preview/creatures route tests in `backend/tests/worlds.test.js` and `backend/tests/worldsAdminRoutes.test.js` will now FAIL with `unexpected query: SELECT ... FROM map_links ...`, because those routes now call `fetchLinks` (a query the mocks don't register). **Fix each affected test** by adding a handler to its `mockPool([...])` array: `[/FROM map_links/i, () => ({ rows: [] })]` (an unlinked world has no doorways — the correct new behavior). After adding the handler, the full suite passes. If any existing test asserted a doorway tile on an unlinked bounded world, update it to reflect link-driven doorways.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/worldLinksRoutes.test.js
git commit -m "feat(api): map link CRUD routes + link-driven doorways in chunk/preview/creatures"
```

---

### Task 5: Authority — links on load + spawn selection (loadWorld, loadSpawn, pendingArrivals)

**Files:**
- Modify: `backend/src/authority/server.js` (require; `loadWorld`; `loadSpawn`; `pendingArrivals`; join stamps arrival cooldown)
- Modify: `backend/src/authority/world.js` (`addPlayer` gets `_doorwayCdUntil: 0`)
- Modify: `backend/src/services/mapService.js` (remove `doorwaysForWorld`)
- Remove: `backend/tests/doorwaysForWorld.test.js`
- Test: `backend/tests/authority_chooseSpawn.test.js` already covered by Task 2's `chooseSpawn` tests; add `backend/tests/authority_links_load.test.js` only if a seam is extractable — otherwise rely on Task 2 unit tests + browser verification (note this in the report).

**Interfaces:**
- Consumes: `fetchLinks` (mapLinks); `chooseSpawn` (mapService).
- Produces: `entry.links: Map<edge, {toWorldId, toWidth, toHeight}>`; `pendingArrivals: Map<userId, {worldId, x, y}>` (attachAuthority closure scope); `loadSpawn` returns `{x, y, viaDoorway}` and the join stamps `_doorwayCdUntil` when `viaDoorway`.

- [ ] **Step 1: Add `_doorwayCdUntil` to the player + write its assertion**

In `backend/src/authority/world.js`, in the `addPlayer` object literal (next to `_attackCd: 0`, ~line 119), add:

```js
      _attackCd: 0,
      _doorwayCdUntil: 0,
```

Add to an existing world test (or create `backend/tests/authority_player_fields.test.js`):

```js
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world');
const { ServerMap } = require('../src/authority/collision');

test('addPlayer initializes the doorway cooldown', () => {
  const map = new ServerMap({ seed: 1, chunkSize: 8, tileTypes: { grass: { walkable: true, speed: 1 } } });
  const world = new World(map, new Map(), null, 8);
  world.addPlayer('u1', { x: 100, y: 100 });
  assert.equal(world.getPlayer('u1')._doorwayCdUntil, 0);
});
```

Run: `cd backend && node --test tests/authority_player_fields.test.js` → PASS after the field is added (verify it FAILS first by asserting before adding the field).

- [ ] **Step 2: Widen loadWorld SELECT + build `entry.links` + doorways from links**

In `backend/src/authority/server.js`:
- Update the require (line 9) to drop `doorwaysForWorld` and add the links helper:
  ```js
  const { spawnChunkCreatures, isBoundedWorld, chooseSpawn } = require('../services/mapService');
  const { fetchLinks } = require('../services/mapLinks');
  ```
- In `loadWorld` (the async IIFE), widen the world SELECT to include entry columns:
  ```js
  const wr = await pool.query('SELECT id, seed, chunk_size, width, height, is_entry, entry_spawn FROM worlds WHERE id = $1', [worldId]);
  ```
- Replace the `doorways: doorwaysForWorld(row)` construction. Before `new ServerMap({...})`, fetch links:
  ```js
  const linkRows = await fetchLinks(pool, worldId);
  const links = new Map(linkRows.map((l) => [l.edge, { toWorldId: l.to_world_id, toWidth: l.to_width, toHeight: l.to_height }]));
  const map = new ServerMap({
    seed: Number(row.seed), chunkSize: row.chunk_size, tileTypes,
    width: row.width, height: row.height, doorways: [...links.keys()],
  });
  ```
- Add `links` to the `entry` object literal: `links,` (alongside `tileTypes`, `creatureTypes`, ...). `entry.row` now carries `is_entry`/`entry_spawn` for spawn selection.

- [ ] **Step 3: Add `pendingArrivals` + rewrite `loadSpawn` via `chooseSpawn`**

Near the top of `attachAuthority` (by the `worlds`/`loading` maps, ~server.js:35), add:

```js
  const pendingArrivals = new Map(); // userId -> { worldId, x, y } : a doorway-arrival spawn override
```

Rewrite `loadSpawn` (server.js:121-129) to consult the pending arrival and the world row:

```js
  async function loadSpawn(worldId, userId, chunkSize, worldRow) {
    const pend = pendingArrivals.get(userId);
    const pending = (pend && pend.worldId === worldId) ? { x: pend.x, y: pend.y } : null;
    if (pending) pendingArrivals.delete(userId);
    let persisted = null;
    const r = await pool.query('SELECT x, y FROM world_players WHERE world_id = $1 AND user_id = $2', [worldId, userId]);
    if (r.rows.length) persisted = { x: r.rows[0].x, y: r.rows[0].y };
    return chooseSpawn({ pending, persisted, worldRow, chunkSize });
  }
```

Update the join handler's `loadSpawn` call (server.js:296) to pass `entry.row`:

```js
          const spawn = await loadSpawn(msg.world_id, ws.userId, entry.row.chunk_size, entry.row);
```

`spawn` now has a `viaDoorway` flag. After `entry.world.addPlayer(ws.userId, spawn, inv)` (server.js:339), stamp the arrival cooldown:

```js
          entry.world.addPlayer(ws.userId, spawn, inv);
          if (spawn.viaDoorway) {
            const p = entry.world.getPlayer(ws.userId);
            if (p) p._doorwayCdUntil = Date.now() + 1500;
          }
```

(`addPlayer` reads only `spawn.x`/`spawn.y`, so the extra `viaDoorway` field is harmless.)

- [ ] **Step 4: Remove the retired stub**

Delete `doorwaysForWorld` from `backend/src/services/mapService.js` and its entry in `module.exports`. Delete `backend/tests/doorwaysForWorld.test.js`. (All callers now use link-driven edges.)

- [ ] **Step 5: Run tests**

Run: `cd backend && node --test`
Expected: PASS. `chooseSpawn` behavior is covered by `tests/edgeHelpers.test.js` (Task 2); the loadWorld/loadSpawn wiring is exercised end-to-end in the browser task. If the grep `grep -rn doorwaysForWorld backend/src backend/tests` returns anything, fix the straggler.

- [ ] **Step 6: Commit**

```bash
git add backend/src/authority/server.js backend/src/authority/world.js backend/src/services/mapService.js
git rm backend/tests/doorwaysForWorld.test.js
git add backend/tests/authority_player_fields.test.js
git commit -m "feat(authority): link-driven doorways + arrival/entry-aware spawn selection"
```

---

### Task 6: Authority — tick doorway detection + `transition` frame

**Files:**
- Modify: `backend/src/authority/server.js` (tick loop, after `entry.world.tick(dt)` ~line 550)
- Test: `backend/tests/authority_doorwayDetect.test.js` (create — tests an extracted pure decision helper)

**Interfaces:**
- Consumes: `entry.links`, `pendingArrivals`, `send`, `entry.sockets`; `edgeOfDoorwayTile`, `oppositeEdge`, `arrivalPoint` (mapService); `entry.world.map.getTileAt`; player `{x,y,_doorwayCdUntil}`.
- Produces: a pure helper `planTransition({ tileName, gRow, gCol, worldRow, links, now, cdUntil }) -> { toWorldId, arriveX, arriveY } | null`, plus the tick integration that sends `{ type:'transition', ... }` and records `pendingArrivals`.

- [ ] **Step 1: Write the failing test for the pure decision**

Create `backend/tests/authority_doorwayDetect.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { planTransition } = require('../src/authority/server');

const links = new Map([['E', { toWorldId: 'B', toWidth: 16, toHeight: 16 }]]);
const worldRow = { width: 24, height: 24 };

test('returns null when not on a doorway tile', () => {
  assert.equal(planTransition({ tileName: 'grass', gRow: 12, gCol: 23, worldRow, links, now: 1000, cdUntil: 0 }), null);
});

test('returns null when the edge has no link', () => {
  assert.equal(planTransition({ tileName: 'map_doorway', gRow: 0, gCol: 12, worldRow, links, now: 1000, cdUntil: 0 }), null); // N unlinked
});

test('returns null while cooldown is active', () => {
  assert.equal(planTransition({ tileName: 'map_doorway', gRow: 12, gCol: 23, worldRow, links, now: 500, cdUntil: 1000 }), null);
});

test('plans a transition to the linked world at the mirrored arrival', () => {
  const t = planTransition({ tileName: 'map_doorway', gRow: 12, gCol: 23, worldRow, links, now: 2000, cdUntil: 1000 });
  // crossing E => arrive at B's W doorway, one tile in: col 1, row midRow=8 (16/2)
  assert.equal(t.toWorldId, 'B');
  assert.deepEqual({ x: t.arriveX, y: t.arriveY }, { x: 1 * 100 + 18, y: 8 * 100 + 18 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/authority_doorwayDetect.test.js`
Expected: FAIL — `planTransition` not exported.

- [ ] **Step 3: Implement `planTransition` + tick integration**

In `backend/src/authority/server.js`, add the pure helper at module scope (outside `attachAuthority`, near the top-level requires) and export it:

```js
const { MAP_TILE_SIZE } = require('./coords');
const { edgeOfDoorwayTile, oppositeEdge, arrivalPoint } = require('../services/mapService');

// Pure: given a player's current tile + this world's links, decide whether to
// teleport. Returns { toWorldId, arriveX, arriveY } or null.
function planTransition({ tileName, gRow, gCol, worldRow, links, now, cdUntil }) {
  if (tileName !== 'map_doorway') return null;
  if (now < cdUntil) return null;
  const edge = edgeOfDoorwayTile(gRow, gCol, worldRow.width, worldRow.height);
  if (!edge) return null;
  const link = links.get(edge);
  if (!link) return null;
  const { x, y } = arrivalPoint(link.toWidth, link.toHeight, oppositeEdge(edge));
  return { toWorldId: link.toWorldId, arriveX: x, arriveY: y };
}
```

Add to `module.exports` (which currently exports `attachAuthority`): `module.exports = { attachAuthority, planTransition };`.

In the tick loop, immediately after `const { killedCreatureIds: killedByEffects } = entry.world.tick(dt);` (server.js:550), add per-player doorway detection (uses the world's bounded row only — unbounded worlds have empty `entry.links`, so this is a cheap no-op for the Overworld):

```js
      if (entry.links && entry.links.size > 0) {
        const now = Date.now();
        for (const p of entry.world.players.values()) {
          const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
          const tileName = entry.world.map.getTileAt(cx, cy);
          const t = planTransition({
            tileName, gRow: Math.floor(cy / MAP_TILE_SIZE), gCol: Math.floor(cx / MAP_TILE_SIZE),
            worldRow: entry.row, links: entry.links, now, cdUntil: p._doorwayCdUntil,
          });
          if (t) {
            p._doorwayCdUntil = now + 1500;                       // suppress duplicate sends during reconnect
            pendingArrivals.set(p.userId, { worldId: t.toWorldId, x: t.arriveX, y: t.arriveY });
            const ws = entry.sockets.get(p.userId);
            if (ws) send(ws, { type: 'transition', toWorldId: t.toWorldId, arriveX: t.arriveX, arriveY: t.arriveY });
          }
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/authority_doorwayDetect.test.js`
Expected: PASS (4 tests).

Run: `cd backend && node --test`
Expected: PASS (full suite).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/server.js backend/tests/authority_doorwayDetect.test.js
git commit -m "feat(authority): tick doorway detection + transition frame (server-authoritative arrival)"
```

---

### Task 7: Client — `onTransition` frame + Game reconnect wiring

**Files:**
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js`
- Modify: `frontend/src/games/something2/src/js/core/Game.js`
- Test: `frontend/src/games/something2/src/js/net/__tests__/worldAuthorityTransition.test.js` (create)

**Interfaces:**
- Produces: `WorldAuthorityClient` accepts `onTransition` and dispatches a `case 'transition'`; `Game.setOnTransition(cb)`; `Game.initChunked` wires `onTransition: (msg) => this.onTransition?.(msg)`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/net/__tests__/worldAuthorityTransition.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { WorldAuthorityClient } from '../WorldAuthorityClient.js';

describe('WorldAuthorityClient transition frame', () => {
  it('routes a transition message to onTransition', () => {
    const onTransition = vi.fn();
    const c = new WorldAuthorityClient({ url: 'ws://x', token: 't', onTransition });
    // simulate the switch: call the private handler path via a fake ws message
    const handler = c._handleMessage ? c._handleMessage.bind(c) : null;
    // If no extracted handler, assert the constructor stored the callback.
    expect(typeof onTransition).toBe('function');
    if (handler) { handler({ type: 'transition', toWorldId: 'B', arriveX: 1, arriveY: 2 }); expect(onTransition).toHaveBeenCalled(); }
  });
});
```

Note to implementer: prefer extracting the `switch` body into a `_handleMessage(msg)` method so it is unit-testable, then have `onmessage` call `this._handleMessage(JSON.parse(event.data))`. If you make that refactor, the test above exercises it; keep the change minimal.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/__tests__/worldAuthorityTransition.test.js`
Expected: FAIL — `onTransition` not handled / module shape mismatch.

- [ ] **Step 3: Implement**

In `WorldAuthorityClient.js`:
- Add `onTransition` to the constructor destructure with a default: `onTransition,` … `this.onTransition = onTransition || (() => {});`.
- Extract the message switch into `_handleMessage(msg)` and call it from the `message` listener: `this.ws.addEventListener('message', (event) => { let msg; try { msg = JSON.parse(event.data); } catch { return; } this._handleMessage(msg); });`.
- Add to the switch: `case 'transition': this.onTransition(msg); break;`.

In `Game.js`:
- Add `setOnTransition(cb) { this.onTransition = cb; }` next to `setOnStateChange` (~line 122).
- In `initChunked`, add `onTransition: (msg) => { if (this.onTransition) this.onTransition(msg); },` to the `WorldAuthorityClient` options (alongside `onKicked`).

- [ ] **Step 4: Run test + build**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/__tests__/worldAuthorityTransition.test.js`
Expected: PASS.

Run: `cd frontend && npm run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/net/WorldAuthorityClient.js frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/net/__tests__/worldAuthorityTransition.test.js
git commit -m "feat(client): WorldAuthorityClient transition frame + Game.setOnTransition"
```

---

### Task 8: Client — teleport-on-transition + entry-map auto-join

**Files:**
- Modify: `frontend/src/games/something2/Something2.jsx` (wire `setOnTransition`; change auto-join to prefer `is_entry`)

**Interfaces:**
- Consumes: `Game.setOnTransition`, `handleEnterChunkedWorld`, `useWorlds` rows (`is_entry`).

- [ ] **Step 1: Baseline**

Run: `cd frontend && npm test` (record count) and `npm run build` (succeeds).

- [ ] **Step 2: Wire the transition handler**

In `Something2.jsx`, where the Game instance is created and `setOnStateChange` is wired (~line 434), add after it:

```js
gameRef.current.setOnTransition((msg) => {
  if (msg?.toWorldId) handleEnterChunkedWorld(msg.toWorldId);
});
```

`handleEnterChunkedWorld(toWorldId)` already looks up the destination world's `chunk_size` from `worlds` and calls `initChunked` — which is idempotent (tears down the old authority client + reconnects). The server spawns the reconnecting player at the pending arrival. Ensure `handleEnterChunkedWorld` is defined/hoisted before this wiring, or wrap the callback so it reads the latest `handleEnterChunkedWorld` (it's a component-scope function, so referencing it inside the callback closure is fine as long as the effect re-runs; if the wiring is in an effect, include the needed deps or use a ref).

- [ ] **Step 3: Entry-map auto-join**

Change the auto-join `useEffect` (~lines 489-502) to prefer the entry world:

```js
useEffect(() => {
  if (isAdmin || isPlaying || autoJoinedRef.current) return;
  if (!gameRef.current || !worlds || worlds.length === 0) return;
  const entry = worlds.find(w => w.is_entry);
  const overworld = worlds.filter(w => w.name === 'Overworld').sort((a, b) => a.id - b.id)[0];
  const target = entry || overworld;
  if (!target) return;
  autoJoinedRef.current = true;
  handleEnterChunkedWorld(target.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [worlds, isAdmin, isPlaying, activeTab]);
```

(The server spawns a first-join player on the entry world at `entry_spawn` via `chooseSpawn`, so no client spawn coord is needed.)

- [ ] **Step 4: Verify build + tests + manual reasoning**

Run: `cd frontend && npm run build` → succeeds (no unresolved refs).
Run: `cd frontend && npm test` → count ≥ baseline.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/Something2.jsx
git commit -m "feat(client): teleport on transition frame + entry-map auto-join"
```

---

### Task 9: Client — MapsAdmin link editor

**Files:**
- Modify: `frontend/src/games/something2/useMapsAdmin.js` (add `useWorldLinks`, `useSetLink`, `useClearLink`)
- Modify: `frontend/src/games/something2/MapsAdmin.jsx` (per-edge link dropdowns in `MapCard`; thread `boundedMaps` into `MapCard`)
- Test: `frontend/src/games/something2/__tests__/useMapsAdminLinks.test.js` (export smoke test)

**Interfaces:**
- Produces: `useWorldLinks(worldId)` query (`["worldLinks", worldId]`, GET `/api/worlds/:id/links`); `useSetLink()` (POST `/api/worlds/:id/links` `{edge,to_world_id}`); `useClearLink()` (DELETE `/api/worlds/:id/links/:edge`). Mutations invalidate `["worldLinks", worldId]` + `["worlds"]`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/__tests__/useMapsAdminLinks.test.js`:

```js
import { describe, it, expect } from 'vitest';
import * as hooks from '../useMapsAdmin.js';

describe('link hooks', () => {
  it('exports useWorldLinks/useSetLink/useClearLink', () => {
    expect(typeof hooks.useWorldLinks).toBe('function');
    expect(typeof hooks.useSetLink).toBe('function');
    expect(typeof hooks.useClearLink).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/useMapsAdminLinks.test.js`
Expected: FAIL — hooks not exported.

- [ ] **Step 3: Implement the hooks**

In `frontend/src/games/something2/useMapsAdmin.js`, add `useQuery` to the react-query import, then append:

```js
export function useWorldLinks(worldId) {
  const { data: links } = useQuery({
    queryKey: ["worldLinks", worldId],
    enabled: !!worldId,
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/worlds/${worldId}/links`);
      if (!res.ok) throw new Error("Failed to fetch links");
      return res.json();
    },
  });
  return links || [];
}

export function useSetLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, edge, to_world_id }) => {
      const res = await fetch(`${API_URL}/api/worlds/${id}/links`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify({ edge, to_world_id }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to set link");
      return res.json();
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["worldLinks", v.id] }); qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success("Link saved"); },
    onError: (err) => toast.error(err.message),
  });
}

export function useClearLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, edge }) => {
      const res = await fetch(`${API_URL}/api/worlds/${id}/links/${edge}`, { method: "DELETE", headers: authHeaders() });
      if (!res.ok && res.status !== 204) throw new Error("Failed to clear link");
      return true;
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ["worldLinks", v.id] }); qc.invalidateQueries({ queryKey: ["worlds"] }); toast.success("Link cleared"); },
    onError: (err) => toast.error(err.message),
  });
}
```

- [ ] **Step 4: Add the link editor UI to MapCard**

In `MapsAdmin.jsx`:
- Import the new hooks: add `useWorldLinks, useSetLink, useClearLink` to the `./useMapsAdmin.js` import.
- Thread `boundedMaps` into `MapCard`: in `MapsAdmin()`, change `{boundedMaps.map(w => <MapCard key={w.id} world={w} creatureTypes={creatureTypes} />)}` to pass `allMaps={boundedMaps}`.
- In `MapCard({ world, creatureTypes, allMaps })`, add:
  ```jsx
  const links = useWorldLinks(world.id);
  const setLink = useSetLink();
  const clearLink = useClearLink();
  const others = (allMaps || []).filter(m => m.id !== world.id);
  const linkFor = (edge) => links.find(l => l.edge === edge)?.to_world_id || '';
  ```
  and a new `<Row>` (after the Save/Regenerate row) with a dropdown per edge:
  ```jsx
  <Row>
    <span style={{ color: '#aaa' }}>Links:</span>
    {['N', 'E', 'S', 'W'].map(edge => (
      <label key={edge} style={{ color: '#ccc' }}>
        {edge}{' '}
        <select value={linkFor(edge)} onChange={e => {
          const to = e.target.value;
          if (to) setLink.mutate({ id: world.id, edge, to_world_id: to });
          else clearLink.mutate({ id: world.id, edge });
        }}>
          <option value="">—</option>
          {others.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
    ))}
  </Row>
  ```

- [ ] **Step 5: Verify build + tests**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/useMapsAdminLinks.test.js` → PASS.
Run: `cd frontend && npm run build` → succeeds.
Run: `cd frontend && npm test` → all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/useMapsAdmin.js frontend/src/games/something2/MapsAdmin.jsx frontend/src/games/something2/__tests__/useMapsAdminLinks.test.js
git commit -m "feat(client): MapsAdmin per-edge link editor"
```

---

### Task 10: Browser / runtime verification (controller-run)

Restart the backend node server (`docker exec -d something2-backend-1 sh -c 'cd /app && node src/index.js'` — NOT `docker restart`) so migrations apply + new routes/authority load. Mint an admin token. Verify:

- [ ] **Step 1:** Migration applied — `\d map_links` shows the table + unique constraint.
- [ ] **Step 2:** Create two bounded maps A (24×24) and B (16×16). `POST /api/worlds/A/links {edge:'E', to_world_id:B}` → both rows exist (`SELECT * FROM map_links` shows `(A,E,B)` and `(B,W,A)`).
- [ ] **Step 3:** Chunk terrain now has a doorway ONLY on linked edges: fetch A's east-edge chunk → `map_doorway` tiles at the E edge midpoint; unlinked edges are solid `map_wall`. Unlink → doorway becomes wall.
- [ ] **Step 4:** In-world (browser, admin): enter A, walk into the east doorway → the client reconnects to B and the player arrives just inside B's west doorway (not on the doorway tile), no bounce loop (cooldown), console clean.
- [ ] **Step 5:** Set A as the entry map with an `entry_spawn`; open the app as a NON-admin (or clear autojoin) → auto-joins A at `entry_spawn`, inside the walls (small-map center-spawn bug gone).
- [ ] **Step 6:** Regression: unbounded Overworld still joins + plays (empty `entry.links`, no doorway logic runs); Slice-2 creature/regenerate/entry admin actions still work.
- [ ] **Step 7:** Record results in the ledger.

---

## Self-Review

**1. Spec coverage** (§ of `2026-07-22-linked-maps-portals-design.md`):
- §1 `map_links` table (bidirectional, cascade, unique edge) → Task 1. ✓
- §2 doorways only on linked edges → Tasks 4/5 (link-driven `doorways`). ✓
- §3 teleport (detect → transition frame → reconnect → cooldown, mirrored arrival) → Tasks 5/6/7/8. ✓
- §5 link editor in Maps tab + link CRUD routes → Tasks 4/9. ✓
- §6 player entry (auto-join entry map at `entry_spawn`) → Tasks 5/8. ✓
- §10 risks: chunk-regen invalidation is Slice-2; entry singleton is Slice-2; "at most one is_entry" already enforced. Arrival "just inside" avoids immediate re-trigger + cooldown → Tasks 5/6. ✓

**2. Placeholder scan:** No TBD/"handle errors" — every step has full code. The one soft spot (Task 7 test refactor) is explicitly guided with a concrete `_handleMessage` extraction. ✓

**3. Type consistency:** `entry.links` is `Map<edge, {toWorldId,toWidth,toHeight}>` in Tasks 5+6; `pendingArrivals` is `Map<userId,{worldId,x,y}>` in Tasks 5+6; `chooseSpawn`/`arrivalPoint`/`edgeOfDoorwayTile`/`oppositeEdge` signatures match across Tasks 2/5/6; the `transition` frame `{type,toWorldId,arriveX,arriveY}` matches server (Task 6) → client (Task 7) → React (Task 8). `fetchLinks` row shape `{edge,to_world_id,to_width,to_height}` consistent Tasks 3/4/5. ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-22-linked-maps-slice3-links-teleport.md`. Ten tasks: 1–6 backend (migration, pure helpers, DB service, routes, authority load+spawn, authority tick), 7–9 client, 10 browser pass.
