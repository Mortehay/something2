# Phase 6 Slice 1 — Node Authority + Authoritative Players Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node WebSocket authority (hosted inside the backend process) that owns authoritative player movement for a chunked world — clients send movement input, the server integrates it against server-side collision at a 20 Hz tick and broadcasts state; players in the same world see each other, and the local player is client-predicted and server-reconciled.

**Architecture:** New `backend/src/authority/` module set: `collision.js` (CommonJS port of the frontend `resolveMove` + a `ServerMap` that lazily generates chunks via `mapService.generateChunk`), `world.js` (per-world player simulation), `server.js` (`ws` transport + tick loop + persistence). The authority `require`s `mapService` directly and reuses the existing pg pool + `JWT_SECRET`. Frontend gains `WorldAuthorityClient` (WS client) and a pure `reconcile` module; `Game` chunked mode is rewired to predict + send input + reconcile. The Go engine stays frozen.

**Tech Stack:** Node/CommonJS backend (Express 4, pg, jsonwebtoken, new dep `ws`), tests via `node --test`. Frontend ESM (Vite/React), tests via `vitest run`. Postgres via node-pg-migrate.

## Global Constraints

- Reuse `mapService.generateChunk` / `worldConfig` for chunk generation — do NOT duplicate world-gen math in the authority.
- Server collision math must match the frontend `resolveMove` (`frontend/src/games/something2/src/js/systems/movement.js`) and `worldCoords` numerics exactly: `MAP_TILE_SIZE = 100`, `Math.floor` chunk/local ownership, per-axis independent stepping at the moved center, diagonal normalized by `Math.hypot`.
- Authoritative tick: 20 Hz → `TICK_MS = 50`. Client input send cadence: ~20 Hz (accumulate dt, emit on ≥ `TICK_MS`).
- Player actor dims/speed match the client: `width = 64`, `height = 64`, effective `speed = 100 * 2 = 200` (Player `this.speed=100`, `this.speedMultiplier=2`).
- JWT verification uses the existing `JWT_SECRET` (HS256), claim `user_id` — same tokens `/api/dev-token` mints. No new auth system.
- The Go engine (`engine/`) stays frozen and untouched.
- The authority must NOT start when `src/index.js` is imported by tests — only under the existing `require.main === module` block.
- Clients send input intent only (`dx,dy` clamped to `[-1,1]`); the server never trusts client-sent positions. Anti-cheat is structural.
- Migration timestamps must be unique and after the latest existing `1714440014000`. Use `1714440015000`.
- Creatures remain client-side and unchanged in this slice (server-owned creatures = Slice 2).

---

### Task 1: `world_players` persistence table (migration)

**Files:**
- Create: `backend/migrations/1714440015000_create_world_players.js`
- Test: `backend/tests/migration_world_players.test.js`

**Interfaces:**
- Produces: table `world_players(world_id uuid FK→worlds CASCADE, user_id text, x real, y real, updated_at timestamptz, PRIMARY KEY(world_id,user_id))` consumed by Task 4 (load-on-join, upsert-on-flush/disconnect).

- [ ] **Step 1: Write the failing test**

`backend/tests/migration_world_players.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');

// Records the DDL calls node-pg-migrate would make, so we can assert the
// migration shape without a live database.
function fakePgm() {
  const calls = { createTable: [], addConstraint: [] };
  return {
    calls,
    createTable: (name, cols, opts) => calls.createTable.push({ name, cols, opts }),
    addConstraint: (name, cn, opts) => calls.addConstraint.push({ name, cn, opts }),
    dropTable: () => {},
    sql: () => {},
  };
}

test('world_players migration creates the table with the expected columns', () => {
  const mig = require('../migrations/1714440015000_create_world_players.js');
  assert.equal(typeof mig.up, 'function');
  assert.equal(typeof mig.down, 'function');

  const pgm = fakePgm();
  mig.up(pgm);

  assert.equal(pgm.calls.createTable.length, 1);
  const t = pgm.calls.createTable[0];
  assert.equal(t.name, 'world_players');
  for (const col of ['world_id', 'user_id', 'x', 'y', 'updated_at']) {
    assert.ok(t.cols[col], `missing column ${col}`);
  }
  // Composite PK on (world_id, user_id).
  assert.deepEqual(t.opts.constraints.primaryKey, ['world_id', 'user_id']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/migration_world_players.test.js`
Expected: FAIL — `Cannot find module '../migrations/1714440015000_create_world_players.js'`.

- [ ] **Step 3: Write the migration**

`backend/migrations/1714440015000_create_world_players.js`:
```js
exports.up = (pgm) => {
  pgm.createTable('world_players', {
    world_id: {
      type: 'uuid',
      notNull: true,
      references: 'worlds',
      onDelete: 'CASCADE',
    },
    user_id: { type: 'text', notNull: true },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  }, {
    constraints: { primaryKey: ['world_id', 'user_id'] },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('world_players');
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/migration_world_players.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Apply the migration live (verification)**

Run: `cd backend && npm run migrate up`
Expected: `> Migrating files: > 1714440015000_create_world_players ... Migrations complete!` (or the project's equivalent success line). If the DB is unavailable in this environment, note it and rely on the unit test.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/1714440015000_create_world_players.js backend/tests/migration_world_players.test.js
git commit -m "feat(authority): world_players persistence table"
```

---

### Task 2: Server collision — `resolveMove` port + `ServerMap`

**Files:**
- Create: `backend/src/authority/collision.js`
- Test: `backend/tests/authority_collision.test.js`

**Interfaces:**
- Consumes: `mapService.generateChunk(world, cx, cy)` from `backend/src/services/mapService.js` (returns `grid[localRow][localCol]` of tile-name strings; `world = {seed, chunkSize, tileTypes}`).
- Produces:
  - `resolveMove(map, actor, dirX, dirY, dt) -> {x, y, moved}` — pure; `map` exposes `isWalkable(wx,wy)` and `speedAt(wx,wy)`; `actor = {x,y,width,height,speed}`.
  - `class ServerMap` with `constructor(world)` (`world = {seed, chunkSize, tileTypes}`), `getTileAt(wx,wy) -> string|null`, `isWalkable(wx,wy) -> bool`, `speedAt(wx,wy) -> number`, `getChunk(cx,cy) -> string[][]`.
  - `const MAP_TILE_SIZE = 100` (exported).

- [ ] **Step 1: Write the failing test**

