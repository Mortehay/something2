# Authority Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Node authority against dead sockets and two smaller robustness gaps: reap half-open client sockets via a ws-protocol heartbeat, pin `jwt.verify` to HS256, and bound `ServerMap.chunks` with LRU eviction.

**Architecture:** All three are localized. The reaper is a fourth `setInterval` in `attachAuthority` that pings `wss.clients` and terminates sockets that missed the previous ping — `terminate()` routes through the existing `ws.on('close')` teardown, so no new teardown logic. The JWT pin is a one-argument change at the upgrade handler. The LRU is contained in `ServerMap.getChunk`, exploiting JS `Map` insertion-order iteration.

**Tech Stack:** Node.js (CommonJS), `ws` 8.21.1 (supports the `autoPong: false` client option used by the reaper test), `jsonwebtoken`, `node --test`.

## Global Constraints

- The reaper uses the **ws protocol** ping/pong (`ws.ping()` / the `'pong'` event), NOT the app-level `{type:'ping'}` message; the app-level ping handler at `server.js:229` is left unchanged.
- `terminate()` must route through the **existing** `ws.on('close')` teardown (server.js:232) — no duplicated persist/remove/isEmpty logic.
- Tuning is single-sourced: `heartbeatMs` (default `30000`, overridable via `opts` for tests) in `server.js`; `MAX_CHUNKS = 512` exported from `collision.js`.
- LRU eviction is a memory bound only — `generateChunk` is deterministic, so an evicted chunk regenerates identically; eviction never changes simulation output.
- `jwt.verify` is pinned to `{ algorithms: ['HS256'] }`.
- No protocol change, no schema change, no client change.
- Tests use `node --test`; run from `backend/` with `node --test tests/<file>`.

---

### Task 1: ServerMap LRU eviction

**Files:**
- Modify: `backend/src/authority/collision.js` (add `MAX_CHUNKS`, LRU logic in `getChunk`, export `MAX_CHUNKS`)
- Test: `backend/tests/authority_collision.test.js` (append LRU tests)

**Interfaces:**
- Consumes: existing `generateChunk(world, cx, cy)` (deterministic), existing `ServerMap` class with `this.chunks = new Map()`.
- Produces: `MAX_CHUNKS` constant exported from `collision.js` (value `512`); `ServerMap.getChunk(cx, cy)` unchanged signature/return, now LRU-bounded.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/authority_collision.test.js`:

```js
const { MAX_CHUNKS } = require('../src/authority/collision.js');

// A ServerMap over an all-grass world so getChunk always succeeds.
function lruMap() {
  return new ServerMap({
    seed: 1,
    chunkSize: 8,
    tileTypes: { grass: { walkable: true, speed: 1 } },
  });
}

test('ServerMap.chunks is bounded at MAX_CHUNKS (evicts the oldest)', () => {
  const m = lruMap();
  // Request MAX_CHUNKS distinct chunks (row 0, cols 0..MAX_CHUNKS-1).
  for (let cx = 0; cx < MAX_CHUNKS; cx++) m.getChunk(cx, 0);
  assert.equal(m.chunks.size, MAX_CHUNKS);
  assert.ok(m.chunks.has('0,0'), 'oldest still present at exactly cap');
  // One more distinct chunk pushes past the cap → oldest ('0,0') evicted.
  m.getChunk(MAX_CHUNKS, 0);
  assert.equal(m.chunks.size, MAX_CHUNKS);
  assert.ok(!m.chunks.has('0,0'), 'oldest chunk evicted past cap');
  assert.ok(m.chunks.has(`${MAX_CHUNKS},0`), 'newest chunk present');
});

