# Connected Chunked World — Seamless Streaming Overworld

**Date:** 2026-07-16
**Status:** Design approved, pending spec review
**Author:** brainstorming session

## Problem

Today every map in `something2` is generated in complete isolation
(`mapService.generateWorld` builds one `rows × cols` grid from a seed; each
`maps` row is standalone). Two maps can never share an edge, actors live on
exactly one `map_id` (`engine_players.map_id`, `map_entities.map_id`), and there
is no notion of maps being adjacent or of crossing between them.

We want:

1. **Connected maps whose terrain matches at every shared edge** — "all terrain
   is same by connected side."
2. **Players and creatures that travel between them** — seamlessly, with
   creatures able to follow the player across a boundary.

## Approach chosen

**Grid-of-chunks, seamless streaming, world-space free-roaming creatures.**

Decision record:

- **Topology: grid of chunks** (one seamless continent split into
  coordinate-addressed chunks) — the only model that satisfies "terrain same by
  connected side." Hand-linked portals were rejected for this epic (they don't
  require matching terrain); they can be layered on later for special places
  (caves, towns) without redoing this work.
- **Crossing style: seamless streaming** — neighbor chunks render around the
  player; crossing a seam is invisible (no load, no reposition). Chosen over
  discrete edge-transition and screen-scroll for the open-world feel.
- **Creatures: free roamers in world-space** — creatures have world-space
  positions and cross seams like the player. A wolf can follow you from one
  chunk into the next.
- **Chunk size: 64 × 64 tiles** (≈ 6400 world px at `MAP_TILE_SIZE = 100`,
  roughly the current `WORLD_WIDTH/HEIGHT` of 10000). Configurable per world.
- **Engine authority deferred** — the client already predicts movement locally
  (`Player.update(dt, keys, this.map)` runs every frame; the Go engine is
  optional, `if (this.engine && this.engine.joined)`, and only reconciles).
  Seamless streaming is therefore built **client-authoritative**; the frozen,
  per-`map_id` Go engine is not touched in this epic.

## Key insight

Stop generating maps in isolation; generate a single **infinite deterministic
field** and view it through chunk-sized windows.

If terrain is a pure function of **absolute world coordinates**
`f(worldSeed, globalRow, globalCol)`, then chunk `(cx, cy)`'s east edge column
and chunk `(cx+1, cy)`'s west edge column are *the same samples of the same
field*. Seams match **by construction** — there is no stitching or
edge-matching code to get wrong. This is the Minecraft-style trick: chunks are
just a windowing of one global function.

The current `valueNoise` builds a per-map lattice indexed by local `(r, c)`. The
core refactor is to index the lattice by absolute world coords so any chunk is
derivable independently and identically.

## Architecture — build phases

Each phase is independently shippable and testable.

### Phase 1 — Deterministic global world field *(backend, pure)*

Refactor generation so the biome field, carved paths, and object-density noise
are all sampled by **absolute world tile coords** rather than per-map local
coords.

- `globalValueNoise(worldSeed, globalRow, globalCol, cellSize)` — samples a
  lattice keyed by absolute coordinate. Lattice cell values are derived by
  hashing `(worldSeed, latticeRow, latticeCol)` (not stored per-map), so any
  point is reproducible without generating neighbors.
- `generateChunk(world, cx, cy)` returns an `N × N` tile grid for the window
  `rows [cy·N, cy·N+N)`, `cols [cx·N, cx·N+N)`.
- Paths: carved from a **global** path graph so trails cross seams and line up.
  v1 approach — deterministic path anchors on a coarse world lattice, walks
  between neighbors computed in world-space; each chunk renders the portion of
  those walks passing through its window. (Falls back to no paths if no
  path-like tile exists, matching current `detectPathTile` behavior.)
- Object-density noise sampled globally too, so clumps/clearings are consistent
  across seams.

**Acceptance:** unit test proves `generateChunk(cx,cy)` east column ===
`generateChunk(cx+1,cy)` west column, and south row === north row of
`(cx,cy+1)`, byte-for-byte, for several seeds and coordinates. **This phase
alone delivers requirement 1 (matching seams).**

### Phase 2 — World & chunk model *(backend + schema)*

- New `worlds` table: `id (uuid)`, `name`, `seed (bigint)`,
  `chunk_size (int, default 64)`, timestamps.
- New `world_chunks` table: `(world_id, cx, cy)` unique, `data (jsonb)`,
  materialized-on-demand cache of `generateChunk`. Entity edits and any future
  authored overrides persist here.
- API: `GET /api/worlds/:id/chunk?cx=&cy=` — returns the chunk, generating +
  caching on first request. `POST /api/worlds` — create a world (name + seed).
