# Tile-to-tile transition blending

**Date:** 2026-09-10
**Status:** design approved, not yet planned
**Scope:** client render layer + one `tile_types` column. Server, protocol,
collision and the authority are untouched.

## Problem

Terrain is one tile-type name per cell, banded from a smooth value-noise field
(`sampleTerrain`, `backend/src/services/mapService.js`), with roads stamped over
it. The client draws each cell as one full isometric diamond of that type's
single texture (`RenderSystem.renderChunked` pass A, via
`systems/tileTexture.js`).

Because the noise is smooth but the banding is a hard threshold, and because a
cell is drawn as one undivided diamond, **every boundary between two tile types
is a 45-degree staircase of whole diamonds**. The only thing softening it today
is `EDGE_FEATHER = 2.5` px in `buildDiamondCanvas`, which at 128x64 is
invisible. The result reads as a grid of coloured lozenges rather than as
terrain.

## Goal

A boundary between two tile types reads as an organic edge: one material
visibly grows into the other with an irregular silhouette, and loose bits of it
scatter past the edge onto the neighbouring surface.

### Non-goals

- The minimap. `systems/minimapTerrainLayer.js` renders coarse `/overview` data
  at a few pixels per tile; a transition is sub-pixel there.
- `systems/mapPreviewRenderer.js` and the admin world preview.
- Any change to collision, walkability, movement speed, the chunk protocol, or
  the authority. This is cosmetic.
- Per-tile-type authored pattern families. See "Deliberately deferred".

## The key geometric decision

**Every overlay is anchored on the LOSING cell, never on the winning one.**

For a cell `C` whose neighbour `N` has a higher blend priority, we draw *N's
texture, masked by an organic shape, inside C's own diamond*. The winner's side
of the boundary is already painted by N's own base tile, so an overlay never
needs to extend outside C.

Three consequences, and they are what make this design cheap:

1. Overlay canvases share the **exact 132x68 footprint** of today's base
   diamonds (`ISO_TILE_W + 2*TILE_DIAMOND_PAD` by `ISO_TILE_H + 2*PAD`). The
   existing pad and feather machinery carries over unchanged; there are no
   oversized buffers and no second blit geometry to keep in sync.
2. "Deep intrusion, up to a full tile" is expressible exactly: a mask may cover
   anywhere from a sliver at the shared edge to nearly all of C's diamond.
   Intrusion is capped at one tile *by construction* rather than by a clamp.
3. Culling is trivially correct. An overlay exists if and only if its host cell
   is already in the visible set, so the existing per-tile cull needs no
   companion.

The rejected alternative was anchoring on the winner and letting it paint
outward. That needs a canvas spanning the cell and all eight neighbours
(384x192 = ~295 KB per cache entry against ~36 KB here) and a second cull.

## Architecture

`RenderSystem.renderChunked` grows one pass:

```
Pass A0  base tiles                                   (unchanged)
Pass A1  transition overlays                          (NEW)
Pass A2  landmarks, doorways, aura rings, waves        (unchanged)
Pass B   depth-sorted actors / walls / decorations     (unchanged)
```

A1 runs after **all** of A0. This is load-bearing: `chunkTileCells` enumerates
chunk by chunk, row by row, not in draw order, so an overlay emitted inline
during A0 would be overpainted by a base tile drawn later in the same loop.

Within A1, draws are sorted by `blend_priority` ascending, so where three
materials meet the loosest ends up on top. Pass B is untouched, so entities
still draw over everything.

### New and changed modules

| File | Responsibility |
|---|---|
| `frontend/.../src/js/systems/tileBlend.js` | NEW. `blendOverlaysFor(...)` -> `[{overType, dirBits, variant, family}]`. **Pure, no canvas**: the priority rule, the non-walkable clamp, the wall exclusion and the variant hash all live here so they are testable in the node env. |
| `frontend/.../src/js/systems/blendMasks.js` | NEW. The predefined pattern library: four shape families x two depths x six variants, rasterised to alpha. Canvas-only. |
| `frontend/.../src/js/systems/tileTexture.js` | `buildBlendCanvas(img, crop, maskSpec)` beside `buildDiamondCanvas`; `TileDiamondCache` gains an LRU bound. |
| `frontend/.../src/js/systems/RenderSystem.js` | Pass A1; a dev toggle beside `tileTexturesOff`. |

