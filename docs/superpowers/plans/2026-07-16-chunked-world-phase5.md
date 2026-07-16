# Connected Chunked World — Phase 5 (World-Space Free-Roaming Creatures) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creatures live in world-space, persist in the DB, roam within the loaded chunk neighborhood, freeze when out of range and resume on re-entry, and cross chunk seams as the **same entity** — a creature placed near a seam walks across it and stays the same creature on the far side. (SOMET-58)

**Architecture:** A `world_creatures` table stores each creature's persistent world-pixel position + type. Creatures spawn **deterministically per chunk, tied to chunk materialization** — when `GET /chunk` first generates a chunk (cache miss), it also seeds that chunk's creatures into `world_creatures`. `GET /api/worlds/:id/creatures?cx=&cy=` returns creatures by their **current** position within a chunk's world bounds. The client's `CreatureManager` holds loaded creatures, roams the ones whose current chunk is in the loaded neighborhood (collision via `ChunkedMap`, reusing `resolveMove`), freezes the rest, marks moved creatures dirty, and periodically **flushes** dirty positions back via `POST /creatures/flush`. Creatures render in chunked mode depth-sorted with the player. All client-authoritative (consistent with the epic; authoritative server sim is the deferred Phase 6).

**Tech Stack:** Backend Node/Express (CommonJS) + `node-pg-migrate` + `node:test`. Frontend ES modules + Vitest. Reuses Phase 1 `densityAt`/`hash2`, Phase 3/4a `chunkOf`/`ChunkedMap`/`resolveMove`, Phase 4b `Game` chunked mode + `renderChunked`. No new deps.

## Global Constraints

- **CommonJS** backend / **ES modules** frontend. Existing error shape + `__setPool` test seam (backend); Vitest (frontend). No new deps.
- **Reuse, don't reinvent:** `densityAt`/`hash2`/`worldConfig`/`MAP_TILE_SIZE` (Phase 1), `chunkOf`/`chunkOrigin`/`parseKey` (Phase 3), `ChunkedMap`/`resolveMove`/`ChunkStreamer` (Phase 4a), `Game` chunked mode + `RenderSystem.renderChunked` (Phase 4b).
- **Deterministic spawn:** `spawnChunkCreatures(world, cx, cy, creatureTypes)` is a pure function of `(worldSeed, cx, cy, creatureTypes)` — no `Math.random`/`Date.now`. Roaming (live sim) may be stochastic but the `CreatureManager` takes an **injected rng** so tests are deterministic.
- **Creatures are queried/managed by CURRENT position**, not spawn chunk (they roam across seams). A creature's "current chunk" is `chunkOf(x, y)`.
- **Migration timestamp:** `1714440013000` (next free; latest is `1714440012000`).
- **Do not modify** the legacy play path, the tile/entity editors, or Phases 1–4 primitives except the explicitly-listed additive wiring (`renderChunked` gains a creatures arg; `Game` chunked update/render gain creature calls). Chunked-mode changes stay behind `this.chunked`.
- **Creature type source:** `creatureTypes` = entity_types with `hp > 0` and `name !== 'Player'` (mobile creatures), supplied by the route. If empty, spawn nothing (graceful). The browser task ensures at least one such type exists.
- Commit after every task. Visual/integration tasks are verified in the final browser task; pure logic is unit-tested per task.

## File Structure

- **Create:** `backend/migrations/1714440013000_create_world_creatures.js`.
- **Modify:** `backend/src/services/mapService.js` (add `spawnChunkCreatures` + export) + `backend/tests/worldGen.test.js` (append).
- **Modify:** `backend/src/index.js` (spawn on chunk miss; `GET /creatures`; `POST /creatures/flush`) + `backend/tests/worlds.test.js` (append).
- **Create:** `frontend/src/games/something2/src/js/entities/CreatureManager.js` + test; `frontend/src/games/something2/src/js/net/creatureClient.js` (fetch/flush) + test.
- **Modify:** `frontend/src/games/something2/src/js/systems/RenderSystem.js` (`renderChunked` draws creatures) + `core/Game.js` (chunked mode loads/roams/flushes creatures).

---

### Task 1: Migration — `world_creatures`

**Files:**
- Create: `backend/migrations/1714440013000_create_world_creatures.js`

**Interfaces:**
- Produces `world_creatures(id uuid pk, world_id uuid → worlds ON DELETE CASCADE, type text, x real, y real, hp int, facing text default 'S', created_at, updated_at)` with an index on `world_id`.

