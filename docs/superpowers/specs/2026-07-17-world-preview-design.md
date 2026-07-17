# World Preview (Worlds Browser)

**Date:** 2026-07-17
**Status:** Design approved, ready for implementation plan
**Relates to:** the connected chunked-world epic (SOMET-53). Independent of Phase 6 Slice 3 (mob AI) — its own sub-project.

## Context

The Worlds browser panel (`frontend/src/games/something2/Something2.jsx`) lists worlds and lets the user select one and Enter it. Legacy single maps get a live iso thumbnail via `MapPreview.jsx` (fetches a finite tile grid, renders with `src/js/systems/mapPreviewRenderer.js` `isoFit`/`draw` + a `tileColors` map). Worlds have **no** preview — the pane shows a placeholder ("Select a world to preview it, then Enter World.").

Worlds are **infinite** (deterministic procedural terrain from a seed, generated per chunk via `mapService.generateChunk`/`generateRegion`/`sampleBiome`). This feature adds a preview of a bounded, wide, downsampled biome overview of a selected world, reusing the existing preview renderer.

## Goal

When a world is selected in the Worlds browser, show a thumbnail overview of its generated terrain: a wide, downsampled biome map centered on origin, generated deterministically from the world's seed and rendered with the existing iso preview renderer.

## Locked decisions (from brainstorming)

1. **Extent** = a wide downsampled biome overview centered on origin. Output `dim = 64` cells per side, `stride = 8` world tiles per cell → the preview spans `64*8 = 512` world tiles (~8 chunks at chunk_size 64). Biomes only; thin 1-tile paths are not overlaid (accepted at this zoom).
2. **Cache** = in-memory memo per world id in the backend (deterministic per seed/config; no migration, no DB table).
3. **Rendering** = reuse the existing `mapPreviewRenderer.js` (`isoFit`/`draw`) + the existing `tileColors` map; a new `WorldPreview.jsx` mirrors `MapPreview.jsx`.

## Architecture

A pure generator samples the biome field directly at strided coordinates (only the output cells are computed, so cost is fixed at `dim*dim` samples regardless of extent). A thin HTTP route serves the grid; a React component fetches and renders it with the shared renderer.

## Components

### `backend/src/services/mapService.js` — `generateWorldPreview(world, dim, stride)`

New pure, exported function:

- `world = { seed, chunkSize, tileTypes }` (same shape `generateChunk` takes).
- Build `cfg = worldConfig(world)` once.
- Center the sampled window on origin: `start = -Math.floor(dim / 2) * stride` (so the middle cell is near global tile 0,0).
- For each output cell `(pr, pc)` in `[0, dim)`: `gRow = start + pr * stride`, `gCol = start + pc * stride`; `grid[pr][pc] = sampleBiome(cfg, gRow, gCol)`.
- Returns `string[][]` of size `dim × dim` (biome tile names; the path tile is excluded by `sampleBiome`, consistent with "biomes only").
- Deterministic: same `world`/`dim`/`stride` → identical grid.

Add `generateWorldPreview` to `module.exports`.

### `backend/src/index.js` — `GET /api/worlds/:id/preview`

- Load the world row (`SELECT * FROM worlds WHERE id = $1`); 404 if absent.
- `tileTypes = await getTileTypesMap()`.
- Constants: `PREVIEW_DIM = 64`, `PREVIEW_STRIDE = 8`.
- In-memory memo: `worldPreviewCache: Map<world_id, data>` (module-level). On hit, return the cached grid; on miss, `generateWorldPreview({ seed: Number(world.seed), chunkSize: world.chunk_size, tileTypes }, PREVIEW_DIM, PREVIEW_STRIDE)`, store, return.
- Response: `{ world_id, data }` where `data` is the `64×64` tile-name grid.
- Cache note: the memo is keyed only by world id; if a world's seed/chunk_size are immutable after creation (they are — no update route mutates them), the memo never goes stale. Tile-type color/name changes do not change biome *names* selected by `sampleBiome` (it keys off `worldConfig(world).biomeNames` = tile-type names), so a preview grid of names stays valid; only the client-side colors would change, which are applied at render time from live `tileColors`. (If tile types are renamed/deleted the memo could reference a stale name; acceptable for this feature — the renderer falls back gracefully for an unknown color.)