`backend/tests/authority_collision.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { resolveMove, ServerMap, MAP_TILE_SIZE } = require('../src/authority/collision.js');

// Stub map: everything walkable at speed 1 unless (wx,wy) falls in a blocked band.
function stubMap({ blockX = null } = {}) {
  return {
    isWalkable: (wx) => (blockX === null ? true : wx < blockX),
    speedAt: () => 1,
  };
}

test('resolveMove is a no-op on zero input', () => {
  const r = resolveMove(stubMap(), { x: 10, y: 20, width: 64, height: 64, speed: 200 }, 0, 0, 0.05);
  assert.deepEqual(r, { x: 10, y: 20, moved: false });
});

test('resolveMove normalizes diagonals (not faster than an axis)', () => {
  const actor = { x: 0, y: 0, width: 0, height: 0, speed: 100 };
  const diag = resolveMove(stubMap(), actor, 1, 1, 1);
  // step = (1/sqrt2)*100*1 ≈ 70.71 on each axis
  assert.ok(Math.abs(diag.x - 70.7106) < 1e-3);
  assert.ok(Math.abs(diag.y - 70.7106) < 1e-3);
});

test('resolveMove blocks the X axis at an unwalkable tile but allows Y', () => {
  // center starts at (95,50); moving +x would cross into blocked band at wx>=100.
  const actor = { x: 63, y: 18, width: 64, height: 64, speed: 200 };
  const r = resolveMove(stubMap({ blockX: 100 }), actor, 1, 1, 0.5);
  assert.equal(r.x, 63);        // x blocked
  assert.ok(r.y > 18);          // y moved
  assert.equal(r.moved, true);
});

test('ServerMap resolves tiles, walkability and speed incl. negative coords', () => {
  const world = {
    seed: 7,
    chunkSize: 8,
    tileTypes: { grass: { walkable: true, speed: 1 }, water: { walkable: false, speed: 1 } },
  };
  const map = new ServerMap(world);
  // A generated tile name is one of the tileTypes keys.
  const name = map.getTileAt(-50, -50);
  assert.ok(name === 'grass' || name === 'water', `unexpected tile ${name}`);
  // Walkability follows the tile def.
  const walk = map.isWalkable(-50, -50);
  assert.equal(walk, world.tileTypes[name].walkable !== false);
  // Default speed is 1.
  assert.equal(map.speedAt(-50, -50), 1);
  // Chunk ownership: (-50,-50) world px → global tile (-1,-1) → chunk (-1,-1).
  const g = map.getChunk(-1, -1);
  assert.equal(g.length, 8);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/authority_collision.test.js`
Expected: FAIL — `Cannot find module '../src/authority/collision.js'`.

- [ ] **Step 3: Implement `collision.js`**

`backend/src/authority/collision.js`:
```js
// Server-side movement/collision for the authoritative simulation. The
// resolveMove algorithm is a byte-for-byte port of the frontend
// systems/movement.js so client prediction and server authority converge.
// ServerMap lazily generates chunks via mapService.generateChunk — the server
// has the whole world, so (unlike the client's streaming ChunkedMap) an
// unknown tile only happens on a malformed grid, and is treated as blocked.
const { generateChunk } = require('../services/mapService');

const MAP_TILE_SIZE = 100; // must match frontend core/constants.js

function resolveMove(map, actor, dirX, dirY, dt) {
  if (dirX === 0 && dirY === 0) return { x: actor.x, y: actor.y, moved: false };

  const len = Math.hypot(dirX, dirY);
  const nx = dirX / len;
  const ny = dirY / len;

  const cx = actor.x + actor.width / 2;
  const cy = actor.y + actor.height / 2;

  const tileSpeed = map.speedAt(cx, cy);
  const stepX = nx * actor.speed * dt * tileSpeed;
  const stepY = ny * actor.speed * dt * tileSpeed;

  let x = actor.x;
  let y = actor.y;
  let moved = false;

  if (stepX !== 0 && map.isWalkable(cx + stepX, cy)) { x += stepX; moved = true; }
  if (stepY !== 0 && map.isWalkable(cx, cy + stepY)) { y += stepY; moved = true; }

  return { x, y, moved };
}

class ServerMap {
  // world: { seed:number, chunkSize:number, tileTypes:{ [name]: {walkable, speed} } }
  constructor(world) {
    this.world = world;
    this.chunkSize = world.chunkSize;
    this.tileTypes = world.tileTypes;
    this.chunks = new Map(); // "cx,cy" -> string[][]
  }

  getChunk(cx, cy) {
    const key = `${cx},${cy}`;
    let g = this.chunks.get(key);
    if (!g) {
      g = generateChunk(this.world, cx, cy);
      this.chunks.set(key, g);
    }
    return g;
  }

  getTileAt(worldX, worldY) {
    const gCol = Math.floor(worldX / MAP_TILE_SIZE);
    const gRow = Math.floor(worldY / MAP_TILE_SIZE);
    const cx = Math.floor(gCol / this.chunkSize);
    const cy = Math.floor(gRow / this.chunkSize);
    const lc = gCol - cx * this.chunkSize;
    const lr = gRow - cy * this.chunkSize;
    const grid = this.getChunk(cx, cy);
    if (!grid || !grid[lr]) return null;
    const t = grid[lr][lc];
    return t === undefined ? null : t;
  }

  isWalkable(worldX, worldY) {
    const t = this.getTileAt(worldX, worldY);
    if (t === null) return false;
    const def = this.tileTypes[t];
    return def ? def.walkable !== false : true;
  }

  speedAt(worldX, worldY) {
    const def = this.tileTypes[this.getTileAt(worldX, worldY)];
    return def && def.speed !== undefined ? def.speed : 1;
  }
}

module.exports = { resolveMove, ServerMap, MAP_TILE_SIZE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/authority_collision.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/collision.js backend/tests/authority_collision.test.js
git commit -m "feat(authority): server-side resolveMove port + ServerMap"
```

---

### Task 3: Per-world player simulation — `world.js`

**Files:**
- Create: `backend/src/authority/world.js`
- Test: `backend/tests/authority_world.test.js`

**Interfaces:**
- Consumes: `resolveMove` from `./collision` (Task 2). A `map` object exposing `isWalkable`/`speedAt` (real `ServerMap` in production, stub in tests).
- Produces: `class World`
  - `constructor(map)` — `map` is a `ServerMap` (or stub).
  - `addPlayer(userId, spawn)` — `spawn = {x,y}`.
  - `removePlayer(userId)`.
  - `setInput(userId, seq, dx, dy)` — clamps `dx,dy` to `[-1,1]`, records latest input + pending seq.
  - `tick(dt)` — integrates every player via `resolveMove`, updates `facing`, sets each player's `ackSeq` to its pending seq.
  - `snapshot() -> { players: [{ id, x, y, facing }] }`.
  - `getPlayer(userId) -> {userId,x,y,...}|undefined`.
  - `isEmpty() -> bool`.
  - Constants `PLAYER_W=64`, `PLAYER_H=64`, `PLAYER_SPEED=200` (exported).

- [ ] **Step 1: Write the failing test**

