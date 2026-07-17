# Phase 6 — Slice 2: Server-Owned Creatures

**Date:** 2026-07-17
**Epic:** SOMET-53 connected-chunked-world, Phase 6 (authoritative server-side simulation)
**Status:** Design approved, ready for implementation plan
**Builds on:** Phase 6 Slice 1 (Node authority; spec `2026-07-16-phase6-slice1-node-authority-design.md`, merged `b134773`).

## Context

Slice 1 made **players** server-authoritative over the chunked world (the Node authority at `/authority`: 20 Hz tick, input-only anti-cheat, `ServerMap`/`resolveMove` collision, client prediction + reconciliation, `world_players` persistence). **Creatures remained client-authoritative:** the client `CreatureManager` roams creatures via `resolveMove` and flushes dirty positions to `world_creatures` every ~3 s (`POST /creatures/flush`); creatures are spawned deterministically when a chunk is materialized by `GET /chunk`, and the client fetches them via `GET /creatures`.

Slice 2 moves creature simulation into the authority. The server owns creature roaming and persistence; the client becomes render-only for creatures. This fixes "creatures only move when a client is loaded and roaming them" — creatures now roam for **any** player in the world, driven by the server.

## Goals

- The authority simulates creatures server-side (roam, collision, persistence), reusing the deterministic spawn (`spawnChunkCreatures`) and `ServerMap` collision from Slice 1.
- Creatures tick whenever they are within any connected player's interest neighborhood (the same 3×3 chunk ring the client streams), for **any** player in the world.
- Each client receives creature state over the WebSocket (area-of-interest filtered to its neighborhood) and renders it; the client no longer roams, flushes, or fetches creatures.

## Locked decisions (from brainstorming)

1. **Active simulation set** = the union of all connected players' 3×3 chunk neighborhoods, per world. A chunk leaving the union is persisted + unloaded (its creatures freeze at last position); the world sim tears down when no players are connected (Slice-1 lifecycle).
2. **Broadcast** = a separate `creatures` WebSocket message at a reduced cadence (~5 Hz), per-player AOI-filtered; player `state` stays at 20 Hz. Client renders (with light interpolation). `GET /creatures` is retired.
3. **Spawn ownership** = the authority owns chunk materialization + creature spawn. It gates spawn on its own `INSERT INTO world_chunks … ON CONFLICT DO NOTHING RETURNING`. To keep that gate race-free, the authority becomes the **sole writer** of `world_chunks`: `GET /chunk` no longer inserts (generate-on-miss without persisting; cache-hit returns the authority-persisted row). The creature-spawn block is removed from `GET /chunk`.

## Architecture

Each `World` (Slice 1) gains a **creature simulation** and an **active chunk set**. The authority tick loop (already 20 Hz) drives creature roaming; a reduced-cadence step broadcasts creatures and periodically persists them.

### Active chunk set

Per world, the active set is the union over connected players of `neighborhoodKeys(playerChunk, radius=1)` (the 3×3 ring; same helper/convention the client uses). It is recomputed when the set of players or their chunk membership could have changed — cheaply, each creature-broadcast step is sufficient (5 Hz), from each player's current authoritative position.

### Chunk activation / deactivation

- **Activate** (chunk key newly in the union): ensure materialized + spawned, then load.
  - Ensure/spawn (once): `INSERT INTO world_chunks (world_id, cx, cy, data) VALUES (…) ON CONFLICT (world_id, cx, cy) DO NOTHING RETURNING id`, where `data` is the authority's in-memory generated grid (`ServerMap.getChunk(cx,cy)`). If a row was created (`rowCount > 0`), spawn via `spawnChunkCreatures(world, cx, cy, creatureTypes)` and batch-`INSERT` into `world_creatures`.
  - Load: `SELECT id, type, x, y, hp, facing, color` (join `entity_types` for color, as `GET /creatures` does) for creatures whose **current position** falls in this chunk's bbox (`chunk_size*100` span), and `addCreatures` into the sim (dedup by id — a creature may already be loaded from an adjacent active chunk).