### `frontend/src/games/something2/WorldPreview.jsx`

Mirror `MapPreview.jsx`, but for a world:

- `WorldPreview({ worldId, tileColors })`.
- `useQuery({ queryKey: ['worldPreview', worldId], enabled: !!worldId, queryFn: () => fetchWorldPreview(worldId) })` → returns `{ world_id, data }`.
- Parse `data` into a `tiles` grid (already a `string[][]`; no entities).
- Render with the same animation-loop structure as `MapPreview` using `isoFit`/`draw` from `src/js/systems/mapPreviewRenderer.js`, passing `{ tiles, tileColors, entities: null, fit, revealProgress }`. Reuse the reveal + idle-drift loop (or a simplified static draw — reveal is optional polish).
- Loading/error/empty overlays like `MapPreview` ("Loading preview…" / "Preview unavailable" / "No preview").

### `frontend/src/games/something2/useWorlds.js` — `fetchWorldPreview(worldId)`

Add a fetcher: `GET ${API_URL}/api/worlds/${worldId}/preview` → JSON `{ world_id, data }`; throw on non-ok (consistent with the existing world/creature fetchers).

### `frontend/src/games/something2/Something2.jsx` — wire into the preview pane

In the preview-pane block (currently: `MapPreview` when `selectedMapId`, else the "Select a world…" placeholder), add a branch: when `selectedWorldId` is set (and not `selectedMapId`), render `<WorldPreview worldId={selectedWorldId} tileColors={tileColors} />`. Keep the placeholder only when neither a map nor a world is selected.

## Data flow

Select world → `WorldPreview` queries `GET /api/worlds/:id/preview` → backend returns the memoized/generated 64×64 biome-name grid → component renders iso diamonds via the shared renderer using `tileColors`.

## Error handling

- Unknown world → 404 → component shows "Preview unavailable".
- Empty tile types → `worldConfig` throws ("tileTypes is empty"); the route catches and returns 500; component shows "Preview unavailable".
- Unknown biome name in `tileColors` at render → the renderer's existing fallback (skip/neutral color) applies; no crash.

## Testing

Backend (`node --test`):
- `generateWorldPreview`: deterministic (same seed → identical grid); dimensions are `dim × dim`; every cell is one of `worldConfig(world).biomeNames`; a different seed yields a different grid; stride/center math places the middle cell at/near global tile 0.
- `GET /api/worlds/:id/preview` (via `__setPool` mock): returns `{ world_id, data }` with a `64×64` grid; 404 for an unknown world; a second request for the same world returns the memoized grid (assert the world row is queried once, or that the result is identical).

Frontend (Vitest):
- `fetchWorldPreview` builds the right URL and throws on non-ok.
- `WorldPreview` renders a canvas without crashing given a mocked grid; shows the loading overlay before data and the error overlay on query error. (Canvas drawing itself need not be pixel-asserted — mirror the depth of the existing `MapPreview` coverage, which is light.)

## Global constraints

- The preview generator reuses `worldConfig`/`sampleBiome` — no duplicated biome math.
- Preview is deterministic per world seed + `chunk_size`; the in-memory memo is keyed by world id.
- Rendering reuses `mapPreviewRenderer.js` + the existing `tileColors`; no new rendering engine.
- `PREVIEW_DIM = 64`, `PREVIEW_STRIDE = 8` (biome overview ~8 chunks wide).
- The preview is biome-only (no path overlay), centered on origin.
- No new migration / DB table.

## Out of scope

Path overlay in the preview; a "you are here" / spawn marker; explored/fog-of-war (discovered) maps; per-row thumbnails (single selected-world preview only); live updates as the world is explored.
