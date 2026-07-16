# Connected Chunked World — Phase 2 (World & Chunk Model) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist worlds and serve deterministic chunks over HTTP, caching each chunk on first request — so the client (Phases 3–5) can stream a seamless overworld from `GET /api/worlds/:id/chunk`. (SOMET-55)

**Architecture:** A migration adds a `worlds` table (seed + chunk_size) and a `world_chunks` cache table (`(world_id, cx, cy)` unique → jsonb tile grid). New Express routes create/read worlds and serve chunks. The chunk route is a thin bridge: on a cache miss it loads the world's seed + the global tile-types, calls the pure `generateChunk` from Phase 1, stores the result in `world_chunks`, and returns it; on a hit it returns the cached grid without regenerating. Existing standalone `maps`/`map_entities` and all their routes are untouched.

**Tech Stack:** Node.js (CommonJS), Express 4, `pg` (raw parameterized queries), `node-pg-migrate`, Node's built-in test runner (`node --test` via `npm test`). No new dependencies.

## Global Constraints

- **CommonJS** (`require`/`module.exports`); Express 4; raw `pg` via the single `pool`. No ORM, no ESM.
- **No new dependencies.**
- **Existing error shape** (per `.ai/styleguides/backend.md`): `try { … res.json(row) } catch (err) { console.error(err); res.status(500).json({ error: '…' }) }`. Validation → `400 { error }`; not-found → `404 { error: '<resource> not found' }`; created → `201` with the row.
- **Do not modify existing routes or tables.** `maps`, `map_entities`, tile/entity routes stay as they are. Only add.
- **Chunk generation is pure + deterministic**: reuse Phase 1's `generateChunk(world, cx, cy)` from `backend/src/services/mapService.js` — do not reimplement generation. `world` config passed to it is `{ seed, chunkSize, tileTypes }`.
- **Tile types** come from the existing global `tile_types` table via the existing `getTileTypesMap()` helper in `index.js` (shape: `{ <name>: { id, color, walkable, speed, image, validNeighbors } }` — exactly what `generateChunk`/`worldConfig` accept).
- **Coordinates may be negative** (`cx`/`cy` ∈ ℤ). Parse and validate as integers; reject non-integers with `400`.
- **Testability without a live DB:** routes are exercised via the existing `__setPool` seam (`module.exports = { app, __setSpriteGen, __setPool }` in `index.js`; `app.listen`/`runMigrations` already gated behind `require.main === module`). Tests inject a mock `pool` whose `query` dispatches on the SQL text. Do not require a running Postgres for `npm test`.
- **Migration numbering:** next free timestamp is **`1714440012000`** (latest existing is `1714440011000_add_entity_sprite.js`). Do not reuse an existing timestamp (there was a prior collision at `1714440008000`).
- Commit after every task.

## File Structure

- **Create:** `backend/migrations/1714440012000_create_worlds_and_chunks.js` — `worlds` + `world_chunks` tables.
- **Modify:** `backend/src/index.js` — add `generateChunk` to the `mapService` require; add world routes (create/list/get) and the chunk route. Append near the other routes, before the `require.main === module` server-start block.
- **Modify:** `backend/tests/worlds.test.js` — new focused test file (create) for the world + chunk routes, using the `__setPool` mock.

---

### Task 1: Migration — `worlds` and `world_chunks` tables

**Files:**
- Create: `backend/migrations/1714440012000_create_worlds_and_chunks.js`

**Interfaces:**
- Produces two tables. `worlds(id uuid pk, name text, seed bigint, chunk_size int default 64, created_at, updated_at)`. `world_chunks(id uuid pk, world_id uuid → worlds ON DELETE CASCADE, cx int, cy int, data jsonb, created_at)` with a unique constraint on `(world_id, cx, cy)`.

- [ ] **Step 1: Write the migration**

Create `backend/migrations/1714440012000_create_worlds_and_chunks.js`:
```js
exports.up = (pgm) => {
  pgm.createTable('worlds', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    seed: { type: 'bigint', notNull: true },
    chunk_size: { type: 'integer', notNull: true, default: 64 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTable('world_chunks', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    cx: { type: 'integer', notNull: true },
    cy: { type: 'integer', notNull: true },
    data: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('world_chunks', 'world_chunks_world_cx_cy_unique', {
    unique: ['world_id', 'cx', 'cy'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('world_chunks');
  pgm.dropTable('worlds');
};
```

- [ ] **Step 2: Apply + verify the migration against the running DB**