`TileDiamondCache` is an unbounded `Map` today. That is correct at ~50 keys
(one per tile type) and wrong at `type x dirBits x variant x family`, so the
bound is added as part of this work rather than left to be discovered.

## Slice 1 - the `blend_priority` column

Migration `1714440600000_tile_blend_priority.js` adds
`blend_priority integer NOT NULL DEFAULT 0` to `tile_types`. The timestamp
leaves a wide gap above `1714440546000`; this repo has repeatedly hit
migration-order collisions between parallel branches. If `Not run migration X
is preceding Y` appears, use `backend/scripts/repair-migration-order.js` --
never `--no-check-order`.

Four places must change or the column silently does nothing:

1. `backend/seeds/data/tileTypes.js` - a rank for each of the ~50 rows.
   Roads (`road_dirt`, `road_stone`, `road_sand`, `road_snow`, `road_ash`)
   share the top rank; `water`, `chasm` and the other impassables sit at the
   bottom. Rough ladder, loosest last:
   `water/cistern_shallows < ice/rime < rocks/cobblestone/ruin_stone/vault/foundry
   < earth < dirt < sand/ash < grass/highgrass/leafs < snow < road_*`.
2. `backend/src/services/tileTypes.js` - `loadTileTypes` does `SELECT *` but
   then builds an **explicit object literal**, so an unmapped column never
   reaches the game. Same failure class the `path_tile` comment in
   `services/biomes.js` warns about.
3. `backend/src/index.js` ~line 1964 - the admin `UPDATE` has an explicit
   `SET` list.
4. `frontend/src/games/something2/TileTypesAdmin.jsx` - a number input.

The client receives the field on the existing `GET /api/map/tiles` payload it
already consumes through `useMapTiles`. No new endpoint, no new query.

### The trap this slice must not ship

Items 3 and 4 are the shape of the bug that reverted an approved tile texture:
an explicit `SET` list plus a form that writes back a stale snapshot, with
**both requests returning 200** so nothing looks wrong. If the form omits
`blend_priority`, a plain `$n` binding writes `NULL`/0 and **every unrelated
tile save silently un-tunes the map**.

Mitigation is two-part, because a guard alone has already proven insufficient
here once -- the `NULLIF` guard added after that incident covered only the
first-texture case, and `entity_types` still carries the unguarded version:

- `COALESCE($n, tile_types.blend_priority)` in the `UPDATE`, matching the
  existing treatment of `art_biome` and `ai_provider_*` on the same route.
- A route test that saves a tile **without** the field in the body and asserts
  the stored rank is unchanged.

## Slice 2 - the edge overlay pass

### Selection (pure)

```js
// systems/tileBlend.js
export function blendOverlaysFor(tileName, worldX, worldY, chunkedMap, defs) {
  const self = defs[tileName];
  if (!self || self.wall_height > 0) return [];       // walls live in pass B
  const byType = new Map();
  for (let i = 0; i < 8; i++) {
    // DX/DY are tile steps; getTileAt takes WORLD PIXELS (MAP_TILE_SIZE = 100).
    const n = chunkedMap.getTileAt(worldX + DX[i] * MAP_TILE_SIZE,
                                   worldY + DY[i] * MAP_TILE_SIZE);
    if (n == null || n === tileName) continue;         // null = streaming frontier
    const over = defs[n];
    if (!over || over.wall_height > 0) continue;
    if (over.blend_priority <= self.blend_priority) continue;   // ties draw nothing
    byType.set(n, (byType.get(n) || 0) | (1 << i));
  }
  // -> one overlay per distinct winning neighbour type
}
```

Four rules, each a defect if missed:

- **`null` neighbour means no transition.** At the streaming frontier the
  neighbour chunk is not loaded. Treating `null` as "a different type" would
  ring the entire loaded region in bogus overlays. With `chunk_size` 64 and
  neighbourhood radius 1 the frontier sits ~90 tiles off-screen, so a
  transition appearing when that chunk loads is never visible.
- **Ties contribute nothing.** All five `road_*` tiles share the top rank, so
  road-meets-road is a clean seam instead of two materials fighting.
