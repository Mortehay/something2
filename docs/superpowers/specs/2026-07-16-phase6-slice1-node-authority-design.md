# Phase 6 — Slice 1: Node Authority Foundation + Authoritative Players

**Date:** 2026-07-16
**Epic:** SOMET-53 connected-chunked-world, Phase 6 (authoritative server-side simulation)
**Status:** Design approved, ready for implementation plan

## Context

Phases 1–5 delivered a seamless chunked overworld that is **client-authoritative**: `Player.update` moves the local player against the `ChunkedMap`, and `CreatureManager` roams creatures client-side and flushes their positions to Postgres. The frozen Go engine (`engine/`) is strictly per-`map_id` and is not used by chunked mode.

Phase 6 makes the chunked world **server-authoritative** across three goals (all required):

1. Multiplayer presence — players in the same world see each other.
2. Server-owned creature simulation — creatures tick even with no client loaded.
3. Authoritative / anti-cheat movement — the server owns positions.

Architecture decision (locked during brainstorming): build a **fresh Node authority** that reuses the existing JS world logic (`mapService.generateChunk`, world config, the `resolveMove` collision algorithm). The Go engine stays frozen.

Phase 6 is decomposed into three slices, each with its own spec/plan/implementation cycle:

- **Slice 1 (this spec):** Node authority foundation + authoritative players (multiplayer presence + anti-cheat movement).
- **Slice 2:** server-owned creatures (server ticks/roams/persists creatures; client becomes render-only for creatures).
- **Slice 3:** mob AI/aggression + area-of-interest (AOI) filtering + interpolation/reconciliation polish.

This spec covers **Slice 1 only**.

## Goal

A new Node WebSocket authority, hosted inside the existing backend process, that owns authoritative player movement for a chunked world: clients send movement **input** (not positions), the server integrates it against server-side collision at a fixed tick, and broadcasts authoritative state. Two or more players in the same world see each other move. The local player is client-side predicted and server-reconciled. Creatures remain client-side (unchanged) until Slice 2.

## Architecture

The authority is a **new module set inside the existing backend Node service** (`backend/src/authority/`). It attaches a `ws` WebSocket server to the existing HTTP server via the `upgrade` event and runs a fixed-rate tick loop with `setInterval`. It `require`s `mapService` directly (zero duplication of world generation) and reuses the existing pg pool and `JWT_SECRET`.

Rationale for hosting inside the backend rather than a separate container:

- Maximum reuse of the JS world logic — the entire point of "fresh Node authority."
- No cross-service code sharing, no second pg pool, one deploy.
- Fastest path to a working authoritative loop.

**Documented extraction path:** when player/creature load makes the tick loop compete with HTTP handlers on the single Node event loop, the `backend/src/authority/` modules are structured to be liftable into a standalone `realtime/` service with its own pg pool (sharing `mapService` via a shared module). Slice 1 keeps everything in-process; extraction is explicitly out of scope.

### Tick model

- Fixed authoritative tick at **20 Hz** (`TICK_MS = 50`).
- Each tick, for every connected player: integrate the player's **latest** input vector over `dt` using the server `resolveMove` against the world's chunk data, update `facing`, and record the input's sequence number as the acknowledged seq.
- After integrating all players in a world, broadcast a single `state` message to every player connected to that world (Slice 1 broadcasts to all in the world; AOI filtering is Slice 3).

## Components

### 1. `backend/src/authority/collision.js`

CommonJS port of the frontend `resolveMove` (`frontend/src/games/something2/src/js/systems/movement.js`), preserving its exact algorithm:

- No-op when `dirX === 0 && dirY === 0` (returns current position, `moved:false`).
- Normalize `(dirX,dirY)` by its hypot so diagonals aren't faster.
- Step = `normalizedDir * actor.speed * dt * map.speedAt(centerX, centerY)`.
- Test each axis independently at the moved center via `map.isWalkable`; an unwalkable or unloaded tile blocks that axis.
- Pure: returns `{x, y, moved}`, never mutates the actor.

Also exports a `ServerMap` class implementing the map interface `resolveMove` consumes:

