# Minimap HUD — Design

**Date:** 2026-07-25
**Status:** Approved (brainstorm), pending implementation plan
**Surface:** `frontend/src/games/something2` (client HUD) + `backend/src` (overview endpoint)

## Goal

Add an always-on, toggleable minimap to the in-game HUD, pinned to the top-right
corner **below the fullscreen icon**. It shows a coarse overview of the terrain
around the player (a layered map: overview base + a live marker layer) with the
player, nearby creatures, doorways/portals, and villages plotted on top. Clicking
it expands to a larger map.

## Context (existing code this builds on)

- The world is an **isometric, server-streamed chunked world**, effectively
  unbounded. Only a neighborhood of chunks around the player is loaded at any time.
- `Game` (`src/js/core/Game.js`) owns live state: `player` (world-pixel `x`/`y`,
  `width`/`height`), `camera`, `chunkedMap` (`ChunkedMap`, a `Map` of loaded chunk
  grids of tile-type names), and `creatures` (`CreatureManager`).
- A prior-art iso minimap renderer already exists for the **pre-game** world
  picker: `src/js/systems/mapPreviewRenderer.js` (pure `isoFit` / `tileToScreen` /
  `draw`) consumed by `WorldPreview.jsx`, backed by
  `GET /api/worlds/:id/preview` → `generateWorldPreview` (a fixed **64×64 tile
  window centered on world origin (0,0)**, not player-centered, cached per world).
- The fullscreen toggle (`Something2.jsx`) is `position:absolute; top:16; right:16;`
  40×40, rendered only while `isPlaying`, and lives **inside `contentRef`** (the
  element that goes fullscreen). Help button is `z-index:300`, Pause overlay `100`.
- Creatures carry `{ x, y (world pixels), facing, type, color }`
  (`CreatureManager.applySnapshot` / `.all()`).
- Player **facing is not a stored field** — the renderer derives it; the minimap
  reuses the same last-movement/aim source when building the snapshot.

## Chosen approach

**Iso minimap, overview base + live markers** (Approach 1 of 3 considered).

Rejected alternatives:
- *Top-down renderer* — more legible as a pure nav aid but visually inconsistent
  with the iso game and reuses none of the existing renderer.
- *Fully layered (overview + live loaded-chunk terrain + markers)* — sharpest
  near-field detail but requires keeping two iso terrain layers aligned at high
  per-frame cost, for detail barely visible at minimap scale. If crisp local
  detail is later wanted, add the live-chunk layer to the **expanded modal only**.

## Components (new)

| Component | Location | Responsibility |
|---|---|---|
| `Minimap.jsx` | `frontend/src/games/something2/` | HUD canvas + toggle button + expand modal. Own rAF loop. Rendered by `Something2.jsx` only while `isPlaying`, **inside `contentRef`**. |
| `minimapRenderer.js` | `frontend/src/games/something2/src/js/systems/` | Pure iso draw with player-centered pan + marker layer. Reuses/extracts shared `isoFit`/`tileToScreen` from `mapPreviewRenderer.js` (extract to a shared module rather than copy). |
| `Game.getMinimapSnapshot()` | `frontend/src/games/something2/src/js/core/Game.js` | Returns a plain live-state object; keeps Game the single source of truth. |
| `worldOverviewClient.js` | `frontend/src/games/something2/src/js/net/` | Dependency-free fetcher + client-side region cache (node-testable, mirrors `worldPreviewClient.js`). |
| `GET /api/worlds/:id/overview` | `backend/src/index.js` (+ `services/mapService.js`) | Player-centered coarse terrain + in-region doorways/villages. |

## Data flow

1. `Minimap.jsx` runs its **own `requestAnimationFrame` loop** (independent of the
   engine loop, same pattern as `WorldPreview.jsx`). Each frame it calls
   `gameRef.current.getMinimapSnapshot()` and redraws the marker layer — cheap,
   always live.