test('ServerMap.getChunk refreshes recency so a re-touched chunk survives eviction', () => {
  const m = lruMap();
  for (let cx = 0; cx < MAX_CHUNKS; cx++) m.getChunk(cx, 0);
  // Re-touch the oldest key so it becomes newest.
  m.getChunk(0, 0);
  // Now insert a new distinct chunk → the *next*-oldest ('1,0') is evicted, not '0,0'.
  m.getChunk(MAX_CHUNKS, 0);
  assert.ok(m.chunks.has('0,0'), 're-touched chunk survives');
  assert.ok(!m.chunks.has('1,0'), 'next-oldest evicted instead');
});

test('evicted chunk regenerates identically (eviction is memory-only)', () => {
  const m = lruMap();
  const first = m.getChunk(0, 0);
  const snapshot = JSON.stringify(first);
  for (let cx = 1; cx <= MAX_CHUNKS; cx++) m.getChunk(cx, 0); // evicts '0,0'
  assert.ok(!m.chunks.has('0,0'));
  const regen = m.getChunk(0, 0);
  assert.equal(JSON.stringify(regen), snapshot, 'regenerated chunk is identical');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/authority_collision.test.js`
Expected: FAIL — `MAX_CHUNKS` is `undefined` (so the loops run `cx < undefined` = 0 iterations and `m.chunks.size` assertions fail), and no eviction occurs.

- [ ] **Step 3: Implement the LRU**

In `backend/src/authority/collision.js`:

Add the constant near the top (after `MAP_TILE_SIZE`):

```js
const MAX_CHUNKS = 512; // per-ServerMap LRU cap on memoized chunk grids
```

Replace `getChunk` (currently collision.js:44-52):

```js
  getChunk(cx, cy) {
    const key = `${cx},${cy}`;
    const g = this.chunks.get(key);
    if (g !== undefined) {
      // Refresh recency: delete + re-set moves the key to the newest position
      // (Map preserves insertion order, so the first key is the LRU victim).
      this.chunks.delete(key);
      this.chunks.set(key, g);
      return g;
    }
    const grid = generateChunk(this.world, cx, cy);
    this.chunks.set(key, grid);
    if (this.chunks.size > MAX_CHUNKS) {
      this.chunks.delete(this.chunks.keys().next().value); // evict oldest
    }
    return grid;
  }
```

Update the export line (currently `module.exports = { resolveMove, ServerMap, MAP_TILE_SIZE };`):

```js
module.exports = { resolveMove, ServerMap, MAP_TILE_SIZE, MAX_CHUNKS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/authority_collision.test.js`
Expected: PASS — all collision tests (existing + 3 new LRU tests) green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/collision.js backend/tests/authority_collision.test.js
git commit -m "feat(authority): bound ServerMap chunk cache with LRU eviction (cap 512)"
```

---

### Task 2: Pin jwt.verify to HS256

**Files:**
- Modify: `backend/src/authority/server.js:31` (add `{ algorithms: ['HS256'] }`)
- Test: `backend/tests/authority_server.test.js` (append an upgrade-rejection test)

**Interfaces:**
- Consumes: existing upgrade handler at `server.js:25-42`, the test helpers `boot()`, `connect()`, `token()` already in `authority_server.test.js`.
- Produces: no new exports; behavior change only (tokens not signed HS256 are rejected at upgrade).

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/authority_server.test.js`:

```js
test('rejects an upgrade with a non-HS256 token (alg:none)', async () => {
  const { url, handle, server } = await boot();
  // A token with alg "none" and no signature — accepted by an unpinned verify
  // if the secret check is bypassed; must be rejected when algorithms:['HS256'].
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ user_id: 99 })).toString('base64url');
  const noneToken = `${header}.${body}.`;
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(noneToken)}`);
  const outcome = await new Promise((res) => {
    ws.on('error', () => res('error'));
    ws.on('close', () => res('close'));
    ws.on('open', () => res('open'));
  });
  assert.ok(outcome === 'error' || outcome === 'close', `alg:none must be rejected, got ${outcome}`);
  try { ws.close(); } catch { /* already closed */ }
  handle.close(); server.close();
});

test('accepts a valid HS256 token', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1); // connect() signs with HS256
  const opened = await new Promise((res) => {
    ws.on('open', () => res(true));
    ws.on('error', () => res(false));
    ws.on('close', () => res(false));
  });
  assert.ok(opened, 'a valid HS256 token should connect');
  ws.close(); handle.close(); server.close();
});
```

- [ ] **Step 2: Run tests to verify the alg:none test fails**

Run: `cd backend && node --test tests/authority_server.test.js`
Expected: the `alg:none` test FAILS — without pinning, `jwt.verify` with a provided secret still rejects `alg:none` in current `jsonwebtoken` (it throws "jwt signature is required"), so this test may already pass. **If it already passes**, the pin is still required as defense-in-depth and to reject `HS384`/`HS512`/`RS256` confusion; keep the test and add the pin in Step 3. The `accepts a valid HS256 token` test must PASS both before and after.

> Note to implementer: `jsonwebtoken` already rejects `alg:none` when a secret is passed, so the alg:none test may be green pre-change. That is expected — do not treat a green alg:none test as "nothing to do." The spec mandates the explicit `algorithms: ['HS256']` pin regardless (it closes RS256/HS-family confusion that a bare `verify` does not). Proceed to Step 3.

- [ ] **Step 3: Pin the algorithm**

In `backend/src/authority/server.js`, change line 31 from:

```js
      const payload = jwt.verify(token, jwtSecret);
```

to:

```js
      const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && node --test tests/authority_server.test.js`
Expected: PASS — all server tests green, including both new tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/authority/server.js backend/tests/authority_server.test.js
git commit -m "feat(authority): pin jwt.verify to HS256 (reject algorithm confusion)"
```

---

### Task 3: Dead-socket ping/pong reaper

**Files:**
- Modify: `backend/src/authority/server.js` (add `heartbeatMs` opt, per-connection `isAlive`/`pong` handler, heartbeat `setInterval`, `clearInterval` in `close()`)
- Test: `backend/tests/authority_server.test.js` (append reaper tests)

**Interfaces:**
- Consumes: existing `wss` (`WebSocketServer`), `wss.on('connection', (ws) => {...})` at server.js:196, the existing `ws.on('close')` teardown at server.js:232, the returned `close()` at server.js:282.
- Produces: new `opts.heartbeatMs` (default `30000`); the returned handle object is unchanged in shape (`{ close() }`).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/authority_server.test.js`. These boot the authority with a short `heartbeatMs`, so add a boot helper that forwards it:

```js
// Boot with a caller-supplied heartbeat interval (ms) for the reaper tests.
function bootHeartbeat(heartbeatMs) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, fakePool(), {
      jwtSecret: SECRET, tickMs: 20, heartbeatMs,
    });
    server.listen(0, () => {
      const port = server.address().port;
      resolve({ url: `ws://127.0.0.1:${port}/authority`, handle, server });
    });
  });
}