- Existing standalone `maps` / `map_entities` remain untouched (legacy + the
  map/entity editor keep working exactly as now).

### Phase 3 — World-space coordinates *(shared util)*

- One small shared module (usable by backend and frontend):
  `chunkOf(worldPx, chunkSize)`, `chunkOrigin(cx, cy, chunkSize)`,
  `worldToChunkLocal(worldX, worldY)`.
- Actors get continuous **world-pixel** positions spanning all chunks, not
  per-`map_id` local coords.
- Client `ChunkedMap`: presents `getTileAt(worldX, worldY)`,
  `isWalkable(worldX, worldY)`, `speedAt(...)` across the currently-loaded chunk
  neighborhood, so the existing client-side collision/prediction in
  `Player.update` works over seams with no change to its call shape.

### Phase 4 — Client streaming + multi-chunk render *(frontend)*

- Client keeps a 3 × 3 chunk neighborhood around the camera. When the player
  crosses into a new chunk, load the newly-adjacent ring (via the Phase 2 API,
  TanStack Query cached) and drop the far ring.
- `RenderSystem` / `Map` iterate loaded chunks and draw them in world→screen iso
  projection (`worldToScreen` already exists; the camera is already screen-space
  centered on the player).
- Depth-sort across chunk boundaries so entities/objects near a seam sort
  correctly against the neighbor chunk's tiles.

**Acceptance:** player walks across a seam with no visible load and no
reposition; frame budget holds with a 3×3 neighborhood loaded.

### Phase 5 — World-space free-roaming creatures *(frontend + schema)*

- Creatures carry world coords (`world_id`, world-pixel `x`, `y`) rather than a
  `map_id` + local coords.
- The client simulates/roams creatures within the loaded neighborhood; creatures
  that wander out of range freeze and persist (position saved), and resume when
  their chunk re-enters the neighborhood.
- Creatures cross seams as the *same* entity (no despawn/respawn) — a wolf
  follows the player into the next chunk.

**Acceptance:** a creature placed near a seam walks across it and remains the
same entity on the far side.

### Phase 6 — Engine world-awareness *(DEFERRED — not in this epic)*

Authoritative multiplayer + server-side mob migration across chunks. The Go
engine is frozen and strictly per-`map_id`; making it region/world-aware is a
separate epic. Phases 1–5 are client-authoritative and do not depend on it.
Recorded here so the boundary is explicit.

## Data flow

```
world (seed, chunk_size)
   │  generateChunk(world, cx, cy)   ← pure, deterministic, seams match
   ▼
world_chunks cache  ──GET /api/worlds/:id/chunk──▶  client chunk store (3×3)
                                                        │
                                                        ▼
                                        ChunkedMap.getTileAt(worldX,worldY)
                                                        │
                          Player.update (client prediction) ── collision ──┐
                                                        │                  │
                                              RenderSystem (multi-chunk)◀───┘
```

## Testing strategy

- **Phase 1 (pure):** seam-equality tests (east/west, north/south columns match
  across adjacent chunks); determinism (same coords + seed → same tiles);
  path-continuity across a seam; no-path-tile fallback.
- **Phase 2:** chunk API returns deterministic data; second request served from
  `world_chunks` cache; create-world happy path + validation.
- **Phase 3:** `chunkOf`/`chunkOrigin`/`worldToChunkLocal` round-trip;
  `ChunkedMap.getTileAt` resolves correctly across a loaded neighborhood
  including negative coordinates.
- **Phase 4:** neighborhood load/unload ring logic (unit); seam-cross render
  smoke (no reposition). Manual browser verification at `/game-something2`.
- **Phase 5:** creature crosses a seam as the same entity; freeze/persist +
  resume when chunk re-enters range.

## Out of scope (this epic)

- Authoritative multiplayer / server-side simulation across chunks (Phase 6).
- Hand-linked portals for special interiors (caves, towns) — future, additive.
- Infinite vertical/biome progression tuning beyond what the global field
  already yields.
- Migrating existing standalone `maps` into worlds (they remain independent).

## Risks / open items

- **Path continuity across seams** is the trickiest part of Phase 1; the global
  path-graph approach must be validated by the continuity test before Phase 4
  rendering depends on it.
- **Render performance** with a 3×3 neighborhood of 64×64 chunks (12k tiles)
  must hold 60fps; offscreen chunk baking (already used in `MapPreview`) is the
  mitigation if needed.
- **Creature persistence model** (Phase 5) — where frozen out-of-range creatures
  are stored (client memory vs. `world_chunks` payload vs. a creatures table) is
  decided at Phase 5 planning time; entity schema carries world coords from the
  start to avoid a rewrite.
