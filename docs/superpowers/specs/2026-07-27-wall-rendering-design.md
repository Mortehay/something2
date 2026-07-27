# Wall Rendering & Occlusion — Design

**Date:** 2026-07-27
**Status:** Approved (brainstorm), pending implementation plan
**Surface:** `frontend/src/games/something2` (renderer + admin) + `backend/src` (schema, CRUD, serialization)

## Goal

Render wall tiles as **3D wall blocks with height** instead of flat ground, make players and creatures **hide behind walls** (occlusion), and **fade an occluding wall to 0.3 opacity** so an actor behind it stays visible (a reveal bubble). Walls, ground tiles, and entities share one depth-sorted pass, with a per-object `place_order` override for manual "who is upper / who is lower" control.

## Context (current pipeline)

- Isometric is a **rendering projection only** (`core/iso.js`: `worldToScreen`/`screenToWorld`, 2:1 diamond, `ISO_TILE_W=128`, `ISO_TILE_H=64`). Game logic/collision stay in world-pixel space.
- `RenderSystem.renderChunked` draws in two passes: **(1)** every visible tile as a **flat diamond** (`chunkTileCells` → `resolveTileVisual` → `drawImage` of a 128×64 crop at `s.x−halfW, s.y−halfH`), then **(2)** entities (players, remote players, creatures, ground items, merchants) depth-sorted by iso `(x+y)` via `buildDrawables`. Because tiles are a separate earlier pass, **a wall can never occlude an entity today** — entities always paint over all tiles.
- Wall tiles are classified only on the **backend**: `STRUCTURAL_TILES = {map_wall, map_doorway, wooden_wall, village_gate}` in `services/mapService.js`. `map_wall`/`wooden_wall` are solid walls; `village_gate`/`map_doorway` are passable gates. The **frontend has no wall concept**.
- `tile_types` columns: `name, color, walkable, speed, prompt, sprite, render_mode ('color'|'static'|'animated'), image`. `entity_types` mirror the sprite/render_mode pattern. **No height or ordering field exists.**
- Wall art is a flat top-down diamond texture (see the in-game brick pattern), not wall-face art.

## Decisions (from brainstorm)

- **Data-driven**, not hardcoded: wall-ness lives on the tile type.
- **All four structural tiles** render tall (walls + gates); gates just get a shorter height.
- **Full solution**: real wall height (bodies hide) + one unified depth sort + a `place_order` override knob.
- **Wall style**: extruded block, **textured sides** (top texture + skewed texture on vertical faces, shaded).
- **See-through**: **reveal bubble** — walls within radius `R` of any actor fade to 0.3 (players and creatures alike).

## Data model

Two new columns; both default to values that leave today's rendering byte-identical.

| Column | Type | Default | Meaning |
|---|---|---|---|
| `tile_types.wall_height` | int | `0` | Screen px a tile rises. `0` = flat ground (unchanged). `>0` = wall block that tall; joins the occlusion sort. |
| `tile_types.place_order` | int | `0` | Manual layer/tiebreak (see Unified sort). |
| `entity_types.place_order` | int | `0` | Same, for creatures. |

- **Migration** adds the three columns.
- **Serialization**: the `/api/map/tiles` payload (tile defs the client renders from) and `/api/map/config` (entity types) must include the new fields; tile/entity **CRUD** endpoints accept and persist them.
- **Admin UI**: `TileTypesAdmin` gets `wall_height` + `place_order` inputs; `EntityTypesAdmin` gets `place_order`.
- **Seed update** (idempotent): `map_wall`/`wooden_wall` → `wall_height = 48`; `village_gate`/`map_doorway` → `wall_height = 24`. All other tiles stay `0`.

## Wall rendering — `systems/wallRenderer.js` (new, pure)

Given a wall tile's diamond center screen point `s = worldToScreen(cx, cy)`, half-extents `halfW=64`, `halfH=32`, and height `H = def.wall_height`:

- **Top face** — the tile's diamond texture (existing `resolveTileVisual` crop) drawn at `s.y − H` (i.e. the flat diamond, lifted up by `H`). Cacheable via the existing `TileDiamondCache`.
- **Vertical faces** — the two camera-facing edges (south-west and south-east) of the diamond, extruded straight down by `H` into parallelograms:
  - Left (SW) face corners: `(s.x−halfW, s.y−H)`, `(s.x, s.y+halfH−H)`, `(s.x, s.y+halfH)`, `(s.x−halfW, s.y)`.
  - Right (SE) face corners: `(s.x, s.y+halfH−H)`, `(s.x+halfW, s.y−H)`, `(s.x+halfW, s.y)`, `(s.x, s.y+halfH)`.
  - Painted with the tile texture mapped onto the parallelogram via an affine `setTransform` (3 corners define the matrix), then overlaid with a translucent black shade — left face lighter, right face darker — as a depth cue. If the tile has no image (`render_mode==='color'`), faces fall back to shaded `def.color`.