`backend/tests/authority_world.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { World, PLAYER_SPEED } = require('../src/authority/world.js');

// Stub map: walkable unless x >= wall; speed 1.
function stubMap(wall = Infinity) {
  return { isWalkable: (wx) => wx < wall, speedAt: () => 1 };
}

test('setInput clamps dx,dy into [-1,1]', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 0, y: 0 });
  w.setInput('u1', 1, 5, -9);
  w.tick(1); // speed*1*1 = PLAYER_SPEED on x, -PLAYER_SPEED on y (after normalize)
  const p = w.getPlayer('u1');
  // Clamped to (1,-1) then normalized by hypot(1,1): step = PLAYER_SPEED/sqrt2
  assert.ok(Math.abs(p.x - PLAYER_SPEED / Math.SQRT2) < 1e-3);
  assert.ok(Math.abs(p.y + PLAYER_SPEED / Math.SQRT2) < 1e-3);
});

test('tick advances a player on open ground', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 0, y: 0 });
  w.setInput('u1', 1, 1, 0);
  w.tick(0.05);
  assert.ok(w.getPlayer('u1').x > 0);
});

test('tick blocks movement into an unwalkable tile', () => {
  const w = new World(stubMap(50)); // wall at x=50
  w.addPlayer('u1', { x: 0, y: 0 }); // center at (32,32); +x step would cross wall quickly
  w.setInput('u1', 1, 1, 0);
  w.tick(1); // large dt: step is huge, center+step >= 50 → blocked
  assert.equal(w.getPlayer('u1').x, 0);
});

test('ackSeq tracks the latest input seq; snapshot has the right shape', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 3, y: 4 });
  w.setInput('u1', 7, 0, 0);
  w.tick(0.05);
  assert.equal(w.getPlayer('u1').ackSeq, 7);
  const snap = w.snapshot();
  assert.equal(snap.players.length, 1);
  assert.deepEqual(Object.keys(snap.players[0]).sort(), ['facing', 'id', 'x', 'y']);
  assert.equal(snap.players[0].id, 'u1');
});

test('removePlayer + isEmpty', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 0, y: 0 });
  assert.equal(w.isEmpty(), false);
  w.removePlayer('u1');
  assert.equal(w.isEmpty(), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/authority_world.test.js`
Expected: FAIL — `Cannot find module '../src/authority/world.js'`.

- [ ] **Step 3: Implement `world.js`**

`backend/src/authority/world.js`:
```js
const { resolveMove } = require('./collision');

const PLAYER_W = 64;
const PLAYER_H = 64;
const PLAYER_SPEED = 200; // client: this.speed(100) * speedMultiplier(2)

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// 8-way facing string from an input vector; null when idle (keep last facing).
function facingFromInput(dx, dy) {
  if (dx === 0 && dy === 0) return null;
  const v = dy < 0 ? 'n' : dy > 0 ? 's' : '';
  const h = dx < 0 ? 'w' : dx > 0 ? 'e' : '';
  return (v + h) || null;
}

class World {
  constructor(map) {
    this.map = map;
    this.players = new Map(); // userId -> state
  }

  addPlayer(userId, spawn) {
    this.players.set(userId, {
      userId,
      x: spawn.x,
      y: spawn.y,
      width: PLAYER_W,
      height: PLAYER_H,
      speed: PLAYER_SPEED,
      facing: 's',
      input: { dx: 0, dy: 0 },
      pendingSeq: 0,
      ackSeq: 0,
    });
  }

  removePlayer(userId) { this.players.delete(userId); }
  getPlayer(userId) { return this.players.get(userId); }
  isEmpty() { return this.players.size === 0; }

  setInput(userId, seq, dx, dy) {
    const p = this.players.get(userId);
    if (!p) return;
    p.input = { dx: clamp(dx, -1, 1), dy: clamp(dy, -1, 1) };
    p.pendingSeq = seq;
  }

  tick(dt) {
    for (const p of this.players.values()) {
      const r = resolveMove(this.map, p, p.input.dx, p.input.dy, dt);
      p.x = r.x;
      p.y = r.y;
      const f = facingFromInput(p.input.dx, p.input.dy);
      if (f) p.facing = f;
      p.ackSeq = p.pendingSeq;
    }
  }

  snapshot() {
    return {
      players: [...this.players.values()].map((p) => ({
        id: p.userId, x: p.x, y: p.y, facing: p.facing,
      })),
    };
  }
}

module.exports = { World, PLAYER_W, PLAYER_H, PLAYER_SPEED };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/authority_world.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/world.js backend/tests/authority_world.test.js
git commit -m "feat(authority): per-world player simulation"
```

---

### Task 4: WebSocket transport + tick loop — `server.js`

**Files:**
- Create: `backend/src/authority/server.js`
- Modify: `backend/package.json` (add `ws` dependency)
- Test: `backend/tests/authority_server.test.js`

**Interfaces:**
- Consumes: `World` (Task 3), `ServerMap` (Task 2), `jsonwebtoken`, `ws`. A pg-pool-like object (`query(sql, params) -> {rows}`) and an `httpServer` (from `http.Server` / `app.listen`).
- Produces: `attachAuthority(httpServer, pool, opts) -> { close() }` where `opts = { jwtSecret, path='/authority', tickMs=50, flushMs=30000 }`. Wires `httpServer.on('upgrade')`, runs the tick loop, returns a handle whose `close()` stops the interval + closes the ws server (used by tests).
- Wire protocol (see spec): in `{join,input,ping}`, out `{joined,state,pong,error}`.

**Notes for the implementer:**
- Use `new WebSocketServer({ noServer: true })` and handle `httpServer.on('upgrade')` yourself so Express HTTP routes still work. Only handle upgrades whose URL pathname equals `opts.path`; otherwise `socket.destroy()`.
- Parse `token` from the upgrade request URL query; `jwt.verify(token, jwtSecret)`; take `String(payload.user_id)` as the userId. On any failure, `socket.destroy()` (no connection).
- Per-world lazy state: `worlds: Map<world_id, { world, sockets: Map<userId, ws> }>`. Build a `World` on first join for that world_id, loading the world row + tile types once.
- Load spawn: `SELECT x,y FROM world_players WHERE world_id=$1 AND user_id=$2`; if no row, spawn at chunk (0,0) center = `chunkSize * 100 / 2` for both x and y.
- Tick: single `setInterval(tickMs)`. For each world with ≥1 player: `world.tick(tickMs/1000)`; build `snapshot()`; send each socket `{type:'state', tick, ackSeq: <that player's ackSeq>, players: snapshot.players}`.
- Persist on disconnect and on a `setInterval(flushMs)`: upsert each connected player. Use `ON CONFLICT (world_id,user_id) DO UPDATE`.
- Guard every `ws.send` with a readyState check (send only when `ws.readyState === ws.OPEN`).

