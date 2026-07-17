# Authority Hardening — Dead-Socket Reaper, JWT Pinning, ServerMap LRU

**Date:** 2026-07-18
**Epic:** SOMET-53 connected-chunked-world, Phase 6 (authoritative simulation)
**Status:** Design approved, ready for implementation plan
**Builds on:** Slice 1 (Node authority; players), Slice 2 (server creatures), Slice 3a (aggression + contact combat). The Slice 3a final whole-branch review flagged all three items below as newly urgent — aggression makes a lingering ghost player costlier.

## Context

The authority (`backend/src/authority/server.js`) attaches a `ws` server via the http `upgrade` event, JWT-verifies `?token=`, and runs a 20 Hz tick that simulates players + creatures per world. A world is torn down only when `world.isEmpty()` — which happens in the `ws.on('close')` handler when the last player is removed.

Three robustness gaps remain, elevated by Slice 3a:

1. **Half-open sockets are never reaped.** If a client's TCP connection dies without a clean close (network drop, killed process, laptop sleep), the `close` event may never fire. The player stays in `world.players`, the world stays non-empty, and — now that creatures aggro — the ghost keeps creatures perpetually chasing it, burning CPU and corrupting the sim for real players sharing that world. There is currently **no** server-initiated liveness check (only an app-level `ping`→`pong` reply at server.js:229, which a dead client never sends).
2. **JWT algorithm is unpinned.** `jwt.verify(token, jwtSecret)` at server.js:31 accepts any algorithm the token header declares, leaving the algorithm-confusion class open.
3. **`ServerMap.chunks` is unbounded.** `collision.js:41` memoizes every generated chunk grid in a plain `Map` with no eviction; a player roaming far accumulates chunk grids for the world's lifetime.

## Goals

- Detect and terminate dead client sockets via a server-initiated ws-protocol heartbeat, so a world holding only dead sockets is torn down (existing `close` teardown runs on `terminate()`).
- Pin `jwt.verify` to `HS256`.
- Bound `ServerMap.chunks` with LRU eviction.

No protocol change, no schema change, no client change.

## Locked decisions (from brainstorming)

1. **Heartbeat interval = 30 s.** A dead socket is reaped within ~30–60 s (one full miss cycle).
2. **ServerMap LRU cap = 512 chunks** per `ServerMap` instance (per world). Each chunk grid is a small tile array; 512 comfortably covers the active 3×3 neighborhoods of several players plus slack.
3. **All three ship in one branch**, one spec, one plan.
4. Heartbeat uses the **ws protocol** ping/pong (`ws.ping()` / the `'pong'` event), which the `ws` library answers automatically on the client with no client code. The existing app-level `{type:'ping'}`→`{type:'pong'}` message handler at server.js:229 is **left as-is** (it serves client-driven latency checks); the reaper is independent of it.

## Architecture

The reaper is a fourth `setInterval` alongside the existing `tickTimer`/`flushTimer`/`creatureFlushTimer`, iterating `wss.clients`. It relies on the ws protocol: `ws.ping()` causes a conformant peer to send a protocol `pong`, which fires `ws.on('pong')`. Liveness is tracked per socket with an `isAlive` flag using the standard ws heartbeat pattern:

- On `wss.on('connection')`: set `ws.isAlive = true` and register `ws.on('pong', () => { ws.isAlive = true; })`.
- Each heartbeat tick: for every `ws` in `wss.clients`, if `ws.isAlive === false` → `ws.terminate()` (skip the rest); else set `ws.isAlive = false` and `ws.ping()`.

`terminate()` synchronously destroys the socket and fires its existing `ws.on('close')` handler, which persists + removes the player and tears the world down if it became empty. So no new teardown logic is needed — the reaper only needs to *trigger* the existing path.

The heartbeat interval is cleared in the returned `close()` alongside the three existing timers.

The JWT pin is a one-argument change. The LRU is localized to `ServerMap.getChunk`/an eviction helper.

## Components

### `backend/src/authority/server.js` — heartbeat reaper + JWT pin

**Constant:** `const heartbeatMs = opts.heartbeatMs || 30000;` (near the other `opts` reads at the top of `attachAuthority`, so tests can shorten it).

**JWT pin** (server.js:31):

```js
const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
```

**Connection liveness** — inside `wss.on('connection', (ws) => { ... })`, before/after the existing `ws.on('message', ...)` registration:

```js
ws.isAlive = true;
ws.on('pong', () => { ws.isAlive = true; });
```

**Heartbeat timer** — add alongside the other timers:

```js
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, heartbeatMs);
```

**Teardown** — in the returned `close()`, add `clearInterval(heartbeatTimer);` next to the existing three `clearInterval` calls. (Order relative to the existing `for (const client of wss.clients) client.terminate()` does not matter; clear the timer to stop it firing after shutdown.)