Exports (pure, canvas-free where possible):
- `wallFaces(s, halfW, halfH, H)` → `{ topDiamond, leftFace, rightFace }` corner arrays (unit-testable geometry).
- `drawWall(ctx, { s, def, visual, H, alpha, tileCache })` → void (issues the canvas calls).

Collision is unchanged — walls are already non-walkable on the backend; this is pure rendering.

## Unified depth sort with `place_order`

`renderChunked` becomes:

1. **Pass A — floor.** Draw every visible tile with `wall_height === 0` **and** `place_order === 0` as a flat diamond, exactly as today (always behind everything).
2. **Pass B — sorted.** Build one drawable list:
   - **wall drawables**: visible tiles with `wall_height > 0` **or** `place_order !== 0`, each tagged `{ kind:'wall', ...cell, depth: depthKey(cell.worldX, cell.worldY), order: def.place_order||0 }`.
   - **entity drawables**: the existing player / remote / creature / grounditem / merchant set from `buildDrawables` (+ ground items + merchants), each carrying `order` (0 for players/items/merchants; `entity.place_order||0` for creatures).
   - Sort by **`order` asc, then `depth` asc**; draw back-to-front (later = on top). Default `order 0` everywhere ⇒ pure iso-depth sort ⇒ automatic correct occlusion (wall in front of actor paints over it; actor in front of wall paints over it). `place_order` overrides only when set.

This keeps the whole-map tile cost in the cheap flat Pass A; Pass B grows only by **on-screen wall tiles + on-screen entities**.

## See-through reveal bubble

Radius `R = 150` px (≈1.5 tiles). While drawing each Pass-B **wall** drawable:

- Compute whether any actor (player, remote players, creatures) has its center within `R` of the wall tile center **and** satisfies `wallDepth ≥ actorDepth` (the wall is not behind that actor — i.e. it could actually be occluding it).
- If so, draw that wall at `globalAlpha = 0.3`; otherwise fully opaque.

The "not behind" filter keeps walls an actor merely stands in front of from fading. Pure predicate `wallRevealed(wallCell, actors, R)` is unit-testable.

## Performance

- Pass A is unchanged (bulk flat tiles). Pass B adds only visible walls + entities, both already viewport-culled.
- Top faces reuse `TileDiamondCache`; side faces are drawn per wall with one `setTransform` + `drawImage` + a shade rect each. The affine-textured sides are the main added per-wall cost — acceptable for the on-screen wall count; revisit only if a dense walled village drops frames (fallback: shaded-color sides).
- The reveal-bubble check is O(on-screen walls × on-screen actors); both are small.

## Testing

**Unit (pure, Vitest)**
- `wallFaces`: top diamond + the two face parallelogram corners for a given `s`, `H` (exact coordinates).
- Pass-B comparator: sorts by `place_order` then depth; equal-order falls back to depth; a higher `place_order` always draws later.
- `wallRevealed`: in-radius + not-behind ⇒ true; in-radius but behind the actor ⇒ false; out-of-radius ⇒ false.
- Serialization: tile/entity payloads include `wall_height`/`place_order`; CRUD round-trips them.

**Browser (per project norm — a green suite is not sufficient)**
- Walls render with visible height and textured faces (not flat).
- Walk behind a wall → body hidden; walk in front → visible; stand behind → the covering wall fades to 0.3; creatures behind a wall fade it too.
- A `place_order` override visibly reorders a tile/entity vs its neighbors.
- Gates render shorter than walls.
- Frame rate holds inside the walled village.

## Out of scope (YAGNI)

Per-pixel silhouette fade (whole occluding wall tile fades instead), auto-generated dedicated wall-face art, wall shadows/dynamic lighting, and multi-tile/stacked heights.

## Files

| File | Change |
|---|---|
| `backend/migrations/<ts>_wall_render_fields.js` | add `wall_height`, `place_order` to `tile_types`; `place_order` to `entity_types`. **Pick a timestamp strictly greater than the latest existing migration** (this repo has had a migration-timestamp collision before) — verify with `ls backend/migrations` first. |
| `backend/src/services/mapService.js` (+ tile/entity CRUD, `/api/map/tiles`, `/api/map/config`) | persist + serialize the new fields; idempotent seed of wall/gate heights |
| `frontend/src/games/something2/TileTypesAdmin.jsx` | `wall_height` + `place_order` inputs |
| `frontend/src/games/something2/EntityTypesAdmin.jsx` | `place_order` input |
| `frontend/src/games/something2/src/js/systems/wallRenderer.js` (new) | `wallFaces`, `drawWall` |
| `frontend/src/games/something2/src/js/systems/RenderSystem.js` | Pass A / Pass B split; wall drawables; `place_order` comparator; reveal-bubble fade |
| `frontend/.../systems/__tests__/wallRenderer.test.js` (new) | geometry, comparator, reveal predicate |