test('reaps a dead socket that stops answering protocol pings', async () => {
  const HB = 40;
  const { url, handle, server } = await bootHeartbeat(HB);
  // autoPong:false → this ws client does NOT auto-reply to server pings,
  // so the server sees it as dead after one missed cycle and terminates it.
  const dead = new WebSocket(`${url}?token=${encodeURIComponent(token(1))}`, [], { autoPong: false });
  await new Promise((res) => dead.on('open', res));
  dead.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(dead, 'joined');

  // Within ~2 heartbeat cycles the server should terminate the socket, which
  // the client observes as a close event.
  const closed = await new Promise((res) => {
    const to = setTimeout(() => res(false), HB * 6);
    dead.on('close', () => { clearTimeout(to); res(true); });
  });
  assert.ok(closed, 'dead (non-ponging) socket should be terminated by the reaper');
  handle.close(); server.close();
});

test('does not reap a live socket that answers protocol pings', async () => {
  const HB = 40;
  const { url, handle, server } = await bootHeartbeat(HB);
  const live = connect(url, 2); // default autoPong:true → auto-replies to pings
  await new Promise((res) => live.on('open', res));
  live.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(live, 'joined');

  // Over several heartbeat cycles the live socket must NOT be closed.
  const stillOpen = await new Promise((res) => {
    const to = setTimeout(() => res(true), HB * 6);
    live.on('close', () => { clearTimeout(to); res(false); });
  });
  assert.ok(stillOpen, 'live (ponging) socket must survive the reaper');
  live.close(); handle.close(); server.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && node --test tests/authority_server.test.js`
Expected: the `reaps a dead socket` test FAILS (no heartbeat exists, so the dead socket is never terminated → the `close` never fires → `closed === false`). The `does not reap a live socket` test passes trivially (nothing reaps anything yet) — that's fine; it guards against over-reaping once the reaper lands.

- [ ] **Step 3: Add the heartbeat opt**

In `backend/src/authority/server.js`, in the `opts` reads near the top of `attachAuthority` (after `const creatureFlushMs = opts.creatureFlushMs || 3000;` at line 19), add:

```js
  const heartbeatMs = opts.heartbeatMs || 30000;
```

- [ ] **Step 4: Track per-connection liveness**

In `wss.on('connection', (ws) => { ... })` (server.js:196), add liveness setup at the very top of the callback, before `ws.on('message', ...)`:

```js
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
```

(Leave the rest of the connection handler — message handling and `ws.on('close')` — exactly as-is.)

- [ ] **Step 5: Add the heartbeat timer**

In `backend/src/authority/server.js`, after the `flushTimer` block (server.js:273-280) and before the `return {` (server.js:282), add:

```js
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
```

- [ ] **Step 6: Clear the heartbeat timer on close**

In the returned `close()` (server.js:283-291), add the clear alongside the existing three:

```js
    close() {
      clearInterval(tickTimer);
      clearInterval(flushTimer);
      clearInterval(creatureFlushTimer);
      clearInterval(heartbeatTimer);
      // Terminate any live client sockets before closing the server. wss.close()
      // alone only stops accepting new connections; open sockets would keep the
      // event loop alive (and hang a clean shutdown / test process).
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && node --test tests/authority_server.test.js`
Expected: PASS — all server tests green, including both reaper tests.

- [ ] **Step 8: Run the full authority suite to check for regressions**

Run: `cd backend && node --test tests/authority_*.test.js`
Expected: PASS — no regressions across the authority tests.

- [ ] **Step 9: Commit**

```bash
git add backend/src/authority/server.js backend/tests/authority_server.test.js
git commit -m "feat(authority): reap dead sockets via ws-protocol heartbeat (30s)"
```

---

## Self-Review

**Spec coverage:**
- Dead-socket reaper → Task 3 (opt, isAlive/pong, timer, clear-on-close). ✓
- JWT pin → Task 2. ✓
- ServerMap LRU (cap 512, deterministic regen) → Task 1. ✓
- Reaper uses ws-protocol ping/pong, app-level ping untouched → Task 3 leaves server.js:229 unchanged; timer uses `ws.ping()`/`'pong'` event. ✓
- Single-sourced tuning (`heartbeatMs` opt, `MAX_CHUNKS` export) → Tasks 1 & 3. ✓
- terminate() routes through existing close teardown → Task 3 adds no teardown logic; relies on server.js:232. ✓
- Testing per spec (reaper live/dead, JWT alg:none + HS256, LRU cap/recency/regen) → all three tasks. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The Task 2 Step 2 note about a possibly-green alg:none test is a real behavioral caveat with explicit guidance, not a placeholder.

**Type consistency:** `MAX_CHUNKS` exported from `collision.js` and imported in the test (Task 1). `heartbeatMs` opt name consistent across Task 3 steps and the `bootHeartbeat` helper. `bootHeartbeat`/`bootHeartbeat(HB)` used consistently in the reaper tests. No signature changes to `getChunk`, upgrade handler, or the returned handle.
