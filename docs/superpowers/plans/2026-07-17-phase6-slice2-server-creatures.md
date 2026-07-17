# Phase 6 Slice 2 — Server-Owned Creatures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move creature simulation into the Slice-1 Node authority — the server spawns, roams, AOI-broadcasts, and persists creatures for the union of connected players' neighborhoods; the client becomes render-only for creatures.

**Architecture:** Extend `backend/src/authority/`: a new `CreatureSim` (port of the client `CreatureManager` roam) composed into each `World`; `server.js` computes a per-world active chunk set from player positions, activates chunks (materialize + gated spawn + load), ticks creatures at 20 Hz, broadcasts a separate `creatures` message at ~5 Hz (per-player AOI), and flush-prunes creatures periodically. `GET /chunk` becomes the authority's read path (no longer writes `world_chunks` or spawns). The client `CreatureManager` becomes render-only with interpolation, fed by a `creatures` WS message.

**Tech Stack:** Node/CommonJS backend (Express 4, pg, ws), `node --test`. Frontend ESM (Vite/React), `vitest run`.

## Global Constraints

- Reuse `spawnChunkCreatures` and `ServerMap`/`resolveMove` — do NOT duplicate spawn or collision math.
- Server creature roam constants MUST match the client's (retired) roam: `CREATURE_SIZE = 48`, `CREATURE_SPEED = 40`, `REDIRECT_CHANCE = 0.02`, 8-dir set `[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]]`, facings `["E","SE","S","SW","W","NW","N","NE"]`.
- Active set, AOI, and prune key on a creature's **current** chunk (`chunkOf(c.x,c.y,chunkSize)`), never its spawn chunk.
- The authority is the **sole writer** of `world_chunks`; `GET /chunk` never inserts (generate-on-miss without persisting; cache-hit returns the row).
- `entity_types WHERE is_creature` and any tile/entity load use `ORDER BY id ASC` (deterministic — same reason as the Slice-1 tile-types fix).
- Player authority (Slice 1) is unchanged; the 20 Hz `state` channel is untouched. Creatures use a separate ~5 Hz `creatures` message.
- Creatures cross chunk seams as the same entity (stable id, world-space position).
- Coordinate math constant: `MAP_TILE_SIZE = 100` (world px per tile), chunk `(cx,cy)` owns global tiles `[cx*N, cx*N+N)`, `Math.floor` for negatives — identical to `frontend/.../core/worldCoords.js`.

---

### Task 1: Authority coordinate helpers — `coords.js`

**Files:**
- Create: `backend/src/authority/coords.js`
- Test: `backend/tests/authority_coords.test.js`

**Interfaces:**
- Produces: `chunkOf(worldX, worldY, chunkSize) -> {cx,cy}`, `CHUNK_KEY(cx,cy) -> "cx,cy"`, `parseKey(key) -> {cx,cy}`, `neighborhoodKeys(cx, cy, radius=1) -> string[]` (the `(2r+1)²` ring), `MAP_TILE_SIZE = 100`. CommonJS ports of `frontend/.../core/worldCoords.js` + `NeighborhoodManager.js`.

- [ ] **Step 1: Write the failing test**

`backend/tests/authority_coords.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { chunkOf, CHUNK_KEY, parseKey, neighborhoodKeys } = require('../src/authority/coords.js');

test('chunkOf maps world px to chunk coords with floor for negatives', () => {
  // chunkSize 8 → chunk spans 800 world px. (50,50)→tile(0,0)→chunk(0,0).
  assert.deepEqual(chunkOf(50, 50, 8), { cx: 0, cy: 0 });
  // (-50,-50)→tile(-1,-1)→chunk(-1,-1).
  assert.deepEqual(chunkOf(-50, -50, 8), { cx: -1, cy: -1 });
  // (850, 10)→tile(8,0)→chunk(1,0).
  assert.deepEqual(chunkOf(850, 10, 8), { cx: 1, cy: 0 });
});

test('CHUNK_KEY / parseKey round-trip incl. negatives', () => {
  assert.equal(CHUNK_KEY(-2, 3), '-2,3');
  assert.deepEqual(parseKey('-2,3'), { cx: -2, cy: 3 });
});

test('neighborhoodKeys returns the 3x3 ring around a chunk', () => {
  const keys = neighborhoodKeys(0, 0, 1).sort();
  assert.equal(keys.length, 9);
  assert.ok(keys.includes('0,0'));
  assert.ok(keys.includes('-1,-1'));
  assert.ok(keys.includes('1,1'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/authority_coords.test.js`
Expected: FAIL — `Cannot find module '../src/authority/coords.js'`.

- [ ] **Step 3: Implement `coords.js`**

`backend/src/authority/coords.js`:
```js
// World-space (px) <-> chunk coords for the authority. CommonJS port of the
// frontend core/worldCoords.js + NeighborhoodManager.js — must stay identical
// so server activation/AOI and client streaming agree on chunk ownership.
const MAP_TILE_SIZE = 100;

function chunkOf(worldX, worldY, chunkSize) {
  const gCol = Math.floor(worldX / MAP_TILE_SIZE);
  const gRow = Math.floor(worldY / MAP_TILE_SIZE);
  return { cx: Math.floor(gCol / chunkSize), cy: Math.floor(gRow / chunkSize) };
}

function CHUNK_KEY(cx, cy) { return `${cx},${cy}`; }

function parseKey(key) {
  const [cx, cy] = key.split(',').map(Number);
  return { cx, cy };
}

function neighborhoodKeys(cx, cy, radius = 1) {
  const keys = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      keys.push(CHUNK_KEY(cx + dx, cy + dy));
    }
  }
  return keys;
}

module.exports = { MAP_TILE_SIZE, chunkOf, CHUNK_KEY, parseKey, neighborhoodKeys };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/authority_coords.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/coords.js backend/tests/authority_coords.test.js
git commit -m "feat(authority): coordinate helpers (chunkOf/neighborhoodKeys)"
```