- [ ] **Step 1: Write the migration**

Create `backend/migrations/1714440013000_create_world_creatures.js`:
```js
exports.up = (pgm) => {
  pgm.createTable('world_creatures', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    type: { type: 'text', notNull: true },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    hp: { type: 'integer', notNull: true, default: 10 },
    facing: { type: 'text', notNull: true, default: 'S' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('world_creatures', 'world_id');
};

exports.down = (pgm) => pgm.dropTable('world_creatures');
```

- [ ] **Step 2: Apply + verify (if stack up)**

Restart backend (auto-runs migrations): `docker exec -d something2-backend-1 sh -c 'cd /app && npm start > /tmp/backend.log 2>&1'`, then `docker exec something2-db-1 psql -U user -d game_db -c "\d world_creatures"`. Confirm the table + FK + index. If the stack isn't up, note it — verified structurally by the route integration later.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/1714440013000_create_world_creatures.js
git commit -m "feat(creatures): world_creatures table (SOMET-58)"
```

---

### Task 2: Deterministic per-chunk creature spawn

**Files:**
- Modify: `backend/src/services/mapService.js` (add `spawnChunkCreatures` + export)
- Modify: `backend/tests/worldGen.test.js` (append)

**Interfaces:**
- Consumes: `worldConfig`, `densityAt`, `hash2`, `MAP_TILE_SIZE` constant (define `const MAP_TILE_SIZE = 100` local to mapService if not present, or reuse the existing tile size the generator uses — check the file; the chunk grid uses tiles, world px = tile*100 to match the frontend).
- Produces: `spawnChunkCreatures(world, cx, cy, creatureTypes) -> Array<{ type, x, y, hp, facing }>` — deterministic. For each tile in chunk `(cx,cy)`, a seeded roll decides a sparse spawn; picks a `creatureType` deterministically; positions the creature at the tile center in **world pixels**. Returns `[]` if `creatureTypes` is empty.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/worldGen.test.js`:
```js
const { spawnChunkCreatures } = require('../src/services/mapService');

const CREATURE_TYPES = [{ name: 'wolf', hp: 12 }, { name: 'boar', hp: 8 }];

test('spawnChunkCreatures is deterministic per (seed, chunk)', () => {
  const world = { seed: 5, chunkSize: 16, tileTypes: { grass: {} } };
  const a = spawnChunkCreatures(world, 0, 0, CREATURE_TYPES);
  const b = spawnChunkCreatures(world, 0, 0, CREATURE_TYPES);
  assert.deepEqual(a, b);
});

test('spawned creatures sit inside the chunk world bounds with valid types', () => {
  const N = 16, T = 100;
  const world = { seed: 9, chunkSize: N, tileTypes: { grass: {} } };
  const cx = 2, cy = -1;
  const creatures = spawnChunkCreatures(world, cx, cy, CREATURE_TYPES);
  const x0 = cx * N * T, y0 = cy * N * T;
  for (const c of creatures) {
    assert.ok(c.x >= x0 && c.x < x0 + N * T, `x ${c.x} out of chunk`);
    assert.ok(c.y >= y0 && c.y < y0 + N * T, `y ${c.y} out of chunk`);
    assert.ok(['wolf', 'boar'].includes(c.type));
    assert.ok(c.hp > 0);
  }
});

test('spawn is sparse (not one per tile) and non-empty somewhere', () => {
  const world = { seed: 3, chunkSize: 32, tileTypes: { grass: {} } };
  let total = 0, chunksWithCreatures = 0;
  for (let cx = 0; cx < 6; cx++) {
    const c = spawnChunkCreatures(world, cx, 0, CREATURE_TYPES);
    total += c.length;
    if (c.length) chunksWithCreatures++;
    assert.ok(c.length < 32 * 32, 'not sparse');
  }
  assert.ok(total > 0, 'expected some creatures across several chunks');
});

test('no creature types -> no creatures', () => {
  const world = { seed: 3, chunkSize: 16, tileTypes: { grass: {} } };
  assert.deepEqual(spawnChunkCreatures(world, 0, 0, []), []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npm test`
Expected: FAIL — `spawnChunkCreatures` undefined.

- [ ] **Step 3: Implement**

