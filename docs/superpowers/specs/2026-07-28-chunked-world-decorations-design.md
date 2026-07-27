# Chunked-World Decorations — Design

**Status:** draft for review (from grill-me, 2026-07-28)

## Problem / context

The chunked world (the live game) renders terrain tiles + creatures + walls + ground items + merchants, but **no decorative entities**. Tree / Stone / IceRock exist only in the old hand-authored map system (`map_entities`), whose renderer was deleted in SOMET-210. The map-gen v2 epic built a seeded cluster placer (`placeEntities`) but wired it only to the dead old-map admin endpoint (`POST /api/maps/:id/generate-entities`) — never to live chunk generation, delivery, or rendering. So "bring back tree/stone/ice" and "add bush/rose bush/trees" are one feature: a decoration layer for chunked worlds. See [[movement-collision-architecture]], [[map-gen-epic]], [[connected-chunked-world-epic]].

## Goal

Place, deliver, render, and (optionally per type) collide decorative entities in chunked worlds — deterministically, seamlessly, and data-driven over `entity_types` — reviving Tree/Stone/IceRock and seeding new types (bush, rose bush, tree variants) whose sprites the user generates locally.

## Key facts (verified)

- **Worlds are bounded** (`worlds.width`/`height` in tiles; entry world 30×30, `chunk_size=64`). Placement runs **once over the whole bounded world**, seeded from `world.seed` — seamless by construction, no per-chunk seam problem.
- **`entity_types` already carries decoration fields:** `is_creature`, `walkable`, `spawn_tiles` (jsonb array of tile names), `chance`, `image`, `render_mode`, `display_width/height`, `place_order`. Decoration defs = rows with `is_creature=false` and a non-empty `spawn_tiles`.
- **Existing types are render-ready:** Tree/Stone/IceRock have `image`, `render_mode='static'`, `walkable=false`, and `spawn_tiles` valid for chunked terrain — but `display_width/height=0` (must be set to real sizes).
- The client **fetches** chunk grids (`GET /api/worlds/:id/chunk` → `ChunkStreamer.setChunk`); it does not generate locally. So decorations must be **delivered** in the chunk response.
- Collision is tile-based (`resolveMove` → `map.isWalkable`), duplicated byte-for-byte on client (`ChunkedMap`) and server (`ServerMap`).

## Architecture

One deterministic source of truth for a world's decorations, computed on the server, consumed three ways.

### 1. Placement (server, deterministic, whole-world)

A pure function `worldDecorations(world, decorationDefs) → Map<"cx,cy", [{ name, row, col, walkable }]>` (grouped by chunk for cheap slicing), memoized per world id.

- `decorationDefs` = `entity_types` rows where `is_creature=false` and `spawn_tiles` is non-empty, loaded once at world load (like `creatureTypes`).
- Placement mirrors the seamless global sampling terrain uses (`generateRegion` samples a continuous field from world coordinates): iterate the world's `width×height` tiles, compute a **global** density value per tile (seeded value-noise sampled at absolute `(row,col)`), and place a decoration when the tile's terrain is in a def's `spawn_tiles`, density clears the def's `chance`-derived threshold, and the tile is not excluded (below). This reuses `placeEntities`'s density/clumping idea, adapted to global coordinates and the bounded world (not the local per-chunk grid, which would seam).
- **Determinism:** seeded from `world.seed`; identical inputs → identical output. This is what lets the server and client agree on blocked tiles.
- **Exclusions (hard):** never place a *blocking* decoration on a path tile, a doorway/gate opening, the entry spawn tile, or a village center — else players get walled in. Reuse `placeEntities`'s path exclusion + carved clearings, and add explicit exclusion of doorway/gate cells (`doorwayMouthCells`-style, from the wall/doorway logic) and `world.entry_spawn`.

### 2. Delivery (`/chunk` response)

Extend the response from `{ world_id, cx, cy, data }` to `{ world_id, cx, cy, data, decorations }`, where `decorations` is the placement slice for `(cx,cy)`: `[{ name, row, col }]` in **chunk-local** tile coordinates (matching how `data` is chunk-local). The decoration list is not stored in `world_chunks.data` (tiles only); it is computed from the memoized whole-world placement per request.

### 3a. Server collision overlay

`ServerMap.isWalkable(wx, wy)` returns false when the tile is a terrain wall (as today) **or** a blocking-decoration tile. The server builds a per-chunk blocked-tile set from `worldDecorations` (the `walkable=false` entries) and consults it. `resolveMove` (players + creatures) then blocks/clamps against decorations with zero new collision code — it already clamps against non-walkable tiles.

### 3b. Client render + collision overlay