---

### Task 2: Server-side creature simulation — `creatures.js`

**Files:**
- Create: `backend/src/authority/creatures.js`
- Test: `backend/tests/authority_creatures.test.js`

**Interfaces:**
- Consumes: `resolveMove` from `./collision` (Slice 1); `chunkOf`/`CHUNK_KEY` from `./coords` (Task 1). A `map` with `isWalkable`/`speedAt`/`chunkSize` (real `ServerMap` or stub).
- Produces: `class CreatureSim`
  - `constructor(map, rng = Math.random)`.
  - `addCreatures(list)` — dedup by id; `list` items `{id,type,x,y,hp,facing,color}`.
  - `tick(dt, activeChunkKeys)` — roam creatures whose current chunk ∈ `activeChunkKeys` (Set or array); mark `dirty` on move; turn on block.
  - `getDirty() -> [{id,x,y,facing}]`; `clearDirty(ids)` — confirm-before-clear.
  - `pruneInactive(activeChunkKeys) -> droppedCount` — drop non-dirty creatures whose current chunk ∉ active set.
  - `snapshotForNeighborhood(keys) -> [{id,type,x,y,facing,hp,color}]` — creatures whose current chunk ∈ `keys`.
  - `all()` / `has(id)` / `count()`.
  - Exports `CREATURE_SIZE`, `CREATURE_SPEED`, `REDIRECT_CHANCE`.

- [ ] **Step 1: Write the failing test**

`backend/tests/authority_creatures.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');

// Stub map: everything walkable at speed 1, chunkSize 8 (chunk span = 800 px).
function stubMap(blockAll = false) {
  return { isWalkable: () => !blockAll, speedAt: () => 1, chunkSize: 8 };
}
// Deterministic rng: never redirect (>=0.02), fixed dir index 0 (east).
const noRedirect = () => 0.99;

test('addCreatures dedups by id', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10, facing: 'S', color: '#c0392b' }]);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 999, y: 999, hp: 10 }]);
  assert.equal(s.count(), 1);
  assert.equal(s.all()[0].x, 100); // second (same id) ignored
});

test('tick roams a creature whose chunk is active', () => {
  const s = new CreatureSim(stubMap(), noRedirect); // dir 0 = east
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  s.tick(0.1, new Set(['0,0'])); // (100,100)→chunk(0,0) active
  const c = s.all()[0];
  assert.ok(c.x > 100, 'moved east');
  assert.equal(c.facing, 'E');
  assert.deepEqual(s.getDirty().map((d) => d.id), ['a']);
});

test('tick freezes a creature whose chunk is NOT active', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  s.tick(0.1, new Set(['5,5'])); // (100,100)→chunk(0,0) NOT active
  assert.equal(s.all()[0].x, 100);
  assert.equal(s.getDirty().length, 0);
});

test('blocked creature turns instead of moving', () => {
  const s = new CreatureSim(stubMap(true), noRedirect); // block everything
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  s.tick(0.1, new Set(['0,0']));
  assert.equal(s.all()[0].x, 100); // didn't move
});

test('pruneInactive drops non-dirty out-of-active creatures, keeps dirty', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([
    { id: 'clean', type: 'Wolf', x: 100, y: 100, hp: 10 },
    { id: 'dirty', type: 'Wolf', x: 120, y: 120, hp: 10 },
  ]);
  s.tick(0.1, new Set(['0,0'])); // both in chunk(0,0), both become dirty
  s.clearDirty(['clean']);       // only 'clean' confirmed persisted
  const dropped = s.pruneInactive(new Set(['9,9'])); // chunk(0,0) now inactive
  assert.equal(dropped, 1);
  assert.ok(!s.has('clean'));    // clean + inactive → dropped
  assert.ok(s.has('dirty'));     // dirty → kept
});

test('snapshotForNeighborhood filters by current chunk and shape', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([
    { id: 'near', type: 'Wolf', x: 100, y: 100, hp: 10, facing: 'S', color: '#c0392b' },
    { id: 'far', type: 'Wolf', x: 5000, y: 5000, hp: 10 }, // chunk(6,6)
  ]);
  const snap = s.snapshotForNeighborhood(new Set(['0,0']));
  assert.equal(snap.length, 1);
  assert.equal(snap[0].id, 'near');
  assert.deepEqual(Object.keys(snap[0]).sort(), ['color', 'facing', 'hp', 'id', 'type', 'x', 'y']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/authority_creatures.test.js`
Expected: FAIL — `Cannot find module '../src/authority/creatures.js'`.

- [ ] **Step 3: Implement `creatures.js`**