In `backend/src/services/mapService.js`, add (after `densityAt`). Use the module's tile size (the generator treats a tile as 100 world px, matching the frontend `MAP_TILE_SIZE`):
```js
const CREATURE_TILE_PX = 100;      // world px per tile (matches frontend MAP_TILE_SIZE)
const CREATURE_SALT = 0x5eed1e;    // separate the creature roll from terrain fields
const CREATURE_SPAWN_CHANCE = 0.01; // ~1% of tiles seed a creature (sparse)

// Deterministic per-chunk creature spawn. Pure function of (seed, cx, cy,
// creatureTypes). Each tile gets a seeded roll; a hit spawns a creature of a
// deterministically-picked type at the tile center (world pixels). Empty
// creatureTypes -> no creatures.
function spawnChunkCreatures(world, cx, cy, creatureTypes) {
  if (!creatureTypes || creatureTypes.length === 0) return [];
  const cfg = worldConfig(world);
  const N = cfg.chunkSize;
  const out = [];
  for (let lr = 0; lr < N; lr++) {
    for (let lc = 0; lc < N; lc++) {
      const gRow = cy * N + lr;
      const gCol = cx * N + lc;
      const roll = hash2(cfg.seed ^ CREATURE_SALT, gCol, gRow);
      if (roll >= CREATURE_SPAWN_CHANCE) continue;
      // pick a type deterministically from a second hash
      const pick = hash2((cfg.seed ^ CREATURE_SALT) >>> 1, gCol, gRow);
      const t = creatureTypes[Math.min(creatureTypes.length - 1, Math.floor(pick * creatureTypes.length))];
      out.push({
        type: t.name,
        x: gCol * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        y: gRow * CREATURE_TILE_PX + CREATURE_TILE_PX / 2,
        hp: t.hp || 10,
        facing: 'S',
      });
    }
  }
  return out;
}
```
Extend `module.exports` with `spawnChunkCreatures`.

- [ ] **Step 4: Run to verify passing**

Run: `cd backend && npm test`
Expected: PASS (4 new; existing worldGen/mapService suites green).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/tests/worldGen.test.js
git commit -m "feat(creatures): deterministic per-chunk creature spawn (SOMET-58)"
```

---

### Task 3: Backend — spawn-on-chunk-miss + creatures API

**Files:**
- Modify: `backend/src/index.js`
- Modify: `backend/tests/worlds.test.js` (append)

**Interfaces:**
- Consumes: `spawnChunkCreatures` (Task 2), `getEntityTypesMap()` (existing), the `pool`.
- Produces:
  - In `GET /api/worlds/:id/chunk` **cache-miss** branch: after inserting the `world_chunks` row, compute `creatureTypes` (entity types with `hp > 0` and name !== 'Player'), `spawnChunkCreatures(...)`, and bulk-insert them into `world_creatures`. (Cache hit → nothing new; a chunk is spawned exactly once.)
  - `GET /api/worlds/:id/creatures?cx=&cy=` → creatures whose **current** `(x,y)` lies in chunk `(cx,cy)`'s world bounds (`[cx·N·100, cx·N·100 + N·100)` etc). 400 on non-integer cx/cy; needs the world's `chunk_size`.
  - `POST /api/worlds/:id/creatures/flush` body `{ creatures: [{ id, x, y, facing }] }` → batch-update positions; returns `{ updated: <count> }`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/worlds.test.js` (reuses the `mockPool` helper already there):
```js
test('GET creatures returns rows for a chunk bbox', async () => {
  __setPool(mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', chunk_size: 16 }] })],
    [/FROM world_creatures/i, () => ({ rows: [{ id: 'c1', type: 'wolf', x: 810, y: 810, hp: 12, facing: 'S' }] })],
  ]));
  const res = await request(app).get('/api/worlds/w1/creatures?cx=0&cy=0');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 'c1');
});

test('GET creatures rejects non-integer cx/cy', async () => {
  __setPool(mockPool([]));
  const res = await request(app).get('/api/worlds/w1/creatures?cx=x&cy=0');
  assert.equal(res.status, 400);
});

test('POST creatures/flush batch-updates positions', async () => {
  let updates = 0;
  __setPool(mockPool([
    [/UPDATE world_creatures/i, () => { updates++; return { rowCount: 1, rows: [] }; }],
  ]));
  const res = await request(app)
    .post('/api/worlds/w1/creatures/flush')
    .send({ creatures: [{ id: 'c1', x: 850, y: 860, facing: 'E' }, { id: 'c2', x: 900, y: 900, facing: 'W' }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 2);
  assert.equal(updates, 2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npm test`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement**