- `ChunkStreamer` stores each chunk's `decorations` into `ChunkedMap` alongside its grid (`setChunk(cx, cy, grid, decorations)`).
- `ChunkedMap.isWalkable` gains the same overlay: false for a blocking-decoration tile (from the delivered list + the entity type's `walkable` flag, available via the entity-type catalog the client already has from the join frame).
- `RenderSystem` (chunked path) adds decorations to the unified depth-sorted drawable list (`kind:"decoration"`, `depth = depthKey(tileCenterX, tileCenterY)`, `order = place_order`), drawn via the existing `drawEntity` static-image path — so decorations depth-sort correctly with creatures, walls, players, and occlude/are-occluded naturally.

### 4. New types + sprites

Seed new `entity_types` rows (bush, rose bush, and 2–3 tree variants) with `is_creature=false`, per-type `walkable`, `spawn_tiles`, `chance`, `render_mode='static'`, and real `display_width/height`. Set real `display_width/height` on the existing Tree/Stone/IceRock too. **Sprites (the `image`) are generated locally by the user** — the pipeline renders each type as soon as its image exists; until then a new type simply doesn't draw (or draws a placeholder), without breaking anything.

## Data flow

```
world load ─► load decorationDefs (entity_types: is_creature=false, spawn_tiles)
           ─► worldDecorations(world, defs)  [seeded, whole-world, memoized]
                     │
      ┌──────────────┼───────────────────────────┐
      ▼              ▼                             ▼
 ServerMap.isWalkable   GET /chunk → {..., decorations}    (authority)
 blocks decoration          │
 tiles (authority           ▼
 players+creatures)   ChunkStreamer.setChunk(grid, decorations)
                            │
                 ┌──────────┴───────────┐
                 ▼                       ▼
        ChunkedMap.isWalkable    RenderSystem draws
        overlay (client          decorations (drawEntity,
        prediction)              depth-sorted)
```

Client and server block the **same** tiles because both derive from the one deterministic placement (server computes; client receives the slice).

## Determinism & parity

- Placement is a pure seeded function of `(world.seed, width, height, decorationDefs)`. No wall-clock, no RNG outside the seeded stream.
- The client never re-derives placement; it uses the server-delivered slice for both render and walkability, so client/server walkability cannot diverge (same reason the hardened `resolveMove` clamp stays jitter-free).
- Memoization is an optimization only; a cache miss recomputes identically.

## Testing

- **Placement (unit):** deterministic (same seed → identical placement); respects `spawn_tiles` (only on allowed terrain); density clumps (not uniform); **exclusions** — no blocking decoration on a path/doorway/gate/entry-spawn cell (property test over a seeded world).
- **Collision overlay (unit):** `ServerMap`/`ChunkedMap` `isWalkable` returns false on a blocking-decoration tile and true on a passable (`walkable=true`) decoration tile; a player `resolveMove` clamps against a decoration exactly as against a wall tile.
- **Delivery (integration):** `/chunk` returns `decorations` in chunk-local coords; the slice for a chunk matches the whole-world placement restricted to that chunk.
- **Render (unit, mock-ctx):** a chunk with decorations adds `drawEntity` calls in depth order; passable vs blocking types both render.
- **Browser (required gate):** decorations visible in the world (tree/stone/ice), clumped naturally, no seams at chunk borders, block movement (walk-around) where `walkable=false`, and never block a doorway/gate/spawn.

## Non-goals

- **Per-entity sub-tile colliders** — collision is whole-tile via the walkability overlay (chosen in grill).
- **Unbounded worlds** — placement targets bounded worlds (all live worlds are bounded); unbounded handling is deferred.
- **Destructible / interactive decorations** (chop a tree, mine a stone) — visual + collision only.
- **New-type sprite generation** — the user's local task; the pipeline is sprite-agnostic.
- **Reviving the old `map_entities` renderer** — that system stays dead; this is chunked-world native.

## Open items (confirm during planning)

1. **New-type list + spawn rules:** proposed — `bush` (walkable=true, spawn grass/highgrass, chance ~0.3), `rose_bush` (walkable=true, spawn grass/highgrass, chance ~0.1), `pine_tree` + `dead_tree` (walkable=false, spawn leafs/earth/snow). Confirm names/flags/tiles.
2. **Display sizes:** set `display_width/height` for all decoration types (existing 0 → e.g. Tree 64×96, Stone 48×48, IceRock 48×48, bush 40×40). Confirm the anchor (feet-at-tile like creatures).
3. **Density tuning:** starting `chance`/clump params; verify decorations don't over-clutter or wall off open ground (browser-tune).
4. **Placement storage:** memoized in-memory vs a `world_decorations` cache table. Recommend memoized (deterministic regen); revisit only if placement recompute cost shows up.
5. **`/chunk` caching interaction:** confirm how the existing `world_chunks` DB cache path composes with per-request decoration slicing.
6. **Client decoration-type metadata:** the client needs each decoration type's `image`, `walkable`, and display size. Verify the join frame's entity-type catalog includes non-creature (decoration) types; if it's creature-types only, either extend it to include decoration types or carry `walkable` (and an image key) on each delivered decoration entry. This is a correctness dependency for both render and the client walkability overlay.

## Suggested slicing (for the plan)

Even as one plan, tasks decompose cleanly:
- **A. Placement core** — `worldDecorations` (seeded, global, exclusions) + unit tests.
- **B. Server collision overlay** — `ServerMap.isWalkable` blocks decoration tiles; `resolveMove` regression.
- **C. Delivery** — `/chunk` returns `decorations`; integration test.
- **D. Client ingest + collision** — `ChunkStreamer`/`ChunkedMap` store + `isWalkable` overlay (mirror B).
- **E. Client render** — decorations in the RenderSystem depth sort via `drawEntity`; mock-ctx test.
- **F. Types + seed** — migration: fix display sizes, seed new types + spawn rules.
- **G. Browser verification.**