- **Wall tiles are excluded in both directions.** Anything with
  `wall_height > 0` is deferred to pass B and never drawn as a flat diamond, so
  it can neither host nor source an overlay.
- **Non-walkable clamp.** If either side has `walkable: false`, the `shallow`
  depth family is used instead of `deep`.

### Why the clamp exists

Deep intrusion means the visible material boundary can disagree with the
collision and speed boundary by up to a full tile. For walkable-to-walkable
pairs that is a speed lie and is acceptable -- it was chosen deliberately. For
`water`, `chasm` and `rubble` it is worse than a lie: a player clicks visible
grass and is blocked by nothing, which reads as a bug rather than as terrain.
One rule, no per-pair authoring.

### Geometry

In isometric projection, grid adjacency maps to two different roots on the
diamond: the four grid-orthogonal neighbours share a diamond **edge**, the four
grid-diagonals touch at a diamond **vertex**. A lobe is therefore rooted either
along an edge or at a corner point, and grows inward.

### The pattern library

| Family | Shape | Reads as |
|---|---|---|
| `lobed` | 3-5 overlapping ellipses along the root, varied radii | soft encroachment (grass into earth) |
| `fingers` | 2-4 narrow tapering tongues perpendicular to the root | tendrils (vines, snow drifts) |
| `torn` | jagged polyline offset inward with per-vertex noise | a broken crust (ash, ice) |
| `drip` | heavy mass at the root plus 1-2 long thin runs | spill (swamp, mud) |

Depth families: `deep` reaches up to ~90% of the diamond's inner radius,
`shallow` ~33%. Six variants each.

The build recipe is the one `buildDiamondCanvas` already uses, so there is no
second mechanism to maintain: paint the union of lobes white -> blur for the
feather -> intersect with the diamond -> `source-in` the texture. **There is no
separate mask cache**; the composited overlay is built once per cache key and
memoised exactly as base diamonds are.

One family is chosen per `(cell, overType)` and held across all of that cell's
roots, so the union reads as one coherent shape rather than four unrelated
blobs.

### Determinism

`variant = hash(worldTileX, worldTileY, overType)` -- stable across frames,
across chunk unload/reload, and identical for every player. A pure function,
unit-testable with no canvas.

### Cost

Cache key `${overType}|${dirBits}|${variant}|${family}` (extended in slice 3,
see below), ~36 KB per entry, one
blit per `(cell, distinct winning neighbour type)` -- usually one, occasionally
two. Roughly **+100-150 `drawImage` calls per frame** on top of ~500 base tiles.

## Slice 3 - scatter decals

The same machinery with a different mask family, **baked into the same canvas
as the edge**, so scatter costs zero additional draw calls.

A `scatter` mask is 6-14 small blobs distributed inside the diamond with
density falling off with distance from the root, painted into the same alpha
buffer as the lobes before the `source-in`. Because the texture composited
through them is the winner's own texture, a pebble on grass is genuinely that
stone rather than a tinted dot.

Scatter uses a **radius-2** neighbour scan where the edge uses radius 1: a cell
two tiles from stone should still catch a few pebbles. A cell with a winner
only at distance 2 gets a scatter-only overlay. Still one blit, still confined
to its own diamond, so none of the geometric guarantees change.

**The cache key must grow with it.** Slice 2's key
`${overType}|${dirBits}|${variant}|${family}` describes only the radius-1 ring.
Baking scatter into the same canvas without extending the key would let two
cells with identical adjacent neighbours but different radius-2 surroundings
collide on one cached canvas -- a wrong-but-plausible image, the kind of defect
that never fails a test and is hard to see in a screenshot.

The radius-2 ring is 16 more directions, and putting all 16 bits in the key
multiplies the key space by 65536. Instead it is **quantised**: scatter
contributes `scatterLevel` (0-3, bucketed from how many of the 16 ring cells
belong to `overType`) and `scatterDir` (the dominant octant of those cells), so
the key becomes
`${overType}|${dirBits}|${variant}|${family}|${scatterLevel}${scatterDir}`
-- a bounded 32x growth rather than an unbounded one. The quantisation is part
of `blendOverlaysFor`'s pure output and is unit-tested with the rest of it.