- **Deactivate** (chunk key left the union): persist that chunk's dirty creatures (UPDATE), then drop them from the sim.
- Activation/deactivation DB work is async and fire-and-forget with an in-flight guard per `(world, chunkKey)` (mirroring Slice 1's `loading` dedup), so a per-step recompute cannot launch duplicate loads.

Creatures roam across chunk seams as the **same** entity (world-space positions). Active/inactive and AOI decisions key on a creature's **current** chunk (`chunkOf(c.x, c.y, chunkSize)`), never its spawn chunk.

### Materialization ownership change

`GET /chunk` (client terrain streaming) no longer writes `world_chunks` and no longer spawns creatures:
- Cache hit (`world_chunks` row exists) → return `{ world_id, cx, cy, data }` from the row (unchanged).
- Cache miss → generate terrain in-memory (`generateChunk`) and return it **without** inserting. The authority persists the row on activation; terrain is deterministic so the client's unpersisted view equals the authority's later-persisted row.

Because the client streams only its neighborhood (= the active set) and a world only ticks while it has a connected player, every chunk a client sees is activated (and thus materialized + spawned) by the authority. A chunk fetched via `GET /chunk` but never activated is simply regenerated deterministically next time — no correctness impact.

## Components

### `backend/src/authority/creatures.js` (new)

`class CreatureSim` — server-side creature roaming, a port of the client `CreatureManager` roam logic.

- `constructor(map, rng = Math.random)` — `map` is the world's `ServerMap`.
- Constants (match the client): `CREATURE_SIZE = 48`, `CREATURE_SPEED = 40`, `REDIRECT_CHANCE = 0.02`, 8 `DIRS` + `DIR_FACING`.
- `addCreatures(list)` — dedup by id; store `{ id, type, x, y, width, height, speed, facing, hp, color, _dir, dirty:false }`.
- `tick(dt, activeChunkKeys)` — for each creature whose current chunk ∈ `activeChunkKeys`: 2% redirect, `resolveMove(map, c, dx, dy, dt)`; on move update `x,y,facing`, set `dirty`; on block advance `_dir`. Creatures outside the active set are skipped (frozen).
- `unloadChunk(chunkKey)` — remove creatures whose current chunk === `chunkKey` (caller persists dirty ones first).
- `getDirty()` / `clearDirty(ids)` — confirm-before-clear, as in the client (a failed flush keeps creatures dirty).
- `snapshotForNeighborhood(keys)` — creatures whose current chunk ∈ `keys`, as `{ id, type, x, y, facing, hp, color }`.
- `all()` / `count()` / `has(id)`.

### `backend/src/authority/world.js` (modify)

Compose `this.creatures = new CreatureSim(this.map)`. (Player sim unchanged.)

### `backend/src/authority/server.js` (modify)

- Load `creatureTypes` once per world (alongside `tileTypes`): `SELECT name, color, hp FROM entity_types WHERE is_creature = true ORDER BY id ASC` (deterministic order; `ORDER BY id ASC` for the same reason as the Slice-1 tile-types fix).
- Persist `ServerMap`'s generated grid on activation (`INSERT world_chunks … ON CONFLICT DO NOTHING RETURNING`); spawn + insert `world_creatures` when a row was created; load creatures by bbox.
- Maintain per-world active chunk set + an in-flight guard for activation loads.
- Tick loop: after the player tick, run `world.creatures.tick(dt, activeKeys)`.
- **Creature broadcast** at ~5 Hz (every 4th 50 ms tick, or a dedicated interval): to each connected player, send `{ type: "creatures", creatures: world.creatures.snapshotForNeighborhood(playerNeighborhoodKeys) }`.
- **Persistence**: on the flush interval and on deactivate/world-teardown, UPDATE `world_creatures` for dirty creatures (`getDirty()` → UPDATE → `clearDirty(ids)` on success), reusing the Slice-1 flush cadence.

### `backend/src/index.js` (modify)

- `GET /chunk`: remove the `world_chunks` INSERT and the creature-spawn block; keep cache-hit read and generate-on-miss (return without persisting).
- Remove `GET /api/worlds/:id/creatures` and `POST /api/worlds/:id/creatures/flush` routes (retired — creatures now flow over the WS and are persisted by the authority).

### `frontend/.../entities/CreatureManager.js` (modify → render-only)

- Keep `all`/`has`/`count`; add `applySnapshot(list)` — the `creatures` message is the player's full current-neighborhood set, so `applySnapshot` **reconciles the rendered set to the snapshot**: upsert each present creature (new ones added; existing ones keep their interpolation origin and get a new render target), and **remove** creatures not in the snapshot (they left the AOI). Render target stored for **light interpolation** (lerp current → target so 5 Hz snapshots render smoothly; creatures move ~8 px per 200 ms).
- Remove roaming (`update` roam), `getDirty`/`clearDirty`/`takeDirty`, `pruneOutOfRange`, `_dir`, and the `resolveMove` import.
- A `tick(dt)` (or reuse an interpolation step in render) advances interpolation toward the latest target.

### `frontend/.../core/Game.js` (modify)

- Remove creature fetch/flush/roam wiring: `fetchCreatures`, `flushCreatures`, `_loadedCreatureChunks`, `_flushAccum`, `_syncCreatureChunks`, and the creature branch of the chunked `update` flush block.
- Add `onCreatures: (msg) => this.creatures.applySnapshot(msg.creatures)` to the `WorldAuthorityClient` options; advance creature interpolation each frame; `renderChunked` still draws `this.creatures.all()`.

### `frontend/.../net/WorldAuthorityClient.js` (modify)

- Add an `onCreatures` callback and dispatch the `creatures` message type to it (alongside `joined`/`state`/`pong`/`error`).

### Retired

- `frontend/.../net/creatureClient.js` (fetch/flush) — removed.
- `GET /api/worlds/:id/creatures`, `POST /api/worlds/:id/creatures/flush` — removed.

## Protocol

New server → client message:

```
{ type: "creatures", creatures: [ { id, type, x, y, facing, hp, color } ] }
```

Sent per connected player at ~5 Hz, filtered to that player's 3×3 neighborhood by each creature's current chunk. Player `state` (20 Hz) is unchanged.

## Data model

`world_creatures` and `world_chunks` schemas are unchanged. Ownership changes: the authority now writes `world_chunks` (on activation) and `world_creatures` (spawn insert + position UPDATEs); `GET /chunk` no longer writes either.

## Error handling

- Activation/spawn/load DB errors: fire-and-forget with the in-flight guard; the chunk is retried on the next recompute.
- A creature that roams into an inactive chunk simply stops ticking until reactivated (its last position persists on deactivation).
- Flush failures leave creatures dirty (confirm-before-clear), so an unpersisted position is retried, not lost.
- No client-authoritative fallback (the server owns creatures); if the WS drops, creatures freeze on the client until reconnect (terrain still renders).

## Testing

Backend (`node --test`):
- `creatures.js`: roams on open ground / turns on block against a stub map; freezes when current chunk ∉ active set; `addCreatures` dedup by id; `snapshotForNeighborhood` filters by current chunk; dirty lifecycle (getDirty/clearDirty confirm-before-clear).
- `server.js` integration (in-process ws + fakePool with `world_chunks` insert `RETURNING` + `world_creatures` select/insert/update): a player join activates its neighborhood, spawns+loads a creature, and the client receives a `creatures` message containing it; the creature's position advances over ticks; a second player in a non-overlapping neighborhood does not receive that creature (AOI); the flush issues UPDATEs for dirty creatures.
- `index.js`: `GET /chunk` cache-miss returns generated terrain **without** inserting `world_chunks` (adjust the Phase-2 cache-insert tests); the retired routes are gone.

Frontend (Vitest):
- `CreatureManager.applySnapshot` reconciles to the snapshot (adds new, updates existing by id keeping interpolation origin, removes creatures absent from the snapshot) and interpolates toward targets; the roam/flush/prune tests are removed or replaced.
- `WorldAuthorityClient` dispatches a `creatures` message to `onCreatures`.

## Global constraints

- Reuse `spawnChunkCreatures` and `ServerMap`/`resolveMove` — do not duplicate spawn or collision math.
- Server creature roam constants must match the client's retired roam (`CREATURE_SIZE=48`, `CREATURE_SPEED=40`, `REDIRECT_CHANCE=0.02`, 8-dir set + facings) so behavior is unchanged in feel.
- Active set + AOI + activation key on a creature's **current** chunk (`chunkOf`), never spawn chunk.
- The authority is the sole writer of `world_chunks`; `GET /chunk` never inserts.
- `entity_types WHERE is_creature` query uses `ORDER BY id ASC` (deterministic, matches other tile/entity loads).
- Player authority (Slice 1) is unchanged; the 20 Hz `state` channel is untouched. Creature broadcast is a separate ~5 Hz `creatures` message.
- Creatures cross chunk seams as the same entity (stable id, world-space position).

## Out of scope (→ Slice 3)

Mob AI / aggression / pathfinding / combat; interest management beyond the 3×3 neighborhood; creature interpolation tuning; per-biome spawn-density tuning. Deferred Slice-1 fast-follows (ServerMap LRU cache, dead-socket ping/pong reaper, etc.) remain open.