Everything else in `server.js` is unchanged. The `ws.on('close')` handler (server.js:232) already performs persist + `removePlayer` + `sockets.delete` + `isEmpty()` teardown; `terminate()` routes through it.

### `backend/src/authority/collision.js` — LRU on `ServerMap.chunks`

Bound `this.chunks` to `MAX_CHUNKS = 512` with least-recently-used eviction, exploiting JS `Map` insertion-order iteration (`map.keys().next().value` is the oldest key):

- **Constant:** `const MAX_CHUNKS = 512;` (module scope; export it for the test).
- **`getChunk(cx, cy)`** — on a **hit**, refresh recency by re-inserting (delete then set) so the key moves to the newest position; on a **miss**, generate, insert, and if `this.chunks.size > MAX_CHUNKS`, evict the oldest (`this.chunks.delete(this.chunks.keys().next().value)`).

```js
getChunk(cx, cy) {
  const key = `${cx},${cy}`;
  let g = this.chunks.get(key);
  if (g !== undefined) {
    // refresh recency: move to newest
    this.chunks.delete(key);
    this.chunks.set(key, g);
    return g;
  }
  g = generateChunk(this.world, cx, cy);
  this.chunks.set(key, g);
  if (this.chunks.size > MAX_CHUNKS) {
    this.chunks.delete(this.chunks.keys().next().value);
  }
  return g;
}
```

Chunk generation is deterministic (`generateChunk(this.world, cx, cy)`), so an evicted chunk regenerates identically on re-access — eviction is purely a memory bound, never a correctness change. Export `MAX_CHUNKS` alongside `resolveMove`, `ServerMap`, `MAP_TILE_SIZE`.

## Protocol

Unchanged. The heartbeat is ws-protocol-level (control frames), invisible to application message handling. Clients need no change (`ws` auto-pongs).

## Data model

Unchanged. No migration.

## Error handling

- A socket that dies mid-session: within one heartbeat cycle its `isAlive` stays `false`, it is `terminate()`d, and the existing `close` handler persists its last-known position (best-effort) and tears down the world if empty.
- A slow-but-alive socket: as long as it answers the protocol ping within one interval, `isAlive` flips back to `true` and it survives.
- `ws.ping()` on a socket mid-close: `ws` no-ops / throws are avoided because `terminate()` removes it from `wss.clients`; a socket closing between ticks simply isn't iterated next time.
- LRU eviction never affects correctness (deterministic regeneration); only recently-unused chunks are dropped.

## Testing

Backend (`node --test`):

- **Reaper (server integration, ws + fakePool):** connect a client and join a world; simulate a dead socket by suppressing its automatic pong (e.g. remove the client's `pong` responder / use a raw socket that never answers) so `ws.isAlive` stays false; drive two heartbeat cycles (with a short `heartbeatMs` opt) and assert the server-side socket is terminated and its world torn down (`worlds` no longer holds it / the world is empty). A control client that *does* pong survives both cycles.
- **JWT pin (upgrade path):** a token signed with `alg: 'none'` (or `HS384`) is rejected at upgrade (`socket.destroy()` → no `connection`); a valid `HS256` token connects. (Assert via connection success/failure.)
- **LRU (`ServerMap`, unit):** with a stubbed/real `generateChunk`, request `MAX_CHUNKS + 1` distinct chunks and assert `map.chunks.size === MAX_CHUNKS` and the first-requested (untouched) key was evicted; re-`getChunk` a key just before overflowing and assert it survives (recency refresh protects it) while a different older key is evicted instead.

Frontend: none (no client change).

## Global constraints

- The reaper uses the **ws protocol** ping/pong, not the app-level `{type:'ping'}` message; the app-level ping handler at server.js:229 is unchanged.
- `terminate()` must route through the **existing** `ws.on('close')` teardown — no duplicated persist/remove/isEmpty logic.
- Tuning is single-sourced: `heartbeatMs` (default 30000, overridable via `opts` for tests) in `server.js`; `MAX_CHUNKS = 512` exported from `collision.js`.
- LRU eviction is a memory bound only — chunk regeneration is deterministic, so eviction never changes simulation output.
- `jwt.verify` is pinned to `['HS256']`.
- No protocol, schema, or client change.

## Out of scope

- Client-side reconnect/backoff on termination (the client already reconnects on socket close per Slice 1; unchanged).
- Idle-player timeout / AFK kick (a live but inactive player is not a dead socket; different feature).
- Global chunk-cache sharing across worlds or an app-wide chunk budget (per-`ServerMap` cap is sufficient).
- Metrics/telemetry on reaped sockets or evictions.