Add `spawnChunkCreatures` to the `mapService` require. In `GET /api/worlds/:id/chunk`, in the **cache-miss branch after the `INSERT INTO world_chunks`**, add:
```js
    // Seed this chunk's creatures once, tied to chunk materialization.
    const entityTypes = await getEntityTypesMap();
    const creatureTypes = Object.values(entityTypes).filter((t) => (t.hp || 0) > 0 && t.name !== 'Player');
    // getEntityTypesMap keys by name; ensure name is present on each value:
    const typed = Object.entries(entityTypes)
      .filter(([name, t]) => (t.hp || 0) > 0 && name !== 'Player')
      .map(([name, t]) => ({ name, hp: t.hp }));
    const creatures = generateChunk ? spawnChunkCreatures(
      { seed: Number(world.seed), chunkSize: world.chunk_size, tileTypes }, cx, cy, typed,
    ) : [];
    for (const c of creatures) {
      await pool.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing) VALUES ($1,$2,$3,$4,$5,$6)`,
        [worldId, c.type, c.x, c.y, c.hp, c.facing],
      );
    }
```
(Use the `typed` array — `{name, hp}` — as `creatureTypes`. Remove the redundant `creatureTypes` line; keep `typed`.) Then add the two routes after the chunk route:
```js
app.get('/api/worlds/:id/creatures', async (req, res) => {
  try {
    const cx = Number(req.query.cx);
    const cy = Number(req.query.cy);
    if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
      return res.status(400).json({ error: 'cx and cy must be integers' });
    }
    const worldRes = await pool.query('SELECT * FROM worlds WHERE id = $1', [req.params.id]);
    const world = worldRes.rows[0];
    if (!world) return res.status(404).json({ error: 'world not found' });
    const span = world.chunk_size * 100;
    const x0 = cx * span, y0 = cy * span;
    const result = await pool.query(
      `SELECT id, type, x, y, hp, facing FROM world_creatures
       WHERE world_id = $1 AND x >= $2 AND x < $3 AND y >= $4 AND y < $5`,
      [req.params.id, x0, x0 + span, y0, y0 + span],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch creatures' });
  }
});