The backend auto-runs migrations on startup. With the docker stack up, restart the backend and check the tables exist:
```bash
docker exec -d something2-backend-1 sh -c 'cd /app && npm start > /tmp/backend.log 2>&1'
# then:
docker exec something2-db-1 psql -U user -d game_db -c "\d worlds"
docker exec something2-db-1 psql -U user -d game_db -c "\d world_chunks"
```
Expected: both tables exist; `world_chunks` shows the unique constraint on `(world_id, cx, cy)` and the FK to `worlds`. If the DB isn't running, skip the live check and note it — the migration is verified structurally by the later route integration check.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/1714440012000_create_worlds_and_chunks.js
git commit -m "feat(worlds): worlds + world_chunks tables (SOMET-55)"
```

---

### Task 2: World create/list/get routes

**Files:**
- Modify: `backend/src/index.js` (add routes)
- Create: `backend/tests/worlds.test.js` (world CRUD tests)

**Interfaces:**
- Consumes: the mutable `pool` (via `__setPool` in tests). Existing error shape.
- Produces:
  - `POST /api/worlds` — body `{ name, seed?, chunk_size? }`. `name` required (400 if missing/empty). `seed` optional integer (default: a generated integer); `chunk_size` optional int (default 64). Inserts and returns `201` with the row.
  - `GET /api/worlds` — returns all worlds (array), newest first.
  - `GET /api/worlds/:id` — returns one world or `404 { error: 'world not found' }`.
  - `module.exports` continues to expose `{ app, __setSpriteGen, __setPool }` (unchanged — the seam already exists).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/worlds.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');

// A pool mock whose query() dispatches on the SQL text. `handlers` is an array
// of [regex, (params) => ({ rows }|Promise)] pairs, tried in order.
function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, fn] of handlers) {
        if (re.test(sql)) return fn(params);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('POST /api/worlds rejects a missing name', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/worlds').send({ seed: 5 });
  assert.equal(res.status, 400);
});

test('POST /api/worlds creates and returns the row', async () => {
  __setPool(mockPool([
    [/INSERT INTO worlds/i, (p) => ({
      rows: [{ id: 'w1', name: p[0], seed: String(p[1]), chunk_size: p[2] }],
    })],
  ]));
  const res = await request(app)
    .post('/api/worlds')
    .send({ name: 'Test World', seed: 42, chunk_size: 32 });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'w1');
  assert.equal(res.body.name, 'Test World');
  assert.equal(res.body.chunk_size, 32);
});

test('GET /api/worlds lists worlds', async () => {
  __setPool(mockPool([
    [/FROM worlds/i, () => ({ rows: [{ id: 'w1', name: 'A' }, { id: 'w2', name: 'B' }] })],
  ]));
  const res = await request(app).get('/api/worlds');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('GET /api/worlds/:id returns 404 when absent', async () => {
  __setPool(mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).get('/api/worlds/nope');
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — the world routes don't exist yet (404s where 201/200 expected).

- [ ] **Step 3: Add the routes**

In `backend/src/index.js`, first extend the `mapService` require (line ~7) to include `generateChunk` (used by Task 3):
```js
const { generateWorld, placeEntities, detectPathTile, uniqueTileNames, generateChunk } = require('./services/mapService');
```
Then add these routes near the other routes (before the `if (require.main === module) { … app.listen … }` block):
```js
// --- Worlds (chunked overworld) -------------------------------------------

app.post('/api/worlds', async (req, res) => {
  try {
    const { name, seed, chunk_size } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const worldSeed = Number.isFinite(seed) ? Math.floor(seed) : Math.floor(Math.random() * 2 ** 31);
    const chunkSize = Number.isFinite(chunk_size) ? Math.floor(chunk_size) : 64;
    const result = await pool.query(
      'INSERT INTO worlds (name, seed, chunk_size) VALUES ($1, $2, $3) RETURNING *',
      [name.trim(), worldSeed, chunkSize],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create world' });
  }
});

app.get('/api/worlds', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM worlds ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list worlds' });
  }
});