2. **Base terrain is fetched lazily.** Snap the player's world position to a coarse
   region grid. When the player crosses into a new region (or nears the loaded
   region's edge margin), fetch that region **once** and cache it. Between fetches
   the cached grid pans under the player — no per-frame network.
3. On a **portal transition** (a new `worldId` appears in the snapshot), clear the
   cache and fetch the new world's region.

`getMinimapSnapshot()` shape:

```js
{
  worldId,            // string — current world; change signals a transition
  chunkSize,          // number — tiles per chunk
  player: { x, y, facing },       // world pixels; facing from last movement/aim
  creatures: [{ x, y, color }],   // world pixels
  doorways: [...],    // optional; primarily supplied by the overview endpoint
  villages: [...],    // optional; primarily supplied by the overview endpoint
}
```

Doorways/villages for the terrain layer come from the **overview endpoint**
(authoritative, region-scoped); the snapshot only needs live entities.

## Backend overview endpoint

`GET /api/worlds/:id/overview?cx=<centerTileCol>&cy=<centerTileRow>`

- Reuses `generateRegion(world, rMin, cMin, rows, cols)` at a **downsample step**
  (default **step 4** — sample every 4th tile) over a region **larger than the
  minimap viewport** (default **~384 tiles → 96 coarse cells per side**) so panning
  is smooth without refetching each step.
- Center coords are **snapped to a fixed grid** (server- or client-side) so the
  cache actually hits; the client only refetches when the snapped region changes.
- Response:
  ```json
  {
    "world_id": "...",
    "step": 4,
    "originCol": <int>, "originRow": <int>,
    "tiles": [["grass", ...], ...],
    "doorways": [ ... ],
    "villages": [ ... ]
  }
  ```
- **Cached** keyed by `(worldId, snappedRegion, step)`, mirroring the existing
  `worldPreviewCache` pattern. Doorways/villages are filtered to the region
  (reuse `fetchLinks` / `fetchVillages` as the origin-preview route does).

## Rendering

- Iso projection; player tile centered in the minimap viewport. Terrain drawn from
  the cached coarse grid via the extracted `isoFit`/`tileToScreen` helpers.
- **Marker layer**, drawn each frame over terrain:
  - **Player** — centered, small facing triangle.
  - **Creatures** — dots using `creature.color`.
  - **Doorways/portals** — a distinct portal glyph.
  - **Villages** — a landmark glyph.
- Fixed size **180×180**, rounded-square clip, DPR-scaled like `WorldPreview`.
- The **expand modal** reuses the same renderer at a larger canvas + wider region.

## Placement & interaction

- Position: `position:absolute; right:16px; top:~64px` (clears the 40px fullscreen
  toggle at `top:16` plus a gap). `z-index` above the game canvas, below Help (300)
  and Pause (100). `pointer-events:auto`.
- **Toggle:** `M` key **and** a button on the minimap. Visible/hidden state
  persisted to `localStorage` so it survives reloads.
- **`M` key reassignment:** `M` currently cycles the *dev* render-mode override
  (`Game.js:680`). Move that dev toggle to **`Shift+M`**; `M` now toggles the
  minimap. (The `t` tile-texture dev toggle is unaffected.)
- **Click → expand modal:** larger centered map, same render, close on click-out or
  Esc. **Esc precedence:** when the modal is open, Esc closes the modal and must
  **not** also fire the game's Esc→pause handler.

## Error & edge handling

- Overview fetch fails → draw the marker layer over a neutral empty background with
  a subtle "map unavailable" note; retry with backoff.
- Only mounted while `isPlaying`; nothing drawn in menu/admin tabs.
- Lives inside the fullscreen element, so it persists in fullscreen.
- Portal transition clears the region cache (see Data flow #3).

## Testing

**Unit**
- `minimapRenderer` pan + marker placement math (pure functions).
- `worldOverviewClient` region-key snapping + cache hit/miss/eviction logic.
- Backend overview: downsample correctness (cell `[r][c]` == world tile at
  `originRow + r*step, originCol + c*step`) and doorway/village region filtering.
- `Game.getMinimapSnapshot()` returns the documented shape from live state.

**Browser verification** (per project norm — a green suite is not sufficient)
- Minimap renders below the fullscreen icon while playing.
- Terrain follows the player; creatures move live.
- `M` toggles the minimap; `Shift+M` still cycles dev render-mode.
- Click expands to the modal; Esc closes the modal **without** pausing the game.
- Survives a portal transition (new world's terrain loads) and fullscreen.

## Out of scope (YAGNI)

- Fast-travel / click-to-teleport (no such game mechanic exists).
- Hover tooltips / tile inspection on the minimap.
- Live loaded-chunk terrain detail layer (deferred; candidate for the expand modal
  only, if ever needed).
- Zoom controls beyond the single expand modal.

## Decisions to record (for project memory, post-merge)

- `M` → minimap; dev render-mode override moved to `Shift+M`.
- Overview endpoint is **player-centered and downsampled**, distinct from the
  origin-only `preview` endpoint; both caches coexist.