`backend/src/authority/creatures.js`:
```js
// Server-side creature roaming — a port of the client CreatureManager roam
// logic (frontend/.../entities/CreatureManager.js), driven by the authority's
// active chunk set. Positions are world-space; active/AOI/prune key on the
// creature's CURRENT chunk (chunkOf), never its spawn chunk.
const { resolveMove } = require('./collision');
const { chunkOf, CHUNK_KEY } = require('./coords');

const DIRS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const DIR_FACING = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
const CREATURE_SIZE = 48;
const CREATURE_SPEED = 40;    // world px/s
const REDIRECT_CHANCE = 0.02;

class CreatureSim {
  constructor(map, rng = Math.random) {
    this.map = map;
    this.rng = rng;
    this.chunkSize = map.chunkSize;
    this.creatures = new Map(); // id -> creature
  }

  addCreatures(list) {
    for (const c of list) {
      if (this.creatures.has(c.id)) continue;
      const dirIdx = Math.min(DIRS.length - 1, Math.floor(this.rng() * DIRS.length));
      this.creatures.set(c.id, {
        id: c.id, type: c.type, x: c.x, y: c.y,
        width: CREATURE_SIZE, height: CREATURE_SIZE, speed: CREATURE_SPEED,
        facing: c.facing || 'S', hp: c.hp, color: c.color,
        _dir: dirIdx, dirty: false,
      });
    }
  }

  has(id) { return this.creatures.has(id); }
  count() { return this.creatures.size; }
  all() { return [...this.creatures.values()]; }

  tick(dt, activeChunkKeys) {
    const active = activeChunkKeys instanceof Set ? activeChunkKeys : new Set(activeChunkKeys);
    for (const c of this.creatures.values()) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (!active.has(CHUNK_KEY(cx, cy))) continue; // frozen (out of active set)
      if (this.rng() < REDIRECT_CHANCE) {
        c._dir = Math.min(DIRS.length - 1, Math.floor(this.rng() * DIRS.length));
      }
      const [dx, dy] = DIRS[c._dir];
      const r = resolveMove(this.map, c, dx, dy, dt);
      if (r.x !== c.x || r.y !== c.y) {
        c.x = r.x; c.y = r.y;
        c.facing = DIR_FACING[c._dir];
        c.dirty = true;
      } else {
        c._dir = (c._dir + 1) % DIRS.length; // blocked → turn
      }
    }
  }

  getDirty() {
    const out = [];
    for (const c of this.creatures.values()) {
      if (c.dirty) out.push({ id: c.id, x: c.x, y: c.y, facing: c.facing });
    }
    return out;
  }

  clearDirty(ids) {
    for (const id of ids) {
      const c = this.creatures.get(id);
      if (c) c.dirty = false;
    }
  }

  // Drop non-dirty creatures whose current chunk left the active set. Dirty
  // creatures are kept until a flush clears them (confirm-before-drop), so no
  // unpersisted position is lost. Returns the number dropped.
  pruneInactive(activeChunkKeys) {
    const active = activeChunkKeys instanceof Set ? activeChunkKeys : new Set(activeChunkKeys);
    let dropped = 0;
    for (const [id, c] of this.creatures) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (active.has(CHUNK_KEY(cx, cy))) continue;
      if (c.dirty) continue;
      this.creatures.delete(id);
      dropped++;
    }
    return dropped;
  }

  snapshotForNeighborhood(keys) {
    const set = keys instanceof Set ? keys : new Set(keys);
    const out = [];
    for (const c of this.creatures.values()) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (set.has(CHUNK_KEY(cx, cy))) {
        out.push({ id: c.id, type: c.type, x: c.x, y: c.y, facing: c.facing, hp: c.hp, color: c.color });
      }
    }
    return out;
  }
}

module.exports = { CreatureSim, CREATURE_SIZE, CREATURE_SPEED, REDIRECT_CHANCE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/authority_creatures.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/creatures.js backend/tests/authority_creatures.test.js
git commit -m "feat(authority): server-side creature simulation (CreatureSim)"
```

---

### Task 3: Wire creatures into the authority — activation, tick, broadcast, flush

**Files:**
- Modify: `backend/src/authority/world.js` (compose `CreatureSim`)
- Modify: `backend/src/authority/server.js` (creatureTypes load, active set, activation, creature tick, 5 Hz broadcast, flush-prune, teardown flush)
- Test: `backend/tests/authority_creatures_integration.test.js`

**Interfaces:**
- Consumes: `CreatureSim` (Task 2), `coords` helpers (Task 1), `spawnChunkCreatures` from `../services/mapService`, the `World`/`ServerMap` (Slice 1), the pg pool.
- Produces: server→client `{ type: "creatures", creatures: [{id,type,x,y,facing,hp,color}] }` per player at ~5 Hz. `attachAuthority` gains options `creatureBroadcastEvery` (ticks, default 4) and `creatureFlushMs` (default 3000).

**Note for the implementer:** read the current `backend/src/authority/server.js` before editing — Slice 1's `loadWorld`, tick `setInterval`, `flushTimer`, connection/close handlers, and the `loading` map are all there. The edits below ADD a creature layer alongside the existing player logic; do not change player behavior.

- [ ] **Step 1: Write the failing integration test**