app.get('/api/worlds/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM worlds WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'world not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch world' });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (4 new world tests; all existing suites still green).

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/worlds.test.js
git commit -m "feat(worlds): create/list/get world routes (SOMET-55)"
```

---

### Task 3: Chunk route — generate on miss, serve from cache on hit

**Files:**
- Modify: `backend/src/index.js` (add the chunk route)
- Modify: `backend/tests/worlds.test.js` (append chunk tests)

**Interfaces:**
- Consumes: `generateChunk` (Phase 1), `getTileTypesMap()` (existing helper), the mutable `pool`.
- Produces: `GET /api/worlds/:id/chunk?cx=&cy=` →
  - `400 { error: 'cx and cy must be integers' }` if `cx`/`cy` are missing or non-integer.
  - On **cache hit** (`world_chunks` row exists for `(id, cx, cy)`): `200 { world_id, cx, cy, data }` from the cached row — **does not** query `worlds`/`tile_types` or regenerate.
  - On **cache miss**: load the world (`404 { error: 'world not found' }` if absent), fetch tile types, `generateChunk({ seed: Number(world.seed), chunkSize: world.chunk_size, tileTypes }, cx, cy)`, `INSERT … ON CONFLICT (world_id,cx,cy) DO NOTHING`, and return `200 { world_id, cx, cy, data }`.

**Determinism note:** `seed` is `bigint` in Postgres and arrives as a JS string; `Number(world.seed)` may lose precision above 2^53, but `hash2` reduces the seed with `>>> 0` (uses only the low 32 bits) so generation stays deterministic and stable for a given stored seed. World seeds are created as 31-bit integers in Task 2, so no precision is lost in practice.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/worlds.test.js`:
```js
// Build a tile_types result the generator accepts (object-per-row in getTileTypesMap;
// here as raw rows the SELECT returns).
const TILE_ROWS = [
  { id: 1, name: 'grass', color: '#0a0', walkable: true, speed: 1, image: null, valid_neighbors: [] },
  { id: 2, name: 'forest', color: '#060', walkable: true, speed: 1, image: null, valid_neighbors: [] },
  { id: 3, name: 'water', color: '#00a', walkable: false, speed: 1, image: null, valid_neighbors: [] },
  { id: 4, name: 'dirt', color: '#985', walkable: true, speed: 1, image: null, valid_neighbors: [] },
];

test('GET chunk rejects non-integer cx/cy', async () => {
  __setPool(mockPool([]));
  const res = await request(app).get('/api/worlds/w1/chunk?cx=foo&cy=0');
  assert.equal(res.status, 400);
});

test('GET chunk cache MISS generates, caches, returns an NxN grid', async () => {
  let inserted = null;
  const pool = mockPool([
    [/SELECT .* FROM world_chunks/i, () => ({ rows: [] })],               // cache miss
    [/FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', seed: '42', chunk_size: 8 }] })],
    [/FROM tile_types/i, () => ({ rows: TILE_ROWS })],
    [/INSERT INTO world_chunks/i, (p) => { inserted = p; return { rows: [] }; }],
  ]);
  __setPool(pool);
  const res = await request(app).get('/api/worlds/w1/chunk?cx=1&cy=-2');
  assert.equal(res.status, 200);
  assert.equal(res.body.cx, 1);
  assert.equal(res.body.cy, -2);
  assert.equal(res.body.data.length, 8);        // chunk_size rows
  assert.equal(res.body.data[0].length, 8);     // chunk_size cols
  assert.ok(inserted, 'expected an INSERT into world_chunks on cache miss');
});

test('GET chunk cache HIT returns cached data without regenerating', async () => {
  const cached = [['grass', 'grass'], ['dirt', 'water']];
  const pool = mockPool([
    [/SELECT .* FROM world_chunks/i, () => ({ rows: [{ data: cached }] })],  // cache hit
    // No worlds/tile_types handlers: if the route queries them on a hit, mockPool throws.
  ]);
  __setPool(pool);
  const res = await request(app).get('/api/worlds/w1/chunk?cx=0&cy=0');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, cached);
});

test('GET chunk returns 404 for an unknown world on cache miss', async () => {
  const pool = mockPool([
    [/SELECT .* FROM world_chunks/i, () => ({ rows: [] })],   // miss
    [/FROM worlds WHERE id/i, () => ({ rows: [] })],          // no such world
  ]);
  __setPool(pool);
  const res = await request(app).get('/api/worlds/ghost/chunk?cx=0&cy=0');
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test`
Expected: FAIL — the chunk route doesn't exist.

- [ ] **Step 3: Add the chunk route**

In `backend/src/index.js`, add after the `GET /api/worlds/:id` route:
```js
app.get('/api/worlds/:id/chunk', async (req, res) => {
  try {
    const cx = Number(req.query.cx);
    const cy = Number(req.query.cy);
    if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
      return res.status(400).json({ error: 'cx and cy must be integers' });
    }
    const worldId = req.params.id;

    // Cache hit?
    const cached = await pool.query(
      'SELECT data FROM world_chunks WHERE world_id = $1 AND cx = $2 AND cy = $3',
      [worldId, cx, cy],
    );
    if (cached.rows[0]) {
      return res.json({ world_id: worldId, cx, cy, data: cached.rows[0].data });
    }

    // Miss: load the world, generate, cache.
    const worldRes = await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
    const world = worldRes.rows[0];
    if (!world) return res.status(404).json({ error: 'world not found' });

    const tileTypes = await getTileTypesMap();
    const data = generateChunk(
      { seed: Number(world.seed), chunkSize: world.chunk_size, tileTypes },
      cx,
      cy,
    );

    await pool.query(
      `INSERT INTO world_chunks (world_id, cx, cy, data) VALUES ($1, $2, $3, $4)
       ON CONFLICT (world_id, cx, cy) DO NOTHING`,
      [worldId, cx, cy, JSON.stringify(data)],
    );

    res.json({ world_id: worldId, cx, cy, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch chunk' });
  }
});
```
Note: this route must be registered **after** `GET /api/worlds/:id` — Express matches in order, and `/api/worlds/:id/chunk` is more specific so registering it after the bare `:id` route is fine (the `:id` route won't match a path with a trailing `/chunk` segment).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test`
Expected: PASS (4 new chunk tests; all earlier suites green).

- [ ] **Step 5: Integration check against the running DB (if the stack is up)**

With the backend running (Task 1 restart) and at least one world created:
```bash
# create a world
curl -s -XPOST localhost:13101/api/worlds -H 'Content-Type: application/json' \
  -d '{"name":"IT","seed":7,"chunk_size":16}'
# → note the returned id, then request the same chunk twice:
curl -s "localhost:13101/api/worlds/<id>/chunk?cx=0&cy=0" | head -c 120
curl -s "localhost:13101/api/worlds/<id>/chunk?cx=0&cy=0" | head -c 120
```
Both requests return identical `data` (second served from `world_chunks`); verify a `world_chunks` row now exists:
`docker exec something2-db-1 psql -U user -d game_db -c "SELECT world_id, cx, cy FROM world_chunks;"`. If the stack isn't up, note it — the mocked tests already cover hit/miss/validation/404.

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.js backend/tests/worlds.test.js
git commit -m "feat(worlds): chunk route with generate-on-miss + cache (SOMET-55)"
```

---

## Self-Review

**Spec coverage (Phase 2 section of the design doc):**
- `worlds` table (id, name, seed, chunk_size, timestamps) → Task 1. ✓
- `world_chunks` table (`(world_id, cx, cy)` unique, `data` jsonb, materialized-on-demand cache) → Task 1. ✓
- `GET /api/worlds/:id/chunk?cx=&cy=` returns the chunk, generating + caching on first request → Task 3. ✓
- `POST /api/worlds` (name + seed) → Task 2. ✓
- Existing standalone `maps`/`map_entities` untouched → only-add constraint; no existing route/table modified. ✓
- Testing (spec): chunk API returns deterministic data; second request from cache; create-world happy path + validation → Task 2 tests (validation, create) + Task 3 tests (miss generates, hit serves cache, 404). ✓

**Placeholder scan:** No TBD/TODO/vague steps. Every route + test shows complete code. ✓

**Type/name consistency:** `generateChunk(world, cx, cy)` (Phase 1) is called with `{ seed, chunkSize, tileTypes }` — matches `worldConfig`'s expected shape (`chunkSize`, `tileTypes`). `getTileTypesMap()` (existing) returns the `{name:{...}}` object `worldConfig` accepts. The `__setPool`/`mockPool` seam matches the existing export `{ app, __setSpriteGen, __setPool }`. The chunk response shape `{ world_id, cx, cy, data }` is consistent between the hit and miss branches and the tests. Migration timestamp `1714440012000` is unique (verified against the migrations dir). ✓

## Out of scope for this plan (later phases, separate plans)
- World-space coordinate util + client `ChunkedMap` → Phase 3 (SOMET-56).
- Client streaming + multi-chunk render → Phase 4 (SOMET-57).
- World-space free-roaming creatures + entity persistence in `world_chunks` → Phase 5 (SOMET-58).
- Cache invalidation when tile-types change (chunks are materialized on demand; a tile-type edit does not retroactively rewrite cached chunks — acceptable for this epic; revisit if it becomes a problem).