- [ ] **Step 1: Add the `ws` dependency**

Run: `cd backend && npm install ws@^8`
Expected: `ws` appears under `dependencies` in `backend/package.json`. (In Docker, also run `npm install` inside the backend container or rebuild so the module is present at runtime.)

- [ ] **Step 2: Write the failing test**

`backend/tests/authority_server.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret';

// Minimal pool: one world row, a couple of walkable tile types, no persisted
// player rows, and a no-op upsert.
function fakePool() {
  return {
    query: async (sql) => {
      if (/FROM worlds WHERE id/i.test(sql)) {
        return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      }
      if (/FROM tile_types/i.test(sql)) {
        return { rows: [
          { name: 'grass', walkable: true, speed: 1 },
          { name: 'path', walkable: true, speed: 1 },
        ] };
      }
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function token(userId) {
  return jwt.sign({ user_id: userId }, SECRET, { algorithm: 'HS256' });
}

// Boot an http server with the authority attached; returns {url, handle, server}.
function boot() {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, fakePool(), { jwtSecret: SECRET, tickMs: 20 });
    server.listen(0, () => {
      const port = server.address().port;
      resolve({ url: `ws://127.0.0.1:${port}/authority`, handle, server });
    });
  });
}

function connect(url, uid) {
  return new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`);
}

// Await the next JSON message of a given type.
function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 2000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('rejects an upgrade with no token', async () => {
  const { url, handle, server } = await boot();
  const bare = url; // no ?token
  const ws = new WebSocket(bare);
  const closed = await new Promise((res) => {
    ws.on('error', () => res('error'));
    ws.on('close', () => res('close'));
  });
  assert.ok(closed === 'error' || closed === 'close');
  handle.close(); server.close();
});

test('join → joined with a spawn; input → state includes the moved player', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((res) => ws.on('open', res));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  assert.equal(joined.type, 'joined');
  assert.equal(joined.user_id, '1');
  assert.ok(typeof joined.spawn.x === 'number' && typeof joined.spawn.y === 'number');

  ws.send(JSON.stringify({ type: 'input', seq: 1, dx: 1, dy: 0 }));
  // Wait for a state where our player has moved east of spawn.
  const startX = joined.spawn.x;
  let moved = null;
  for (let i = 0; i < 20 && !moved; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.x > startX) moved = me;
  }
  assert.ok(moved, 'player should move east after input');
  handle.close(); server.close();
});

test('two clients in one world see each other', async () => {
  const { url, handle, server } = await boot();
  const a = connect(url, 1);
  const b = connect(url, 2);
  await Promise.all([
    new Promise((r) => a.on('open', r)),
    new Promise((r) => b.on('open', r)),
  ]);
  a.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  b.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(a, 'joined');
  await nextMsg(b, 'joined');
  // a's state should eventually list both player ids.
  let both = false;
  for (let i = 0; i < 20 && !both; i++) {
    const s = await nextMsg(a, 'state');
    const ids = s.players.map((p) => p.id).sort();
    if (ids.includes('1') && ids.includes('2')) both = true;
  }
  assert.ok(both, "a should see both players");
  handle.close(); server.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && node --test tests/authority_server.test.js`
Expected: FAIL — `Cannot find module '../src/authority/server.js'`.

- [ ] **Step 4: Implement `server.js`**

`backend/src/authority/server.js`:
```js
const { URL } = require('node:url');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { ServerMap } = require('./collision');
const { World } = require('./world');

const MAP_TILE_SIZE = 100;

// Attach the authoritative WebSocket simulation to an existing http server.
// Returns { close() } so callers/tests can tear it down.
function attachAuthority(httpServer, pool, opts = {}) {
  const jwtSecret = opts.jwtSecret;
  const path = opts.path || '/authority';
  const tickMs = opts.tickMs || 50;
  const flushMs = opts.flushMs || 30000;

  const wss = new WebSocketServer({ noServer: true });
  const worlds = new Map(); // world_id -> { world, row, sockets: Map<userId, ws> }

  httpServer.on('upgrade', (req, socket, head) => {
    let userId;
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== path) { socket.destroy(); return; }
      const token = u.searchParams.get('token');
      const payload = jwt.verify(token, jwtSecret);
      userId = String(payload.user_id);
    } catch {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = userId;
      ws.worldId = null;
      wss.emit('connection', ws, req);
    });
  });

  async function loadWorld(worldId) {
    let entry = worlds.get(worldId);
    if (entry) return entry;
    const wr = await pool.query('SELECT id, seed, chunk_size FROM worlds WHERE id = $1', [worldId]);
    if (wr.rows.length === 0) return null;
    const row = wr.rows[0];
    const tr = await pool.query('SELECT name, walkable, speed FROM tile_types');
    const tileTypes = {};
    for (const t of tr.rows) tileTypes[t.name] = { walkable: t.walkable, speed: t.speed };
    const map = new ServerMap({ seed: Number(row.seed), chunkSize: row.chunk_size, tileTypes });
    entry = { world: new World(map), row, sockets: new Map() };
    worlds.set(worldId, entry);
    return entry;
  }

  async function loadSpawn(worldId, userId, chunkSize) {
    const r = await pool.query(
      'SELECT x, y FROM world_players WHERE world_id = $1 AND user_id = $2',
      [worldId, userId]
    );
    if (r.rows.length) return { x: r.rows[0].x, y: r.rows[0].y };
    const center = (chunkSize * MAP_TILE_SIZE) / 2;
    return { x: center, y: center };
  }

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  async function persist(worldId, userId, p) {
    await pool.query(
      `INSERT INTO world_players (world_id, user_id, x, y, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (world_id, user_id) DO UPDATE SET x = $3, y = $4, updated_at = now()`,
      [worldId, userId, p.x, p.y]
    );
  }

  wss.on('connection', (ws) => {
    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'join') {
        const entry = await loadWorld(msg.world_id).catch(() => null);
        if (!entry) { send(ws, { type: 'error', message: 'unknown world' }); return; }
        const spawn = await loadSpawn(msg.world_id, ws.userId, entry.row.chunk_size);
        ws.worldId = msg.world_id;
        entry.world.addPlayer(ws.userId, spawn);
        entry.sockets.set(ws.userId, ws);
        send(ws, { type: 'joined', user_id: ws.userId, spawn, tickRate: 1000 / tickMs });
        return;
      }

      if (msg.type === 'input') {
        const entry = worlds.get(ws.worldId);
        if (entry) entry.world.setInput(ws.userId, msg.seq, msg.dx, msg.dy);
        return;
      }

      if (msg.type === 'ping') { send(ws, { type: 'pong' }); return; }
    });

    ws.on('close', async () => {
      const entry = worlds.get(ws.worldId);
      if (!entry) return;
      const p = entry.world.getPlayer(ws.userId);
      if (p) { try { await persist(ws.worldId, ws.userId, p); } catch { /* best-effort */ } }
      entry.world.removePlayer(ws.userId);
      entry.sockets.delete(ws.userId);
      if (entry.world.isEmpty()) worlds.delete(ws.worldId);
    });
  });

  let tick = 0;
  const tickTimer = setInterval(() => {
    tick++;
    const dt = tickMs / 1000;
    for (const entry of worlds.values()) {
      if (entry.world.isEmpty()) continue;
      entry.world.tick(dt);
      const snap = entry.world.snapshot();
      for (const [userId, ws] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        send(ws, { type: 'state', tick, ackSeq: p ? p.ackSeq : 0, players: snap.players });
      }
    }
  }, tickMs);

  const flushTimer = setInterval(() => {
    for (const [worldId, entry] of worlds) {
      for (const [userId] of entry.sockets) {
        const p = entry.world.getPlayer(userId);
        if (p) persist(worldId, userId, p).catch(() => {});
      }
    }
  }, flushMs);

  return {
    close() {
      clearInterval(tickTimer);
      clearInterval(flushTimer);
      wss.close();
    },
  };
}

module.exports = { attachAuthority };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && node --test tests/authority_server.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full backend suite (no regressions)**

Run: `cd backend && npm test`
Expected: all tests pass (existing 60 + the new authority tests).

- [ ] **Step 7: Commit**

```bash
git add backend/src/authority/server.js backend/tests/authority_server.test.js backend/package.json backend/package-lock.json
git commit -m "feat(authority): ws transport, tick loop, player persistence"
```

---

### Task 5: Wire the authority into the backend process

**Files:**
- Modify: `backend/src/index.js` (the `require.main === module` server-start block near the bottom, and add a `require`)

**Interfaces:**
- Consumes: `attachAuthority` (Task 4), the module-level `pool`, `process.env.JWT_SECRET`.
- Produces: a live `/authority` WebSocket endpoint on the same port as the HTTP API when the backend runs as a process. No new exports; tests importing `app` still do NOT start it (guarded by `require.main === module`).

- [ ] **Step 1: Add the require near the other requires at the top of `index.js`**

Find the top requires (e.g. after `const jwt = require('jsonwebtoken');`) and add:
```js
const { attachAuthority } = require('./authority/server');
```

- [ ] **Step 2: Capture the server and attach the authority**

Replace the existing start block:
```js
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Backend server running on port ${port}`);
  });
}
```
with:
```js
if (require.main === module) {
  const server = app.listen(port, () => {
    console.log(`Backend server running on port ${port}`);
  });
  attachAuthority(server, pool, { jwtSecret: process.env.JWT_SECRET });
  console.log('Authority WS attached at /authority');
}
```

- [ ] **Step 3: Verify tests still don't boot the socket**

Run: `cd backend && npm test`
Expected: all tests pass; no "address in use" or hanging — importing `app` in tests does not call `attachAuthority` (guarded).

- [ ] **Step 4: Live smoke test**

Restart the backend so the new code + `ws` module load (Node has no hot reload; the backend process holds the port):
```bash
docker exec <backend-container> sh -lc 'pkill -f "node src/index.js"; sleep 1'
# compose restarts it, or: docker exec -d <backend-container> npm start
```
Then, from a machine with `node` and `ws`:
```bash
# 1) get a dev token
curl -s "http://localhost:3101/api/dev-token?user_id=1" | jq .
# 2) connect (use the token) and send join for an existing world id, expect a "joined" then "state" frames
```
Expected: the WS connects to `ws://localhost:3101/authority?token=...`, a `joined` message arrives with a `spawn`, and `state` frames stream at ~20 Hz. If no world exists yet, create one via the Worlds UI / `POST /api/worlds` first. Record the observed frames in the task report.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.js
git commit -m "feat(authority): attach authority WS to backend process"
```

---

### Task 6: Frontend WS client — `WorldAuthorityClient`

**Files:**
- Create: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.js`
- Test: `frontend/src/games/something2/src/js/net/WorldAuthorityClient.test.js`

**Interfaces:**
- Produces: `class WorldAuthorityClient`
  - `constructor({ url, token, onJoined, onState, onError, onClose, inputIntervalMs = 50, now = () => performance.now() })`
  - `connect(worldId)` — opens `new WebSocket(url + '?token=...')`, sends `{type:'join', world_id}` on open.
  - `sendInput(dx, dy, dt) -> { sent: boolean, seq?, dx?, dy?, dt? }` — accumulates `dt`; when `now() - lastSentAt >= inputIntervalMs`, sends `{type:'input', seq, dx, dy}` (monotonic `seq`), resets the accumulator, and returns `{sent:true, seq, dx, dy, dt: accumulatedDt}`. Otherwise returns `{sent:false}`.
  - `ping()`, `disconnect()`.
- Depends on: global `WebSocket` (mocked in tests).

- [ ] **Step 1: Write the failing test**

`frontend/src/games/something2/src/js/net/WorldAuthorityClient.test.js`:
```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorldAuthorityClient } from './WorldAuthorityClient.js';

// Minimal fake WebSocket capturing sent frames.
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; FakeWS.last = this; this.listeners = {}; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  emit(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev)); }
}

beforeEach(() => { globalThis.WebSocket = FakeWS; FakeWS.OPEN = 1; });

describe('WorldAuthorityClient', () => {
  it('sends join on open', () => {
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't' });
    c.connect('w1');
    FakeWS.last.emit('open');
    expect(FakeWS.last.sent[0]).toEqual({ type: 'join', world_id: 'w1' });
  });

  it('throttles input to the interval and accumulates dt', () => {
    let clock = 1000;
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', inputIntervalMs: 50, now: () => clock });
    c.connect('w1');
    FakeWS.last.emit('open');
    FakeWS.last.sent.length = 0; // drop the join frame

    const r1 = c.sendInput(1, 0, 0.016); // t=1000, first send allowed
    expect(r1.sent).toBe(true);
    expect(r1.seq).toBe(1);

    clock = 1020;
    const r2 = c.sendInput(1, 0, 0.016); // only 20ms later → throttled
    expect(r2.sent).toBe(false);

    clock = 1060;
    const r3 = c.sendInput(0, 1, 0.016); // 60ms since last send → send
    expect(r3.sent).toBe(true);
    expect(r3.seq).toBe(2);
    // dt accumulated across the throttled + current frame
    expect(r3.dt).toBeCloseTo(0.048, 5);
    // most-recent input vector wins
    const last = FakeWS.last.sent[FakeWS.last.sent.length - 1];
    expect(last).toMatchObject({ type: 'input', seq: 2, dx: 0, dy: 1 });
  });

  it('dispatches joined/state to callbacks', () => {
    const onJoined = vi.fn();
    const onState = vi.fn();
    const c = new WorldAuthorityClient({ url: 'ws://x/authority', token: 't', onJoined, onState });
    c.connect('w1');
    FakeWS.last.emit('message', { data: JSON.stringify({ type: 'joined', user_id: '1', spawn: { x: 5, y: 6 } }) });
    FakeWS.last.emit('message', { data: JSON.stringify({ type: 'state', tick: 1, ackSeq: 0, players: [] }) });
    expect(onJoined).toHaveBeenCalledWith(expect.objectContaining({ user_id: '1' }));
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ tick: 1 }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/WorldAuthorityClient.test.js`
Expected: FAIL — cannot resolve `./WorldAuthorityClient.js`.

- [ ] **Step 3: Implement `WorldAuthorityClient.js`**

`frontend/src/games/something2/src/js/net/WorldAuthorityClient.js`:
```js
/**
 * WorldAuthorityClient — WebSocket client for the authoritative world sim.
 * Sends movement INPUT (never positions); the server owns authority.
 * Input is throttled to ~inputIntervalMs; the caller buffers the returned
 * {seq,dx,dy,dt} for client-side reconciliation.
 */
export class WorldAuthorityClient {
  constructor({ url, token, onJoined, onState, onError, onClose, inputIntervalMs = 50, now = () => performance.now() }) {
    this.url = url;
    this.token = token;
    this.onJoined = onJoined || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || ((e) => console.error('WorldAuthorityClient:', e));
    this.onClose = onClose || (() => {});
    this.inputIntervalMs = inputIntervalMs;
    this.now = now;

    this.ws = null;
    this.connected = false;
    this.joined = false;
    this.worldId = null;
    this._seq = 0;
    this._accumDt = 0;
    this._lastSentAt = -Infinity;
  }

  connect(worldId) {
    this.worldId = worldId;
    const sep = this.url.includes('?') ? '&' : '?';
    const wsUrl = `${this.url}${sep}token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener('open', () => {
      this.connected = true;
      this._send({ type: 'join', world_id: worldId });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      switch (msg.type) {
        case 'joined': this.joined = true; this.onJoined(msg); break;
        case 'state': this.onState(msg); break;
        case 'pong': break;
        case 'error': this.onError(new Error(msg.message || 'authority error')); break;
        default: console.warn('WorldAuthorityClient: unknown msg', msg.type);
      }
    });
    this.ws.addEventListener('error', () => this.onError(new Error('websocket error')));
    this.ws.addEventListener('close', (ev) => {
      this.connected = false; this.joined = false; this.onClose(ev);
    });
  }

  // Returns {sent, seq?, dx?, dy?, dt?}. dt is the seconds accumulated since the
  // previous actual send (so replay during reconciliation uses the real dt).
  sendInput(dx, dy, dt) {
    this._accumDt += dt;
    if (!this.connected) return { sent: false };
    const now = this.now();
    if (now - this._lastSentAt < this.inputIntervalMs) return { sent: false };
    const seq = ++this._seq;
    this._send({ type: 'input', seq, dx, dy });
    this._lastSentAt = now;
    const sentDt = this._accumDt;
    this._accumDt = 0;
    return { sent: true, seq, dx, dy, dt: sentDt };
  }

  ping() { this._send({ type: 'ping' }); }

  disconnect() {
    if (this.ws) { try { this.ws.close(); } catch { /* already closed */ } this.ws = null; }
    this.connected = false; this.joined = false;
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/WorldAuthorityClient.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/net/WorldAuthorityClient.js frontend/src/games/something2/src/js/net/WorldAuthorityClient.test.js
git commit -m "feat(authority): frontend WorldAuthorityClient"
```

---

### Task 7: Client prediction reconciliation — `reconcile.js`

**Files:**
- Create: `frontend/src/games/something2/src/js/net/reconcile.js`
- Test: `frontend/src/games/something2/src/js/net/reconcile.test.js`

**Interfaces:**
- Consumes: `resolveMove` from `../systems/movement.js` (existing).
- Produces: `reconcile(serverPos, ackSeq, buffer, map, dims) -> { x, y, buffer }`
  - `serverPos = {x,y}` authoritative local-player position from a `state`.
  - `ackSeq` the server's acknowledged input seq for the local player.
  - `buffer` = array of `{ seq, dx, dy, dt }` (the local player's sent, un-acked inputs; from Task 6's `sendInput` returns).
  - `map` = the `ChunkedMap` (has `isWalkable`/`speedAt`).
  - `dims = { width, height, speed }` for the local player.
  - Returns the reconciled predicted position after dropping `seq <= ackSeq` and replaying the rest through `resolveMove`, plus the trimmed `buffer`.

- [ ] **Step 1: Write the failing test**

`frontend/src/games/something2/src/js/net/reconcile.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { reconcile } from './reconcile.js';

// Stub map: walkable unless x >= wall.
function stubMap(wall = Infinity) {
  return { isWalkable: (wx) => wx < wall, speedAt: () => 1 };
}
const dims = { width: 0, height: 0, speed: 100 };

describe('reconcile', () => {
  it('drops acked inputs and replays the rest from the server position', () => {
    const buffer = [
      { seq: 1, dx: 1, dy: 0, dt: 0.1 },
      { seq: 2, dx: 1, dy: 0, dt: 0.1 },
      { seq: 3, dx: 1, dy: 0, dt: 0.1 },
    ];
    // Server acked seq 1 and reports the player at x=10 after that input.
    const out = reconcile({ x: 10, y: 0 }, 1, buffer, stubMap(), dims);
    // Replays seq 2 and 3: +10 each → x = 30.
    expect(out.x).toBeCloseTo(30, 5);
    expect(out.buffer.map((b) => b.seq)).toEqual([2, 3]);
  });

  it('a server-side block snaps the prediction back', () => {
    const buffer = [{ seq: 5, dx: 1, dy: 0, dt: 1 }]; // would move far east
    // Server says we're stuck at the wall (x=50) and acked seq 5.
    const out = reconcile({ x: 50, y: 0 }, 5, buffer, stubMap(50), dims);
    expect(out.x).toBe(50);        // no un-acked inputs to replay
    expect(out.buffer).toEqual([]);
  });

  it('replay respects walls (blocked axis does not advance)', () => {
    const buffer = [{ seq: 2, dx: 1, dy: 0, dt: 1 }];
    // base at x=45, wall at 50: center+step crosses wall → blocked.
    const out = reconcile({ x: 45, y: 0 }, 1, buffer, stubMap(50), dims);
    expect(out.x).toBe(45);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/reconcile.test.js`
Expected: FAIL — cannot resolve `./reconcile.js`.

- [ ] **Step 3: Implement `reconcile.js`**

`frontend/src/games/something2/src/js/net/reconcile.js`:
```js
import { resolveMove } from '../systems/movement.js';

// Snap the local player to the authoritative server position, then replay the
// still-unacked inputs so prediction stays responsive. Pure: returns a new
// position and the trimmed buffer.
export function reconcile(serverPos, ackSeq, buffer, map, dims) {
  const remaining = buffer.filter((i) => i.seq > ackSeq);
  const actor = {
    x: serverPos.x,
    y: serverPos.y,
    width: dims.width,
    height: dims.height,
    speed: dims.speed,
  };
  for (const inp of remaining) {
    const r = resolveMove(map, actor, inp.dx, inp.dy, inp.dt);
    actor.x = r.x;
    actor.y = r.y;
  }
  return { x: actor.x, y: actor.y, buffer: remaining };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/games/something2/src/js/net/reconcile.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/net/reconcile.js frontend/src/games/something2/src/js/net/reconcile.test.js
git commit -m "feat(authority): client prediction reconciliation"
```

---

### Task 8: Integrate the authority into chunked-mode gameplay

**Files:**
- Modify: `frontend/src/games/something2/src/js/entities/Player.js` (extract `inputVector`; reuse it in `update`)
- Test: `frontend/src/games/something2/src/js/entities/Player.inputVector.test.js`
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (`initChunked`, `update` chunked branch, `_onServerState` reuse, `destroy`)

**Interfaces:**
- Consumes: `WorldAuthorityClient` (Task 6), `reconcile` (Task 7), `fetchDevToken` (existing in `net/EngineClient.js`), `API_URL` (existing import in `Game.js`), `Player.inputVector` (new export below).
- Produces: chunked mode where the local player is server-authoritative (predicted + reconciled) and remote players populate `this.remotePlayers` from `state`.

**Design notes:**
- `inputVector(keys)` is the single source of the key→`{dx,dy}` mapping so prediction (`Player.update`) and the input sent to the server never drift.
- Local prediction stays as `player.update(dt, keys, chunkedMap)` (unchanged behavior). Each frame Game ALSO calls `authorityClient.sendInput(dx,dy,dt)`; on an actual send it pushes the returned `{seq,dx,dy,dt}` into `this._inputBuffer`.
- On `state`: extract the local player's authoritative `{x,y}` + `ackSeq`, call `reconcile(...)`, set `player.x/y` and `this._inputBuffer` to the result; populate `this.remotePlayers` from the other players.
- Spawn comes from the server `joined.spawn` (authoritative), used as the streaming center.

- [ ] **Step 1: Write the failing test for `inputVector`**

`frontend/src/games/something2/src/js/entities/Player.inputVector.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { inputVector } from './Player.js';

describe('inputVector', () => {
  it('maps WASD/arrows to a direction vector', () => {
    expect(inputVector({ w: true })).toEqual({ dx: 0, dy: -1 });
    expect(inputVector({ arrowdown: true })).toEqual({ dx: 0, dy: 1 });
    expect(inputVector({ a: true, d: true })).toEqual({ dx: 0, dy: 0 }); // cancel
    expect(inputVector({ d: true, s: true })).toEqual({ dx: 1, dy: 1 });
    expect(inputVector({})).toEqual({ dx: 0, dy: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/games/something2/src/js/entities/Player.inputVector.test.js`
Expected: FAIL — `inputVector` is not exported.

- [ ] **Step 3: Extract `inputVector` in `Player.js` and reuse it in `update`**

Add the export (top of `Player.js`, after imports):
```js
// Single source of the key → direction-vector mapping. Used by Player.update
// (local prediction) AND by Game (input sent to the authority) so the two
// never drift.
export function inputVector(keys) {
  let dx = 0, dy = 0;
  if (keys['w'] || keys['arrowup']) dy -= 1;
  if (keys['s'] || keys['arrowdown']) dy += 1;
  if (keys['a'] || keys['arrowleft']) dx -= 1;
  if (keys['d'] || keys['arrowright']) dx += 1;
  return { dx, dy };
}
```
Then in `update(dt, keys, map)`, replace the inline key reading:
```js
    let dx = 0, dy = 0;
    if(keys['w'] || keys['arrowup']) dy -= 1;
    if(keys['s'] || keys['arrowdown']) dy += 1;
    if(keys['a'] || keys['arrowleft']) dx -= 1;
    if(keys['d'] || keys['arrowright']) dx += 1;
```
with:
```js
    let { dx, dy } = inputVector(keys);
```
(Leave the rest of `update` — both the chunked `resolveMove` branch and the legacy branch — unchanged.)

- [ ] **Step 4: Run the inputVector test + existing Player/movement tests**

Run: `cd frontend && npx vitest run src/games/something2/src/js/entities/Player.inputVector.test.js src/games/something2/src/js/systems/movement.test.js`
Expected: PASS. (If a `Player.test.js` exists, run it too — behavior is unchanged.)

- [ ] **Step 5: Commit the extraction**

```bash
git add frontend/src/games/something2/src/js/entities/Player.js frontend/src/games/something2/src/js/entities/Player.inputVector.test.js
git commit -m "refactor(player): extract inputVector for shared prediction/input"
```

- [ ] **Step 6: Wire the authority into `Game.js`**

At the top of `Game.js`, add imports (near the other `net/` imports):
```js
import { WorldAuthorityClient } from "../net/WorldAuthorityClient.js";
import { fetchDevToken } from "../net/EngineClient.js";
import { reconcile } from "../net/reconcile.js";
import { inputVector } from "../entities/Player.js";
import { PLAYER_SPEED_EFFECTIVE } from "../core/constants.js"; // added below
```
Add a constant in `frontend/src/games/something2/src/js/core/constants.js`:
```js
// Effective player speed used by the authoritative sim (Player.speed * speedMultiplier).
export const PLAYER_SPEED_EFFECTIVE = 200;
```

In `initChunked({ worldId, chunkSize, tileTypes, spawnX = 0, spawnY = 0 })`, after building `this.chunkedMap`/`this.streamer`/creatures and before streaming the initial neighborhood, connect to the authority and wait for the authoritative spawn:
```js
    this._inputBuffer = [];
    // Connect to the authoritative sim; spawn comes from the server.
    const { token, user_id } = await fetchDevToken(API_URL);
    this.localUserId = String(user_id);
    const wsUrl = API_URL.replace(/^http/, 'ws') + '/authority';
    const spawn = await new Promise((resolve, reject) => {
      this.authorityClient = new WorldAuthorityClient({
        url: wsUrl,
        token,
        onJoined: (msg) => resolve(msg.spawn),
        onState: (msg) => this._onWorldState(msg),
        onError: (e) => console.error('[authority]', e),
        onClose: () => { this.authorityJoined = false; },
      });
      this.authorityClient.connect(worldId);
      setTimeout(() => reject(new Error('authority join timeout')), 5000);
    });
    this.authorityJoined = true;
    this.player.x = spawn.x;
    this.player.y = spawn.y;
```
Remove the now-superseded `this.player.x = spawnX; this.player.y = spawnY;` lines (spawn is authoritative). Keep the rest of `initChunked` (imageManager load, initial `streamer.update` around the new spawn, camera, input, loop start).

- [ ] **Step 7: Replace the chunked `update` branch to send input + predict**

In `update(dt)`, replace the chunked branch body's networking. The player still predicts locally via `player.update`; additionally send input and buffer actual sends. Replace:
```js
            this.player.update(dt, this.keys, this.chunkedMap);
```
... (leave streamer/creatures/flush logic intact) ... and replace the trailing:
```js
            this.camera.update(this.player);
            if (this.engine && this.engine.joined) this.engine.sendMove(cx, cy);
            return;
```
with:
```js
            this.player.update(dt, this.keys, this.chunkedMap); // local prediction
            // Send input to the authority; buffer actual sends for reconciliation.
            if (this.authorityClient) {
                const { dx, dy } = inputVector(this.keys);
                const s = this.authorityClient.sendInput(dx, dy, dt);
                if (s.sent) this._inputBuffer.push({ seq: s.seq, dx: s.dx, dy: s.dy, dt: s.dt });
            }
```
(Keep the existing `this.player.update(...)` call that was already the first line of the branch — do not double-call it. The net change: the single `player.update` line stays, and the input-send block replaces the dead `this.engine.sendMove` line. `this.camera.update(this.player)` stays.)

- [ ] **Step 8: Add `_onWorldState` reconciliation handler**

Add a method to `Game` (next to the existing `_onServerState`):
```js
    // Authoritative tick from the world authority. Reconcile the local player
    // (snap to server pos for the acked seq, replay un-acked inputs) and refresh
    // remote players for the renderer.
    _onWorldState(msg) {
        this.lastServerTick = msg.tick || 0;
        const next = new NativeMap();
        let mine = null;
        for (const p of msg.players) {
            if (p.id === this.localUserId) { mine = p; continue; }
            next.set(p.id, { x: p.x, y: p.y, facing: p.facing });
        }
        this.remotePlayers = next;
        if (mine) {
            const out = reconcile(
                { x: mine.x, y: mine.y },
                msg.ackSeq || 0,
                this._inputBuffer,
                this.chunkedMap,
                { width: this.player.width, height: this.player.height, speed: PLAYER_SPEED_EFFECTIVE }
            );
            this.player.x = out.x;
            this.player.y = out.y;
            this._inputBuffer = out.buffer;
        }
    }
```

- [ ] **Step 9: Close the authority client on destroy**

In `destroy()`, before `cancelAnimationFrame(...)`, add:
```js
        if (this.authorityClient) this.authorityClient.disconnect();
```

- [ ] **Step 10: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: all tests pass (existing 78 + WorldAuthorityClient + reconcile + inputVector). No import errors.

- [ ] **Step 11: Production build**

Run: `cd frontend && npm run build`
Expected: build succeeds (no unresolved imports / syntax errors).

- [ ] **Step 12: Live browser verification (two clients)**

With the backend restarted (Task 5) and a world created:
1. Open the chunked world in two browser tabs (two different `user_id`s — `fetchDevToken` mints a random one per load).
2. Move the player in tab A; confirm tab B shows A's avatar moving (remote presence via `this.remotePlayers`), and vice-versa.
3. Walk into an unwalkable tile; confirm the server blocks it (no wall-clip) and movement feels responsive (prediction) without rubber-banding beyond a small correction.
4. Check the browser console is clean (no reconnect spam, no errors).
Record observations in the task report. If two-tab runtime isn't available in this environment, note it and rely on the automated suites + single-client smoke.

- [ ] **Step 13: Commit**

```bash
git add frontend/src/games/something2/src/js/core/Game.js frontend/src/games/something2/src/js/core/constants.js
git commit -m "feat(authority): server-authoritative players in chunked mode"
```

---

## Self-Review

**1. Spec coverage:**
- Authority inside backend process (approach A) → Tasks 4 + 5. ✓
- `collision.js` port + `ServerMap` → Task 2. ✓
- `world.js` per-world sim + tick → Task 3. ✓
- `server.js` ws transport, JWT verify, tick broadcast, persistence → Task 4. ✓
- 20 Hz tick / `TICK_MS=50` → Task 4 (`tickMs=50` default) + Global Constraints. ✓
- Protocol (`join/input/ping` ↔ `joined/state/pong/error`) → Tasks 4 + 6. ✓
- Structural anti-cheat (input-only, server clamps `dx,dy`) → Task 3 `setInput` clamp + Task 4. ✓
- `WorldAuthorityClient` → Task 6. ✓
- Client prediction + reconciliation → Tasks 7 + 8. ✓
- Remote players via existing `this.remotePlayers` render path → Task 8. ✓
- `world_players` persistence (load on join, upsert on flush/disconnect) → Tasks 1 + 4. ✓
- `require.main === module` guard (no socket in tests) → Task 5. ✓
- Creatures unchanged → confirmed by NOT touching CreatureManager; chunked `update` retains creature logic. ✓
- Go engine untouched → no `engine/` edits. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step contains full code. ✓

**3. Type consistency:**
- `resolveMove(map, actor, dirX, dirY, dt) -> {x,y,moved}` consistent across collision.js, world.js, reconcile.js. ✓
- `ServerMap(world)` with `world={seed,chunkSize,tileTypes}` consistent between Task 2 and Task 4's `loadWorld`. ✓
- `sendInput(dx,dy,dt) -> {sent,seq,dx,dy,dt}` (Task 6) matches Game's buffer push + `reconcile` buffer entry `{seq,dx,dy,dt}` (Tasks 7, 8). ✓
- `reconcile(serverPos, ackSeq, buffer, map, dims)` signature identical in Task 7 definition and Task 8 call. ✓
- State message `{type,tick,ackSeq,players:[{id,x,y,facing}]}` produced in Task 4, consumed in Tasks 6/8. ✓
- `joined` `{user_id, spawn:{x,y}, tickRate}` produced Task 4, consumed Task 8 (`msg.spawn`). ✓

**Deviation flagged for the executor:** the spec says "client input throttle ~20 Hz" and this plan implements exactly that (Game sends on ≥`TICK_MS` accumulated), while local prediction runs every render frame. Because prediction (per-frame) and reconciliation replay (per-send) use different cadences, expect a small sub-tile correction each server tick — acceptable for Slice 1; interpolation/smoothing is Slice 3.

---