`backend/tests/authority_creatures_integration.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret';

// Pool: world w1 (chunk_size 8), grass tiles, one is_creature type, one
// pre-existing creature near chunk (0,0). Chunk insert reports 0 rows (already
// materialized) so spawn is skipped and the load path is exercised directly.
// Player spawn: user 1 at world center (chunk 0,0 area); user 2 persisted far away.
function fakePool() {
  const updates = [];
  return {
    updates,
    query: async (sql, params) => {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types WHERE is_creature/i.test(sql)) return { rows: [{ name: 'Wolf', color: '#c0392b', hp: 10 }] };
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 }; // already materialized
      if (/FROM world_players WHERE/i.test(sql)) {
        const uid = params[1];
        if (uid === '2') return { rows: [{ x: 100000, y: 100000 }] }; // far away
        return { rows: [] }; // user 1 → default center
      }
      if (/FROM world_creatures/i.test(sql)) {
        // bbox load: return the wolf only for chunk (0,0) span [0,800).
        const xMin = params[1];
        if (xMin === 0) return { rows: [{ id: 'wolf1', type: 'Wolf', x: 380, y: 380, hp: 10, facing: 'S', color: '#c0392b' }] };
        return { rows: [] };
      }
      if (/UPDATE world_creatures/i.test(sql)) { updates.push(params); return { rows: [] }; }
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function token(u) { return jwt.sign({ user_id: u }, SECRET, { algorithm: 'HS256' }); }
function bootWith(pool) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 100,
    });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
}
function connect(url, uid) { return new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`); }
function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), 3000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('a joined player receives its neighborhood creatures and they roam', async () => {
  const { url, handle, server } = await bootWith(fakePool());
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  // Collect a couple of creature messages; the wolf should appear and move.
  let first = null, moved = null;
  for (let i = 0; i < 40 && !moved; i++) {
    const m = await nextMsg(ws, 'creatures');
    const w = m.creatures.find((c) => c.id === 'wolf1');
    if (w && !first) first = { ...w };
    if (w && first && (w.x !== first.x || w.y !== first.y)) moved = w;
  }
  assert.ok(first, 'wolf appeared in a creatures message');
  assert.ok(moved, 'wolf roamed over ticks');
  ws.close(); handle.close(); server.close();
});

test('AOI: a far player does not receive the wolf', async () => {
  const { url, handle, server } = await bootWith(fakePool());
  const ws = connect(url, 2); // persisted far away
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  let sawWolf = false;
  for (let i = 0; i < 10; i++) {
    const m = await nextMsg(ws, 'creatures');
    if (m.creatures.some((c) => c.id === 'wolf1')) sawWolf = true;
  }
  assert.equal(sawWolf, false, 'far player must not see the near wolf');
  ws.close(); handle.close(); server.close();
});