Scatter deliberately does not shift the material boundary -- scattered bits
read as sitting *on* the other surface, so they add apparent depth without
adding to the visual/gameplay disagreement the clamp above bounds.

## Testing

### Unit (node, no canvas)

This is the reason `tileBlend.js` holds no canvas code. Assertions must test
behaviour, not restate the implementation:

- A grass cell surrounded by higher-rank dirt in a hand-built `ChunkedMap`
  fixture yields exactly one overlay with the expected 8-bit `dirBits`.
- Equal ranks yield `[]`.
- A `wall_height > 0` neighbour yields `[]`; a `wall_height > 0` host yields `[]`.
- A `null` neighbour yields `[]`.
- The variant hash is stable across repeated calls **and differs between
  adjacent cells**. The second half is the one that matters: a hash that
  returned a constant would keep every other test green while every boundary in
  the game used a single pattern.
- `walkable: false` on either side selects `shallow`, not `deep`.

### Route

Save a tile through the admin `PUT` with no `blend_priority` in the body and
assert the stored rank is unchanged. This targets the trap in Slice 1 directly.

`frontend/vitest.config.js` now sets `esbuild: { jsx: "automatic" }` (commit
`be811f4`), so a render test for the `TileTypesAdmin` field is possible; before
that, no test in the suite could render a component at all.

### Measurement

rAF frame timing is not trustworthy on this host (1 Hz idle throttle), and
`getImageData`-as-a-flush has produced confident wrong answers here before. So:
instrumentation counters for draw calls and cache entries, plus a synthetic
tight loop over N renders off the rAF path. Report counts and cache bytes, not
fps.

### Browser verification

The acceptance test, because the entire point is how it looks. Call
`exitFullscreen()` first -- the game auto-enters fullscreen on Play and hides
windowed-layout problems. Screenshot the stone/sand/grass junction before and
after. A green suite proves nothing about whether this reads better.

## Rollout

Three independently shippable slices: (1) the column, (2) edge overlays,
(3) scatter. A dev toggle sits beside the existing `tileTexturesOff` so the
layer can be switched off in one keypress if it reads badly or costs too much.

Slice 2 should be eyeballed in the browser before slice 3 starts. Independent
directional lobes are the main visual risk in this design: they can read as
mechanical where two roots meet at a diamond corner. The mitigation is that
lobes are drawn wider than their shared edge so they overlap into corners, and
that the variant hash includes direction so adjacent cells differ -- but
whether that is enough is a judgement to make against a screenshot, not against
a test.

## Stated assumptions

- **Animated winners are pinned to the type's static frame.** `resolveTileVisual`
  returns a per-frame cache key for `render_mode: 'animated'` types; if such a
  type were ever the winner, its overlay would rebuild at 4 fps and churn the
  cache. Pinning costs only that an intruded tongue of an animated material does
  not ripple. In practice `water` is bottom-rank and therefore never a winner.
  The alternative -- frame in the cache key, LRU absorbs it -- stays available.
- **The visual boundary is allowed to disagree with the speed boundary by up to
  one tile** for walkable pairs. Chosen deliberately; bounded by the
  non-walkable clamp where it would read as a bug.

## Deliberately deferred

- **Per-type authored pattern families** (a `blend_pattern` column). Family is
  hash-chosen for now; authoring should wait until the hash-random version has
  been looked at.
- **Baking the ground layer.** Compositing base + transitions + scatter into
  offscreen region canvases would collapse the per-frame cost to a handful of
  blits. It needs 16x16-tile blocks (a full 64x64 chunk in iso is ~8300x4200 px,
  ~140 MB) and it cannot hold animated tiles, which would have to be excluded
  from the bake and drawn live anyway. Revisit only if slice 2 measures badly.
- **Sub-tile terrain resolution.** Emitting a 2x or 4x finer *visual* grid while
  collision stays at tile resolution would make the boundary follow the actual
  noise contour with no masks at all -- conceptually the correct fix. Rejected
  on cost: a protocol change, 4-16x chunk payload, 4-16x the diamonds drawn, and
  a second client/server divergence surface in a codebase repeatedly bitten by
  that.