- `constructor(world, tileTypes)` — `world = {seed, chunkSize}`; `tileTypes` = walkability/speed lookup keyed by tile name.
- Lazy in-memory chunk cache: `getChunk(cx, cy)` calls `mapService.generateChunk({seed, chunkSize, tileTypes}, cx, cy)` on cache miss and memoizes the `NxN` tile grid keyed by `CHUNK_KEY(cx,cy)`.
- `getTileAt(wx, wy)` — world-pixel → chunk/local using `MAP_TILE_SIZE = 100` and `chunkSize`, `Math.floor` for negatives; returns the tile name string or `null`.
- `isWalkable(wx, wy)` — `null` tile → `false`; otherwise the tile type's walkable flag.
- `speedAt(wx, wy)` — tile type's speed multiplier, default `1`.

Parity requirement: the numeric coordinate math (`MAP_TILE_SIZE`, `Math.floor` ownership, per-axis stepping) must match the frontend `worldCoords.js` + `resolveMove` so a client's prediction and the server's authority converge on the same positions.

### 2. `backend/src/authority/world.js`

Per-world authoritative state and simulation.

- `class World { constructor(worldRow, tileTypes) }` — builds a `ServerMap`; holds `players: Map<user_id, PlayerState>` where `PlayerState = { userId, x, y, width, height, speed, facing, input:{dx,dy}, ackSeq }`.
- `addPlayer(userId, spawn)` / `removePlayer(userId)`.
- `setInput(userId, seq, dx, dy)` — clamps `dx,dy` to `[-1, 1]`, stores as the player's latest input and pending seq.
- `tick(dt)` — for each player, `resolveMove(this.map, player, input.dx, input.dy, dt)`; updates `x,y,facing`; sets `ackSeq` to the pending seq. Facing derives from the input vector (8-direction, matching the client's facing convention).
- `snapshot()` — returns `{ players: [{ id, x, y, facing }] }` for broadcast.

Player dimensions/speed come from the same constants the client uses for the player actor (documented in the plan; sourced from the existing `Player`/constants).

### 3. `backend/src/authority/server.js`

The transport + loop.

- `attachAuthority(httpServer, pool, opts)` — creates a `ws` `WebSocketServer({ noServer: true })` and handles `httpServer.on('upgrade')` for a dedicated path (e.g. `/authority`), so it coexists with Express HTTP routes.
- On upgrade: verify the `?token=` JWT with `JWT_SECRET` (same verification as the Go engine's dev tokens; `jwt.verify`), extract `user_id`. Reject (close) on missing/invalid token.
- Per connection, handle inbound messages:
  - `join {world_id}` — load the world row (pg), lazily construct/lookup the in-memory `World` (one per `world_id`), load the player's persisted position (`world_players`) or default to world center (`chunkSize*100/2` of chunk `(0,0)`), `addPlayer`, and reply `joined {user_id, spawn:{x,y}, tickRate}`.
  - `input {seq, dx, dy}` — `world.setInput(user_id, seq, dx, dy)`.
  - `ping` — reply `pong`.
- Single global `setInterval(TICK_MS)`: for each active `World` with ≥1 player, `world.tick(dt)`, then broadcast `state {tick, ackSeq, players}` to that world's connections. `ackSeq` is per-recipient (each player's own acknowledged seq).
- On connection close: `world.removePlayer`, persist the player's last position, and drop empty worlds from memory.
- Periodic persistence flush (e.g. every 30 s): upsert connected players' positions into `world_players`.

`attachAuthority` is invoked from `backend/src/index.js` only under the `require.main === module` server-start path (so tests that import `app` don't spin up the socket). Guarded by an env flag if needed for staged rollout.

### 4. `frontend/.../net/WorldAuthorityClient.js`

New WS client modeled on `EngineClient` but speaking the world protocol.

- `constructor({ url, token, onJoined, onState, onError, onClose, inputIntervalMs })`.
- `connect(worldId)` — opens WS with `?token=`, sends `join {world_id}`.
- `sendInput(seq, dx, dy)` — throttled to ~20 Hz (`inputIntervalMs`, default 50), most-recent-wins (mirrors `EngineClient.sendMove` throttling).
- Dispatches `joined` / `state` / `pong` / `error` to callbacks.
- `disconnect()`.

### 5. Client prediction + reconciliation (in `Player` / `Game`)

Chunked-mode local player becomes input-send + predict + reconcile:

- Each frame: compute input vector `(dx,dy)` from keys; `authorityClient.sendInput(seq++, dx, dy)`; apply the same input locally via `resolveMove(chunkedMap, player, dx, dy, dt)` for immediate prediction; push `{seq, dx, dy, dt}` into a pending-input buffer.
- On `state`: find the local player's authoritative `{x,y}` and `ackSeq`; snap the predicted player to that position, drop buffered inputs with `seq <= ackSeq`, then **replay** the remaining buffered inputs through `resolveMove` to recompute the predicted position (reconciliation).
- Remote players: update the existing `this.remotePlayers` Map (`user_id → {x,y,facing}`) from the `state.players` (excluding the local user). The existing `RenderSystem.renderChunked`/`buildDrawables` already draws `remotePlayers`, so rendering needs no structural change. Remote positions are stored as latest-snapshot in Slice 1; smoothing/interpolation is Slice 3.

`Game` chunked mode wires this in: on entering a world it constructs the `WorldAuthorityClient`, and the update loop replaces local-authoritative player movement with predict+send while keeping creature roaming client-side (unchanged).

## Data model

New migration `world_players`:

```
world_players(
  world_id  uuid    references worlds(id) on delete cascade,
  user_id   text    not null,
  x         real    not null,
  y         real    not null,
  updated_at timestamptz default now(),
  primary key (world_id, user_id)
)
```

Upsert on flush/disconnect (`ON CONFLICT (world_id, user_id) DO UPDATE`). Load on join; absent row → spawn at world center.

## Protocol

Client → server:

- `{ type: "join", world_id }` (token in `?token=` query)
- `{ type: "input", seq, dx, dy }` — `dx,dy` intended in `[-1,1]`, clamped server-side
- `{ type: "ping" }`

Server → client:

- `{ type: "joined", user_id, spawn: {x,y}, tickRate }`
- `{ type: "state", tick, ackSeq, players: [{ id, x, y, facing }] }`
- `{ type: "pong" }`
- `{ type: "error", message }`

**Anti-cheat is structural:** clients send input intent only, never positions. The server owns speed and collision, so a client cannot teleport, exceed speed, or clip through unwalkable tiles. `dx,dy` are clamped to the unit range; the server normalizes and scales by the authoritative speed.

## Error handling / fallback

- Invalid/missing JWT on upgrade → close the socket (no join).
- `input` before `join` → ignored.
- WS connect failure on the client → surface a connection error and retry with backoff. There is **no** client-authoritative fallback for the local player (that would defeat anti-cheat). Creatures continue roaming client-side, so the world is not blank while reconnecting.
- Unknown message types → logged and ignored (matches `EngineClient`).

## Testing

Backend (node:test):

- `collision.js`: `resolveMove` parity — no-op on zero input; diagonal normalization; per-axis blocking against a stub map; `speedAt` scaling. `ServerMap`: `getTileAt`/`isWalkable`/`speedAt` including negative coordinates and unloaded → `null`/blocked.
- `world.js`: `setInput` clamps to `[-1,1]`; `tick` advances a player on open ground and blocks against an unwalkable tile; `ackSeq` tracks the latest input seq; `snapshot` shape.
- `server.js` integration (in-process `ws`): reject connection without token; `join → joined` with a spawn; `input → state` includes the moved player; two clients in one world each appear in the other's `state`. Uses the `__setPool` mock seam for the world row + `world_players` load/upsert.

Frontend (Vitest):

- Reconciliation: given a `state` (authoritative pos + `ackSeq`) and a buffered input list, the replay drops acked inputs and recomputes the predicted position deterministically; a rejected (blocked) server move snaps the prediction back.
- `WorldAuthorityClient`: input throttling (most-recent-wins within the interval), message dispatch to callbacks.

## Out of scope (later slices)

- Server-owned creature simulation, creature AOI broadcast, creature persistence by the server (Slice 2).
- Area-of-interest / interest management for players, remote-player interpolation smoothing, mob AI/aggression (Slice 3).
- Extracting the authority into a standalone `realtime/` container (future, when load requires).
- A real auth flow (continues to use the existing dev-token JWT).

## Global constraints

- Reuse `mapService.generateChunk` / world config for chunk generation — do **not** duplicate world-gen math in the authority.
- Server collision math must match the frontend `resolveMove` + `worldCoords` numerics (`MAP_TILE_SIZE = 100`, `Math.floor` ownership) so prediction and authority converge.
- Authoritative tick: 20 Hz (`TICK_MS = 50`). Client input throttle: ~20 Hz.
- JWT verification uses the existing `JWT_SECRET`; no new auth system.
- The Go engine (`engine/`) stays frozen and untouched.
- `attachAuthority` must not start during `app` imports in tests (`require.main === module` guard), matching the existing `app.listen`/`runMigrations` pattern.
- Clients send input intent only; the server never trusts client-sent positions.