test('dirty creatures are flushed with UPDATEs', async () => {
  const pool = fakePool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  // Let it roam + hit the 100ms creature flush a few times.
  for (let i = 0; i < 20; i++) await nextMsg(ws, 'creatures');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(pool.updates.length > 0, 'creature positions were flushed via UPDATE');
  ws.close(); handle.close(); server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/authority_creatures_integration.test.js`
Expected: FAIL — no `creatures` message arrives (timeout) because the creature layer isn't wired yet.

- [ ] **Step 3: Compose `CreatureSim` into `World`**

In `backend/src/authority/world.js`, add the require at the top:
```js
const { CreatureSim } = require('./creatures');
```
and in the `World` constructor, after `this.players = new Map();`, add:
```js
    this.creatures = new CreatureSim(map);
```

- [ ] **Step 4: Extend `loadWorld` in `server.js` to load creature types + per-world creature state**

Add requires at the top of `backend/src/authority/server.js` (next to the existing ones):
```js
const { chunkOf, CHUNK_KEY, parseKey, neighborhoodKeys } = require('./coords');
const { spawnChunkCreatures } = require('../services/mapService');
```
In `loadWorld`, where the entry object is built, extend it to load creature types and hold creature bookkeeping. Replace the tile-types load + entry construction:
```js
    const tr = await pool.query('SELECT name, walkable, speed FROM tile_types ORDER BY id ASC');
    const tileTypes = {};
    for (const t of tr.rows) tileTypes[t.name] = { walkable: t.walkable, speed: t.speed };
    const map = new ServerMap({ seed: Number(row.seed), chunkSize: row.chunk_size, tileTypes });
    const entry = { world: new World(map), row, sockets: new Map() };
    worlds.set(worldId, entry);
    return entry;
```
with:
```js
    const tr = await pool.query('SELECT name, walkable, speed FROM tile_types ORDER BY id ASC');
    const tileTypes = {};
    for (const t of tr.rows) tileTypes[t.name] = { walkable: t.walkable, speed: t.speed };
    const cr = await pool.query('SELECT name, color, hp FROM entity_types WHERE is_creature = true ORDER BY id ASC');
    const creatureTypes = cr.rows.map((r) => ({ name: r.name, hp: r.hp, color: r.color }));
    const map = new ServerMap({ seed: Number(row.seed), chunkSize: row.chunk_size, tileTypes });
    const entry = {
      worldId, world: new World(map), row, sockets: new Map(),
      tileTypes, creatureTypes,
      activeChunks: new Set(),   // chunk keys currently in the union of player neighborhoods
      chunkLoads: new Set(),     // in-flight activation guard per chunk key
    };
    worlds.set(worldId, entry);
    return entry;
```

- [ ] **Step 5: Add activation, active-set recompute, broadcast, and flush helpers in `server.js`**

Add these functions inside `attachAuthority` (after `persist`, before `wss.on('connection', ...)`):
```js
  // Materialize + spawn (once) + load a chunk's creatures into the sim.
  async function activateChunk(entry, chunkKey) {
    if (entry.chunkLoads.has(chunkKey)) return;
    entry.chunkLoads.add(chunkKey);
    try {
      const { cx, cy } = parseKey(chunkKey);
      const N = entry.row.chunk_size;
      const grid = entry.world.map.getChunk(cx, cy); // deterministic terrain
      const ins = await pool.query(
        `INSERT INTO world_chunks (world_id, cx, cy, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (world_id, cx, cy) DO NOTHING RETURNING id`,
        [entry.worldId, cx, cy, JSON.stringify(grid)],
      );
      if (ins.rowCount > 0 && entry.creatureTypes.length) {
        const spawned = spawnChunkCreatures(
          { seed: Number(entry.row.seed), chunkSize: N, tileTypes: entry.tileTypes },
          cx, cy, entry.creatureTypes,
        );
        for (const c of spawned) {
          await pool.query(
            `INSERT INTO world_creatures (world_id, type, x, y, hp, facing) VALUES ($1,$2,$3,$4,$5,$6)`,
            [entry.worldId, c.type, c.x, c.y, c.hp, c.facing],
          );
        }
      }
      const span = N * 100;
      const rows = await pool.query(
        `SELECT wc.id, wc.type, wc.x, wc.y, wc.hp, wc.facing, et.color
         FROM world_creatures wc LEFT JOIN entity_types et ON et.name = wc.type
         WHERE wc.world_id = $1 AND wc.x >= $2 AND wc.x < $3 AND wc.y >= $4 AND wc.y < $5`,
        [entry.worldId, cx * span, cx * span + span, cy * span, cy * span + span],
      );
      entry.world.creatures.addCreatures(rows.rows);
    } catch {
      // best-effort: retried on the next recompute
    } finally {
      entry.chunkLoads.delete(chunkKey);
    }
  }

  // Recompute the active chunk set from player positions; activate newly-entered
  // chunks. Removal is handled by flushAndPrune (confirm-before-drop).
  function recomputeActive(entry) {
    const N = entry.row.chunk_size;
    const want = new Set();
    for (const p of entry.world.players.values()) {
      const { cx, cy } = chunkOf(p.x, p.y, N);
      for (const k of neighborhoodKeys(cx, cy, 1)) want.add(k);
    }
    for (const k of want) {
      if (!entry.activeChunks.has(k)) activateChunk(entry, k); // fire-and-forget (guarded)
    }
    entry.activeChunks = want;
  }

  function broadcastCreatures(entry) {
    const N = entry.row.chunk_size;
    for (const [userId, ws] of entry.sockets) {
      const p = entry.world.getPlayer(userId);
      if (!p) continue;
      const { cx, cy } = chunkOf(p.x, p.y, N);
      const keys = neighborhoodKeys(cx, cy, 1);
      send(ws, { type: 'creatures', creatures: entry.world.creatures.snapshotForNeighborhood(keys) });
    }
  }

  async function flushAndPrune(entry) {
    const dirty = entry.world.creatures.getDirty();
    if (dirty.length) {
      const ok = [];
      for (const c of dirty) {
        try {
          await pool.query(
            `UPDATE world_creatures SET x=$1, y=$2, facing=$3, updated_at=now() WHERE id=$4`,
            [c.x, c.y, c.facing, c.id],
          );
          ok.push(c.id);
        } catch { /* keep dirty → retried */ }
      }
      entry.world.creatures.clearDirty(ok);
    }
    entry.world.creatures.pruneInactive(entry.activeChunks);
  }
```

- [ ] **Step 6: Drive creatures from the tick loop + add the creature flush interval**

In the existing tick `setInterval` (the one that ticks players and broadcasts `state`), read the new options near the top of `attachAuthority` (with the other opts):
```js
  const creatureBroadcastEvery = opts.creatureBroadcastEvery || 4; // 4 ticks @50ms = ~5Hz
  const creatureFlushMs = opts.creatureFlushMs || 3000;
```
Inside the tick loop, for each non-empty world, after `entry.world.tick(dt)` and the player-state broadcast, add creature roam; and gate the recompute+broadcast on the counter. Concretely, in the loop body where each `entry` is processed, after the existing per-player `state` send block, add:
```js
      entry.world.creatures.tick(dt, entry.activeChunks);
      if (tick % creatureBroadcastEvery === 0) {
        recomputeActive(entry);
        broadcastCreatures(entry);
      }
```
(`tick` is the existing counter incremented once per interval in Slice 1.)

Add a dedicated creature flush interval next to the existing `flushTimer`:
```js
  const creatureFlushTimer = setInterval(() => {
    for (const entry of worlds.values()) {
      if (entry.world.isEmpty()) continue;
      flushAndPrune(entry).catch(() => {});
    }
  }, creatureFlushMs);
```
And in the returned `close()`, clear it alongside the others:
```js
      clearInterval(creatureFlushTimer);
```

- [ ] **Step 7: Flush creatures on world teardown**

In the `ws.on('close', ...)` handler, in the branch that deletes an empty world, flush the world's dirty creatures before dropping it. Replace:
```js
      if (entry.world.isEmpty()) worlds.delete(ws.worldId);
```
with:
```js
      if (entry.world.isEmpty()) {
        await flushAndPrune(entry).catch(() => {});
        worlds.delete(ws.worldId);
      }
```

- [ ] **Step 8: Run the integration test**

Run: `cd backend && node --test tests/authority_creatures_integration.test.js`
Expected: PASS (3 tests) and the process exits cleanly.

- [ ] **Step 9: Run the full backend suite (no regressions)**

Run: `cd backend && npm test`
Expected: all pass (Slice-1 authority tests + the new creature tests), process exits.

- [ ] **Step 10: Commit**

```bash
git add backend/src/authority/world.js backend/src/authority/server.js backend/tests/authority_creatures_integration.test.js
git commit -m "feat(authority): server-owned creature sim — activation, roam, AOI broadcast, flush"
```

---

### Task 4: Retire HTTP creature routes + make GET /chunk read-only

**Files:**
- Modify: `backend/src/index.js` (GET /chunk no-insert; remove GET /creatures + POST /creatures/flush)
- Modify: `backend/tests/worlds.test.js` (Phase-2 chunk cache assertions)
- Modify/remove: `backend/tests/creatures.test.js` or the creature-route tests (Phase-5)

**Interfaces:**
- Produces: `GET /api/worlds/:id/chunk` returns `{world_id,cx,cy,data}` — cache-hit from `world_chunks`, cache-miss generates and returns WITHOUT inserting (and without spawning). `GET /api/worlds/:id/creatures` and `POST /api/worlds/:id/creatures/flush` are gone.

- [ ] **Step 1: Update the GET /chunk cache-miss branch**

In `backend/src/index.js`, in the `GET /api/worlds/:id/chunk` handler, replace the miss branch (from the `const chunkIns = await pool.query(...)` INSERT through the creature-spawn `if (chunkIns.rowCount > 0) { ... }` block) with a plain generate-and-return — no INSERT, no spawn:
```js
    // Miss: generate terrain and return it WITHOUT persisting. The authority is
    // the sole writer of world_chunks (it materializes + spawns creatures on
    // chunk activation); terrain is deterministic so this unpersisted view
    // equals the row the authority later writes.
    const worldRes = await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
    const world = worldRes.rows[0];
    if (!world) return res.status(404).json({ error: 'world not found' });

    const tileTypes = await getTileTypesMap();
    const data = generateChunk(
      { seed: Number(world.seed), chunkSize: world.chunk_size, tileTypes },
      cx, cy,
    );

    res.json({ world_id: worldId, cx, cy, data });
```
(Leave the cache-hit branch and the `cx/cy` integer validation unchanged. `spawnChunkCreatures`/`getEntityTypesMap` may become unused in `index.js` — remove them from the require/usage only if they are no longer referenced anywhere else in the file; verify with a grep before deleting the import.)

- [ ] **Step 2: Remove the retired creature routes**

Delete the entire `app.get('/api/worlds/:id/creatures', ...)` handler and the entire `app.post('/api/worlds/:id/creatures/flush', ...)` handler from `backend/src/index.js`.

- [ ] **Step 3: Update the affected backend tests**

- In `backend/tests/worlds.test.js`, find the Phase-2 chunk tests asserting a cache-miss INSERT into `world_chunks` (e.g. an `INSERT INTO world_chunks` handler in the mock and/or an assertion that it was called). Update them so a cache miss returns the generated `data` and does NOT insert: the mock's `INSERT INTO world_chunks` handler should no longer be exercised by `GET /chunk`; assert the response shape `{world_id,cx,cy,data}` with `data` a `chunk_size`-sized grid, and (if the test tracked calls) assert no `INSERT INTO world_chunks` was issued by the request.
- In the Phase-5 creature-route tests (the file that tests `GET /creatures` / `POST /creatures/flush` and the GET /chunk creature spawn — likely `backend/tests/creatures.test.js` or within `worlds.test.js`), remove the tests for the deleted routes and for GET /chunk spawning creatures. Keep any still-valid assertions.

Run a grep first to locate them: `grep -rn "creatures/flush\|/creatures\|INSERT INTO world_chunks\|spawnChunkCreatures" backend/tests`.

- [ ] **Step 4: Run the full backend suite**

Run: `cd backend && npm test`
Expected: all pass; the retired-route tests are gone; the GET /chunk tests reflect no-insert behavior; process exits.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js backend/tests/
git commit -m "refactor(authority): GET /chunk read-only; retire HTTP creature routes"
```

---

### Task 5: `WorldAuthorityClient` — dispatch the `creatures` message

**Files:**
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js`
- Modify: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.test.js`

**Interfaces:**
- Produces: constructor accepts `onCreatures`; a `{type:'creatures'}` message is dispatched to it.

- [ ] **Step 1: Add the failing test**

Append to `WorldAuthorityClient.test.js` (inside the existing `describe`):
```js
  it('dispatches a creatures message to onCreatures', () => {
    const onCreatures = vi.fn();
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onCreatures });
    c.connect('w1');
    FakeWS.last.emit('message', { data: JSON.stringify({ type: 'creatures', creatures: [{ id: 'a', x: 1, y: 2 }] }) });
    expect(onCreatures).toHaveBeenCalledWith(expect.objectContaining({ type: 'creatures' }));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/WorldAuthorityClient.test.js`
Expected: FAIL — `onCreatures` not called (unknown message warns).

- [ ] **Step 3: Implement**

In `WorldAuthorityClient.js` constructor, add alongside the other callbacks:
```js
    this.onCreatures = onCreatures || (() => {});
```
(and add `onCreatures` to the destructured constructor params). In the message `switch`, add a case before `default`:
```js
        case 'creatures': this.onCreatures(msg); break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/WorldAuthorityClient.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/net/WorldAuthorityClient.js frontend/src/games/something2/src/js/net/WorldAuthorityClient.test.js
git commit -m "feat(authority): WorldAuthorityClient dispatches creatures message"
```

---

### Task 6: `CreatureManager` → render-only + interpolation

**Files:**
- Modify: `frontend/src/games/something2/src/js/entities/CreatureManager.js`
- Modify/replace: `frontend/src/games/something2/src/js/entities/CreatureManager.test.js` (or wherever its tests live)

**Interfaces:**
- Produces: `class CreatureManager`
  - `constructor()` (no args).
  - `applySnapshot(list)` — reconcile the set to `list`: add new (id absent), update existing by id (set render target `tx,ty` + `facing,hp,color`), remove ids absent from `list`.
  - `interpolate(dt)` — lerp each creature `x,y` toward `tx,ty`.
  - `all()` / `has(id)` / `count()`.
  - Removed: roam `update`, `getDirty/clearDirty/takeDirty`, `pruneOutOfRange`, `_dir`, the `resolveMove`/`worldCoords` imports.

- [ ] **Step 1: Write the failing test**

Replace the contents of the CreatureManager test file with render-only tests:
```js
import { describe, it, expect } from 'vitest';
import { CreatureManager } from './CreatureManager.js';

describe('CreatureManager (render-only)', () => {
  it('applySnapshot adds, updates, and removes by id', () => {
    const m = new CreatureManager();
    m.applySnapshot([{ id: 'a', type: 'Wolf', x: 10, y: 10, facing: 'S', hp: 10, color: '#c0392b' }]);
    expect(m.count()).toBe(1);
    // update existing 'a' target + add 'b'
    m.applySnapshot([
      { id: 'a', type: 'Wolf', x: 20, y: 10, facing: 'E', hp: 9, color: '#c0392b' },
      { id: 'b', type: 'Wolf', x: 50, y: 50, facing: 'S', hp: 10, color: '#c0392b' },
    ]);
    expect(m.count()).toBe(2);
    const a = m.all().find((c) => c.id === 'a');
    expect(a.tx).toBe(20);        // new target
    expect(a.facing).toBe('E');
    // 'a' removed from snapshot → dropped
    m.applySnapshot([{ id: 'b', type: 'Wolf', x: 50, y: 50, facing: 'S', hp: 10, color: '#c0392b' }]);
    expect(m.has('a')).toBe(false);
    expect(m.count()).toBe(1);
  });

  it('interpolate moves x,y toward the target', () => {
    const m = new CreatureManager();
    m.applySnapshot([{ id: 'a', type: 'Wolf', x: 0, y: 0, facing: 'S', hp: 10, color: '#000' }]);
    m.applySnapshot([{ id: 'a', type: 'Wolf', x: 100, y: 0, facing: 'E', hp: 10, color: '#000' }]);
    const a = m.all()[0];
    expect(a.x).toBe(0);   // not yet interpolated
    m.interpolate(0.05);
    expect(a.x).toBeGreaterThan(0);
    expect(a.x).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/entities/CreatureManager.test.js`
Expected: FAIL — `applySnapshot`/`interpolate` not defined (or constructor arity).

- [ ] **Step 3: Rewrite `CreatureManager.js` as render-only**

Replace the file contents:
```js
// Render-only creature store for the chunked world. The server (authority) owns
// creature simulation and sends a per-neighborhood snapshot ~5Hz over the
// `creatures` WS message; this class reconciles the rendered set to each
// snapshot and interpolates positions toward the latest target for smoothness.
const CREATURE_SIZE = 48;
const INTERP_RATE = 12; // higher = snappier; ~reaches target within a couple frames

export class CreatureManager {
  constructor() {
    this.creatures = new Map(); // id -> creature
  }

  has(id) { return this.creatures.has(id); }
  count() { return this.creatures.size; }
  all() { return [...this.creatures.values()]; }

  // Reconcile the rendered set to the snapshot (the full current neighborhood).
  applySnapshot(list) {
    const seen = new Set();
    for (const c of list) {
      seen.add(c.id);
      const ex = this.creatures.get(c.id);
      if (ex) {
        ex.tx = c.x; ex.ty = c.y;
        ex.facing = c.facing; ex.hp = c.hp;
        if (c.color) ex.color = c.color;
      } else {
        this.creatures.set(c.id, {
          id: c.id, type: c.type,
          x: c.x, y: c.y, tx: c.x, ty: c.y,
          width: CREATURE_SIZE, height: CREATURE_SIZE,
          facing: c.facing || 'S', hp: c.hp, color: c.color,
        });
      }
    }
    for (const id of [...this.creatures.keys()]) {
      if (!seen.has(id)) this.creatures.delete(id);
    }
  }

  // Lerp each creature toward its latest target so 5Hz snapshots render smoothly.
  interpolate(dt) {
    const k = Math.min(1, dt * INTERP_RATE);
    for (const c of this.creatures.values()) {
      c.x += (c.tx - c.x) * k;
      c.y += (c.ty - c.y) * k;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/entities/CreatureManager.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/entities/CreatureManager.js frontend/src/games/something2/src/js/entities/CreatureManager.test.js
git commit -m "refactor(creatures): CreatureManager render-only + interpolation"
```

---

### Task 7: Wire creatures into Game; retire the creature HTTP client

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js`
- Remove: `frontend/src/games/something2/src/js/net/creatureClient.js`

**Interfaces:**
- Consumes: `WorldAuthorityClient` `onCreatures` (Task 5), `CreatureManager.applySnapshot/interpolate` (Task 6).
- Produces: chunked mode where creatures come from the server `creatures` message and render-interpolate; no client roam/flush/fetch.

**Note:** read the current `Game.js` `initChunked` (creature setup ~lines 169-173) and the chunked `update` branch (~lines 230-255) and `_syncCreatureChunks` before editing.

- [ ] **Step 1: Simplify creature setup in `initChunked`**

In `Game.js` `initChunked`, replace the creature-fetch/flush setup:
```js
        this.creatures = new CreatureManager(chunkSize);
        this.fetchCreatures = makeCreatureFetcher(worldId, API_URL);
        this.flushCreatures = makeCreatureFlusher(worldId, API_URL);
        this._loadedCreatureChunks = new Set();
        this._flushAccum = 0;
```
with:
```js
        this.creatures = new CreatureManager();
```
And in the `WorldAuthorityClient` options object (added in Slice 1), add the creatures callback:
```js
        onCreatures: (msg) => this.creatures.applySnapshot(msg.creatures),
```

- [ ] **Step 2: Replace the chunked `update` creature logic**

In the chunked branch of `update(dt)`, remove `this._syncCreatureChunks();`, the `this.creatures.update(dt, ...)` roam call, and the entire `_flushAccum`/`getDirty`/`flushCreatures`/`pruneOutOfRange` block. In their place, advance interpolation:
```js
            this.creatures.interpolate(dt);
```
(Keep the player prediction + input-send block and `this.camera.update(this.player)` from Slice 1 unchanged. The `streamer.update(cx, cy)` terrain streaming stays.)

- [ ] **Step 3: Remove the now-dead `_syncCreatureChunks` method + imports**

Delete the `_syncCreatureChunks()` method from `Game.js`. Remove the import of `makeCreatureFetcher`/`makeCreatureFlusher` (from `net/creatureClient.js`) and any remaining references to `this.fetchCreatures`/`this.flushCreatures`/`this._loadedCreatureChunks`/`this._flushAccum`. Also remove the `parseKey` import if it was only used by `_syncCreatureChunks` (grep to confirm before removing).

- [ ] **Step 4: Delete the retired creature HTTP client**

```bash
git rm frontend/src/games/something2/src/js/net/creatureClient.js
```
Grep to confirm no remaining importers: `grep -rn "creatureClient\|makeCreatureFetcher\|makeCreatureFlusher" frontend/src`. If the file had its own test, remove it too.

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: all pass (removed creatureClient/roam tests gone; CreatureManager render-only + WorldAuthorityClient creatures tests pass). No unresolved imports.

- [ ] **Step 6: Production build**

Run: `cd frontend && npm run build`
Expected: build succeeds (no dangling imports of `creatureClient`).

- [ ] **Step 7: Live browser verification**

With the backend restarted (so the authority runs the creature sim; ensure the backend container has the code + `ws`) and a world created:
1. Enter the chunked world; confirm creatures render and **roam on their own** (server-driven), moving between frames while the player stands still.
2. Open a second tab (second player) in the same world near the first; confirm both see the same creatures moving.
3. Walk across a chunk seam; confirm creatures stream in/out of the neighborhood (AOI) and a creature crossing the seam keeps moving as the same entity.
4. Console clean (no `GET /creatures` calls, no flush POSTs, no errors).
Record observations in the task report. If two-tab runtime isn't available, note it and rely on the automated suites + single-client check.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js
git commit -m "feat(creatures): server-driven creatures in chunked mode; retire creature HTTP client"
```

---

## Self-Review

**1. Spec coverage:**
- Active set = union of players' neighborhoods → Task 3 `recomputeActive`. ✓
- Activate (materialize + gated spawn + load), deactivate via flush-prune → Task 3 `activateChunk`/`flushAndPrune`. ✓
- `CreatureSim` port with matching constants → Task 2 (+Global Constraints). ✓
- Separate `creatures` message at ~5 Hz, per-player AOI → Task 3 `broadcastCreatures` + `creatureBroadcastEvery`. ✓
- Authority sole `world_chunks` writer; `GET /chunk` no insert; routes retired → Task 4. ✓
- Client render-only + interpolation → Task 6. ✓
- `WorldAuthorityClient` `onCreatures` → Task 5. ✓
- Game wiring + retire `creatureClient.js` → Task 7. ✓
- Persistence via UPDATE + confirm-before-clear; teardown flush → Task 3 `flushAndPrune` + Step 7. ✓
- `entity_types WHERE is_creature ORDER BY id ASC` → Task 3 Step 4. ✓
- Current-chunk keying for active/AOI/prune → Task 2 (chunkOf everywhere). ✓

**2. Placeholder scan:** No TBD/TODO; every code step has full code. Task 4 Step 3 references locating existing tests by grep (their exact text isn't reproduced because it's existing code to edit, not new code to write) — the edit intent + assertions are specified. ✓

**3. Type consistency:**
- `CreatureSim(map, rng)` with `map.chunkSize` — `ServerMap` exposes `chunkSize` (Slice 1). ✓
- `snapshotForNeighborhood(keys)` returns `{id,type,x,y,facing,hp,color}` — matches the `creatures` message and `CreatureManager.applySnapshot` consumption. ✓
- `getDirty()`→`[{id,x,y,facing}]`, `clearDirty(ids)`, `pruneInactive(keys)` used consistently in Task 3 `flushAndPrune`. ✓
- `neighborhoodKeys`/`chunkOf`/`parseKey`/`CHUNK_KEY` signatures identical between Task 1 and their Task 3 uses. ✓
- `activateChunk` uses `entry.world.map.getChunk(cx,cy)` — `ServerMap.getChunk` exists (Slice 1). ✓

**Note for the executor:** Task 3 is the largest task (creature server integration). Its acceptance is the ws integration test (`creatures` message appears, roams, AOI-excludes, flush UPDATEs) plus a green full suite. Read the current `server.js` before editing — the edits compose alongside Slice-1 player logic and must not alter it.

---