app.post('/api/worlds/:id/creatures/flush', async (req, res) => {
  try {
    const list = Array.isArray(req.body.creatures) ? req.body.creatures : [];
    let updated = 0;
    for (const c of list) {
      const r = await pool.query(
        `UPDATE world_creatures SET x=$1, y=$2, facing=$3, updated_at=now()
         WHERE id=$4 AND world_id=$5`,
        [c.x, c.y, c.facing || 'S', c.id, req.params.id],
      );
      updated += r.rowCount || 0;
    }
    res.json({ updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to flush creatures' });
  }
});
```
(The flush test's mock returns `rowCount: 1` per UPDATE, so `updated` = 2 for two creatures.)

- [ ] **Step 4: Run to verify passing**

Run: `cd backend && npm test`
Expected: PASS (3 new + all existing). If the stack is up, sanity: create a fresh world, GET a chunk (spawns creatures), then GET `/creatures?cx=0&cy=0` returns rows.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/worlds.test.js
git commit -m "feat(creatures): spawn-on-chunk-miss + creatures API (SOMET-58)"
```

---

### Task 4: `CreatureManager` — roam / freeze / dirty

**Files:**
- Create: `frontend/src/games/something2/src/js/entities/CreatureManager.js`
- Create: `frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.test.js`

**Interfaces:**
- Consumes: `chunkOf`, `CHUNK_KEY` from `../core/worldCoords.js`; `resolveMove` from `../systems/movement.js`.
- Produces: `class CreatureManager`:
  - `constructor(chunkSize, rng = Math.random)` — `chunkSize` in tiles; injectable `rng` for deterministic tests.
  - `addCreatures(list)` — merge creatures (each `{id,type,x,y,facing,hp}`) by `id` (no dupes); new creatures get `width/height` defaults (e.g. 48) + a wander direction.
  - `has(id)`, `count()`, `all() -> array`.
  - `update(dt, loadedKeys, chunkedMap)` — for each creature whose current chunk (`chunkOf(x,y)`) key is in `loadedKeys` (a Set/array), roam it: occasionally re-pick a wander direction (via `rng`), step via `resolveMove(chunkedMap, creature, dirX, dirY, dt)`, apply the new position, set `facing` from the direction, mark `dirty = true`. Creatures whose chunk isn't loaded are **frozen** (skipped). Returns the number roamed.
  - `takeDirty() -> array` — returns creatures changed since the last call (`{id,x,y,facing}`) and clears their dirty flags (for flushing).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.test.js`:
```js
import { describe, it, expect } from "vitest";
import { CreatureManager } from "../CreatureManager.js";
import { ChunkedMap } from "../../core/ChunkedMap.js";
import { CHUNK_KEY } from "../../core/worldCoords.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

const N = 4;
const T = MAP_TILE_SIZE;
const DEFS = { grass: { walkable: true, speed: 1 } };
const allGrass = () => Array.from({ length: N }, () => Array(N).fill("grass"));

// deterministic rng
function seqRng(vals) { let i = 0; return () => vals[i++ % vals.length]; }

function mapWith(...chunks) {
  const m = new ChunkedMap(N, DEFS);
  for (const [cx, cy] of chunks) m.setChunk(cx, cy, allGrass());
  return m;
}

describe("CreatureManager", () => {
  it("adds creatures without duplicating by id", () => {
    const cm = new CreatureManager(N);
    cm.addCreatures([{ id: "a", type: "wolf", x: 50, y: 50 }]);
    cm.addCreatures([{ id: "a", type: "wolf", x: 999, y: 999 }, { id: "b", type: "boar", x: 60, y: 60 }]);
    expect(cm.count()).toBe(2);
    expect(cm.has("a")).toBe(true);
  });

  it("roams creatures in a loaded chunk and marks them dirty", () => {
    const cm = new CreatureManager(N, seqRng([0.9, 0.0, 0.9, 0.0]));
    cm.addCreatures([{ id: "a", type: "wolf", x: 50, y: 50, hp: 10 }]);
    const map = mapWith([0, 0]);
    const roamed = cm.update(0.5, [CHUNK_KEY(0, 0)], map);
    expect(roamed).toBe(1);
    const dirty = cm.takeDirty();
    expect(dirty.length).toBe(1);
    expect(dirty[0].id).toBe("a");
    // second takeDirty is empty (flag cleared)
    expect(cm.takeDirty().length).toBe(0);
  });

  it("freezes creatures whose chunk is not loaded", () => {
    const cm = new CreatureManager(N, seqRng([0.9, 0.0]));
    cm.addCreatures([{ id: "a", type: "wolf", x: 50, y: 50 }]);
    const map = mapWith([5, 5]); // (0,0) NOT loaded
    const before = { ...cm.all()[0] };
    const roamed = cm.update(0.5, [CHUNK_KEY(5, 5)], map);
    expect(roamed).toBe(0);
    const after = cm.all()[0];
    expect(after.x).toBe(before.x); // frozen, unchanged
    expect(cm.takeDirty().length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run from `frontend/`: `npm run test -- CreatureManager`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Implement**

Create `frontend/src/games/something2/src/js/entities/CreatureManager.js`:
```js
import { chunkOf, CHUNK_KEY } from "../core/worldCoords.js";
import { resolveMove } from "../systems/movement.js";

// 8 wander directions (dx,dy) in world space.
const DIRS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const DIR_FACING = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
const CREATURE_SIZE = 48;
const CREATURE_SPEED = 40;       // world px/s (slower than the player)
const REDIRECT_CHANCE = 0.02;    // per update, chance to pick a new wander dir

export class CreatureManager {
  constructor(chunkSize, rng = Math.random) {
    this.chunkSize = chunkSize;
    this.rng = rng;
    this.creatures = new Map(); // id -> creature
  }

  addCreatures(list) {
    for (const c of list) {
      if (this.creatures.has(c.id)) continue;
      const dirIdx = Math.min(DIRS.length - 1, Math.floor(this.rng() * DIRS.length));
      this.creatures.set(c.id, {
        id: c.id, type: c.type, x: c.x, y: c.y,
        width: CREATURE_SIZE, height: CREATURE_SIZE,
        speed: CREATURE_SPEED, facing: c.facing || "S", hp: c.hp,
        _dir: dirIdx, dirty: false,
      });
    }
  }

  has(id) { return this.creatures.has(id); }
  count() { return this.creatures.size; }
  all() { return [...this.creatures.values()]; }

  update(dt, loadedKeys, chunkedMap) {
    const loaded = loadedKeys instanceof Set ? loadedKeys : new Set(loadedKeys);
    let roamed = 0;
    for (const c of this.creatures.values()) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (!loaded.has(CHUNK_KEY(cx, cy))) continue; // frozen (out of neighborhood)
      if (this.rng() < REDIRECT_CHANCE) {
        c._dir = Math.min(DIRS.length - 1, Math.floor(this.rng() * DIRS.length));
      }
      const [dx, dy] = DIRS[c._dir];
      const r = resolveMove(chunkedMap, c, dx, dy, dt);
      if (r.x !== c.x || r.y !== c.y) {
        c.x = r.x; c.y = r.y;
        c.facing = DIR_FACING[c._dir];
        c.dirty = true;
        roamed++;
      } else {
        // blocked -> turn for next time
        c._dir = (c._dir + 1) % DIRS.length;
      }
    }
    return roamed;
  }

  takeDirty() {
    const dirty = [];
    for (const c of this.creatures.values()) {
      if (c.dirty) {
        dirty.push({ id: c.id, x: c.x, y: c.y, facing: c.facing });
        c.dirty = false;
      }
    }
    return dirty;
  }
}
```

- [ ] **Step 4: Run to verify passing**

Run from `frontend/`: `npm run test -- CreatureManager`
Expected: PASS (3). Then full `npm run test` — all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/entities/CreatureManager.js frontend/src/games/something2/src/js/entities/__tests__/CreatureManager.test.js
git commit -m "feat(creatures): CreatureManager roam/freeze/dirty (SOMET-58)"
```

---

### Task 5: Creature client (fetch per chunk + flush)

**Files:**
- Create: `frontend/src/games/something2/src/js/net/creatureClient.js`
- Create: `frontend/src/games/something2/src/js/net/__tests__/creatureClient.test.js`

**Interfaces:**
- Produces:
  - `makeCreatureFetcher(worldId, apiUrl, fetchImpl = fetch) -> async (cx, cy) => Array<creature>` — GETs `${apiUrl}/api/worlds/${worldId}/creatures?cx=&cy=`, returns the array (throws on `!ok`).
  - `makeCreatureFlusher(worldId, apiUrl, fetchImpl = fetch) -> async (creatures) => number` — POSTs `{creatures}` to `.../creatures/flush`, returns `body.updated`; a no-op returning 0 when `creatures` is empty.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/something2/src/js/net/__tests__/creatureClient.test.js`:
```js
import { describe, it, expect } from "vitest";
import { makeCreatureFetcher, makeCreatureFlusher } from "../creatureClient.js";

describe("creatureClient", () => {
  it("fetches creatures for a chunk", async () => {
    let url = null;
    const fetchImpl = async (u) => { url = u; return { ok: true, json: async () => [{ id: "c1" }] }; };
    const fetchCreatures = makeCreatureFetcher("w1", "http://api", fetchImpl);
    const out = await fetchCreatures(2, -1);
    expect(out).toEqual([{ id: "c1" }]);
    expect(url).toBe("http://api/api/worlds/w1/creatures?cx=2&cy=-1");
  });

  it("flush POSTs dirty creatures and returns updated count", async () => {
    let body = null;
    const fetchImpl = async (u, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ updated: 2 }) }; };
    const flush = makeCreatureFlusher("w1", "http://api", fetchImpl);
    const n = await flush([{ id: "c1", x: 1, y: 2 }, { id: "c2", x: 3, y: 4 }]);
    expect(n).toBe(2);
    expect(body.creatures.length).toBe(2);
  });

  it("flush is a no-op for an empty list", async () => {
    let called = false;
    const flush = makeCreatureFlusher("w1", "http://api", async () => { called = true; return { ok: true, json: async () => ({}) }; });
    expect(await flush([])).toBe(0);
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run from `frontend/`: `npm run test -- creatureClient`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `frontend/src/games/something2/src/js/net/creatureClient.js`:
```js
export function makeCreatureFetcher(worldId, apiUrl, fetchImpl = fetch) {
  return async function fetchCreatures(cx, cy) {
    const res = await fetchImpl(`${apiUrl}/api/worlds/${worldId}/creatures?cx=${cx}&cy=${cy}`);
    if (!res.ok) throw new Error(`creature fetch failed (${cx},${cy})`);
    return res.json();
  };
}

export function makeCreatureFlusher(worldId, apiUrl, fetchImpl = fetch) {
  return async function flushCreatures(creatures) {
    if (!creatures || creatures.length === 0) return 0;
    const res = await fetchImpl(`${apiUrl}/api/worlds/${worldId}/creatures/flush`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creatures }),
    });
    if (!res.ok) throw new Error("creature flush failed");
    const body = await res.json();
    return body.updated || 0;
  };
}
```

- [ ] **Step 4: Run to verify passing**

Run from `frontend/`: `npm run test -- creatureClient`
Expected: PASS (3). Then full `npm run test` — all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/net/creatureClient.js frontend/src/games/something2/src/js/net/__tests__/creatureClient.test.js
git commit -m "feat(creatures): creature fetch/flush client (SOMET-58)"
```

---

### Task 6: Wire creatures into Game chunked mode + render

**Files:**
- Modify: `frontend/src/games/something2/src/js/systems/RenderSystem.js` (`renderChunked` draws creatures)
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (chunked mode loads/roams/flushes creatures)

**Interfaces:**
- `renderChunked(player, camera, chunkedMap, remotePlayers, localUserId, creatures = [])` — passes `{ entities: creatures }` to `buildDrawables` so creatures depth-sort with the player and draw via `drawEntity` (each creature needs `x,y,width,height` and a `color` — resolve from the tile/entity color; use a fallback like `"#c0392b"` if unknown).
- `Game` chunked mode: build a `CreatureManager` + `makeCreatureFetcher`/`makeCreatureFlusher` in `initChunked`; when `ChunkStreamer` loads a new chunk, fetch that chunk's creatures and `addCreatures`; each frame `creatureManager.update(dt, chunkedMap.loadedKeys(), chunkedMap)`; every ~3s flush `takeDirty()`.

- [ ] **Step 1: Update `renderChunked`**

In `RenderSystem.js`, change `renderChunked`'s signature to accept `creatures = []` and replace the `buildDrawables(player, { entities: [] }, remotePlayers)` call with `buildDrawables(player, { entities: creatures }, remotePlayers)`. In `drawEntity`, if a creature has no `image`, it already draws a colored rect (existing fallback) — give creatures a `color` when created in Game (Step 2) or default in `drawEntity`. No other change.

- [ ] **Step 2: Wire into `Game`**

In `Game.js`:
- imports: `CreatureManager` from `../entities/CreatureManager.js`; `makeCreatureFetcher, makeCreatureFlusher` from `../net/creatureClient.js`.
- In `initChunked`, after building the streamer, add:
  ```js
  this.creatures = new CreatureManager(chunkSize);
  this.fetchCreatures = makeCreatureFetcher(worldId, API_URL);
  this.flushCreatures = makeCreatureFlusher(worldId, API_URL);
  this._loadedCreatureChunks = new Set();
  this._flushAccum = 0;
  ```
- Wrap the streamer so loaded chunks trigger a creature fetch. Simplest: after each `await this.streamer.update(...)` / in the loop, diff `chunkedMap.loadedKeys()` against `this._loadedCreatureChunks`; for each newly-loaded chunk key, `parseKey` → `await this.fetchCreatures(cx,cy)` (or fire-and-forget with `.then`) → `this.creatures.addCreatures(list)`; record the key. Do this fire-and-forget in `update` (don't block the frame).
- In `update(dt)` chunked branch, after `player.update`, add:
  ```js
  this._syncCreatureChunks();                 // fire-and-forget fetch for new chunks
  this.creatures.update(dt, this.chunkedMap.loadedKeys(), this.chunkedMap);
  this._flushAccum += dt;
  if (this._flushAccum > 3) {                 // flush dirty positions every ~3s
    this._flushAccum = 0;
    const dirty = this.creatures.takeDirty();
    if (dirty.length) this.flushCreatures(dirty).catch(() => {});
  }
  ```
  where `_syncCreatureChunks()` compares `this.chunkedMap.loadedKeys()` to `this._loadedCreatureChunks`, fetching creatures for new keys (fire-and-forget, guarded so each key fetches once).
- In `render()` chunked branch, pass creatures: `this.renderSystem.renderChunked(this.player, this.camera, this.chunkedMap, this.remotePlayers, this.localUserId, this.creatures.all())`.
- Guard all of this behind `this.chunked` (it already is).

- [ ] **Step 3: Lint + build + full suite**

Run from `frontend/`: `npm run test && npm run lint && npm run build`
Expected: all tests green (this task adds no new unit tests — the manager/client are already tested; this is integration verified in Task 7), no new lint errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/something2/src/js/systems/RenderSystem.js frontend/src/games/something2/src/js/core/Game.js
git commit -m "feat(creatures): load/roam/flush + render creatures in chunked mode (SOMET-58)"
```

---

### Task 7: Live browser verification (creature crosses a seam as the same entity)

**Files:** none (verification).

- [ ] **Step 1: Ensure a creature type + a fresh world**

With the stack up + backend serving: create a creature entity type so spawning has a mobile type, e.g.
`curl -XPOST localhost:13101/api/entity-types -H 'Content-Type: application/json' -d '{"name":"Wolf","color":"#c0392b","walkable":true,"spawnTiles":[],"chance":0.1,"hp":12,"maxHp":12}'`
(adapt to the entity-types POST shape). Create a **fresh** world (`POST /api/worlds`, chunk_size 16) so its chunks spawn creatures on first access.

- [ ] **Step 2: Enter chunked play + observe creatures**

Run the frontend, enter the new world. Confirm creatures render (colored blocks) roaming near the player. Check `world_creatures` has rows for visited chunks.

- [ ] **Step 3: Verify seam-crossing as the same entity**

Pick a creature near a chunk boundary (or walk so a creature is near one). Observe it walk across the seam — confirm via screenshots + DB that:
- The creature's `world_creatures` row keeps the **same `id`** while its `x`/`y` cross the chunk boundary (query the row before/after; `chunkOf(x,y)` changes but the id doesn't).
- No despawn/respawn (the on-screen creature is continuous across the seam).
- Position **persists**: after the flush interval, the creature's `x,y` in `world_creatures` reflect its roamed position (not the spawn position).
- Frozen/resume: walk far away (creature's chunk leaves the 3×3 neighborhood) then return — the creature is still the same id at its (flushed) position.

- [ ] **Step 4: Record the result**

Screenshots + the `world_creatures` before/after query. If any check fails, use superpowers:systematic-debugging before claiming done.

---

## Self-Review

**Spec coverage (Phase 5):**
- "creatures carry world coords (world_id, world-pixel x,y)" → Task 1 (schema) + Task 2 (spawn in world px). ✓
- "client simulates/roams creatures within the loaded neighborhood" → Task 4 (`CreatureManager.update` roams only creatures whose chunk is in `loadedKeys`) + Task 6 (wired to the loop). ✓
- "creatures that wander out of range freeze and persist, resume when their chunk re-enters" → Task 4 (frozen when chunk not loaded) + Task 6 (flush persists positions; re-entry resumes since the creature stays in memory and its chunk re-enters `loadedKeys`). ✓
- "creatures cross seams as the same entity (no despawn/respawn)" → world-space positions + stable `id`; roaming updates `x/y` continuously across the boundary; Task 7 verifies. ✓
- "DB-backed persistence" (user decision) → `world_creatures` + spawn-on-materialization + flush. ✓
- Acceptance ("a creature placed near a seam walks across it and remains the same entity") → Task 7. ✓

**Placeholder scan:** No TBD/vague steps in the code tasks; the integration/visual tasks (6, 7) give concrete wiring + are browser-verified. ✓

**Type/name consistency:** `spawnChunkCreatures(world,cx,cy,creatureTypes)->[{type,x,y,hp,facing}]` (Task 2) consumed by the chunk route (Task 3). `world_creatures` columns match the route queries + flush. `CreatureManager(chunkSize,rng)` with `addCreatures/update(dt,loadedKeys,chunkedMap)/takeDirty` (Task 4) consumed by Game (Task 6). `makeCreatureFetcher/Flusher` (Task 5) consumed by Game (Task 6). `renderChunked(...,creatures)` (Task 6) draws via `buildDrawables({entities:creatures})` (Phase 4b). `resolveMove` reused for creature collision. ✓

**Known simplifications (noted, not blockers):**
- Creature `type` is any entity_type with `hp>0` (name≠Player); distinguishing "mobile creature" vs "static object" more precisely is a content/schema refinement.
- Creatures stay in client memory once loaded (frozen when out of range, not dropped); dropping far creatures + reloading from DB on re-entry is a memory optimization for later.
- Client-authoritative roaming + flush (no server sim); authoritative multiplayer creature migration is the deferred Phase 6.
- Spawn density is a fixed constant; tuning per biome/creature is future work.

## Out of scope (Phase 6 / future)
- Authoritative server-side creature simulation + migration across chunks (Phase 6).
- Player↔creature combat/interaction (only roaming + persistence here).
- Dropping far creatures from memory + reloading on re-entry (memory optimization).
- Distinguishing creature vs static-object entity types via schema.
