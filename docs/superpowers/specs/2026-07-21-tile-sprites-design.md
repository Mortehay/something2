# Tile textures & AI generation — design

**Date:** 2026-07-21
**Depends on:** sprite-gen sub-project D (built, merged), hardware-aware sprite-gen SOMET-44 (built), map render-mode infra SOMET-41 (built).

## Goal

Give `tile_types` AI-generated visuals with editable, seeded prompts: a static
texture and an optional animated loop per tile, generated through the existing
local sprite-gen service, and rendered into the isometric ground diamonds — with
a clean fall back to the current flat color.

## Decisions (locked during brainstorming)

1. **Static image AND animated sprite per tile** — mirror the entity
   `image` + `sprite` + `render_mode` pattern, not just a single image.
2. **One base prompt per tile type** — a single editable, human-readable prompt;
   the generator appends tile/iso/animation styling itself. Not two prompt fields.
3. **Stub backend for now** — build the full pipeline (prompt → generate → store
   → serve → render); generation returns instant placeholder textures via the
   `stub` backend. Real SD art turns on later with an env switch (`SPRITE_BACKEND`
   / `DEVICE`), no code change. Everything is testable now without a GPU.
4. **Extend sprite-gen, don't fork it** — add a `kind: "tile"` branch to the
   existing service and reuse its job/storage/hardware-tier plumbing.
5. **Three shippable slices** — schema, generation, rendering.

## Why extend sprite-gen rather than build a tile-only generator

The codebase already solved this exact shape for entities: a `sprite` jsonb, a
`render_mode`, async `/api/sprite-jobs`, MinIO storage, and hardware tiering.
A separate tile generator would duplicate all of that plumbing. Extending
sprite-gen with a tile branch reuses it and keeps tiles consistent with entities.
The rejected alternative — prompt + image columns with generation done manually
or externally — is minimal but does not meet "generate via local AI services."

## A tile is not a creature

A creature sprite is 8 facings × N walk frames. A tile has no facing and no walk
cycle: it is one seamless top-down texture, optionally with a short same-place
animation loop (water shimmer, lava bubble). The tile generation path therefore
must NOT reuse the facing/walk machinery — it produces a single texture and an
optional non-directional frame loop.

---

## Slice A — Schema & editable prompts

No AI, no rendering. Foundation only.

### Migration

Add to `tile_types` (mirrors the entity pattern):

| column | type | notes |
|---|---|---|
| `prompt` | `text NOT NULL DEFAULT ''` | base description, seeded per tile |
| `sprite` | `jsonb` (nullable) | animated atlas descriptor `{atlas_key, manifest_key, frames}`, filled in Slice B |
| `render_mode` | `text NOT NULL DEFAULT 'color'` | `color` \| `image` \| `animated` |

The existing `image` column (already present, `text DEFAULT ''`) becomes the
**static-texture reference**, filled in Slice B. `render_mode` defaults to
`color` so every current tile renders exactly as today until an image exists.

### Seeded prompts

The migration sets a base prompt for each of the 11 seeded tiles, derived from
its nature. Stored as **base** prompts only (no styling suffix). Values:

| tile | prompt |
|---|---|
| grass | `lush green meadow grass` |
| highgrass | `tall dense green grass` |
| leafs | `dark green forest leaf litter` |
| sand | `fine golden beach sand` |
| rocks | `grey rocky stone ground` |
| earth | `bare brown earth soil` |
| dirt | `dark packed dirt ground` |
| snow | `fresh white snow` |
| ice | `pale blue cracked ice` |
| swamp | `murky green swamp mud` |
| water | `clear blue rippling water` |

Any tile not in this list keeps the `''` default (harmless — generation just
produces a generic texture until edited).

### API

`POST` / `PUT /api/tile-types` accept and persist `prompt` (and, from Slice B,
`image` / `sprite` / `render_mode`). Both stay `adminGuard`-protected. Adding
`prompt` to the column lists in the existing INSERT/UPDATE is the whole change.

### Admin UI

[TileTypesAdmin.jsx](frontend/src/games/something2/TileTypesAdmin.jsx): the
create/edit modal gains an editable **Prompt** textarea bound to
`formData.prompt`; the tile card shows a truncated prompt line.

### Testing

- Migration seeds a non-empty prompt for all 11 named tiles (query each).
- `PUT` round-trips an edited prompt (mutation test: change it, read it back).
- Existing tile-type tests pass unmodified (additive columns).

### Deliverable

Every tile has a seeded, editable prompt. Nothing visual changes.

---

## Slice B — Generation via sprite-gen

### sprite-gen tile branch

`GenerateRequest` (`sprite-gen/app/main.py`) gains `kind: "creature" | "tile"`,
default `"creature"` — existing creature calls are unchanged. When `kind == "tile"`:

- The orchestrator produces **one** static texture, plus (when animation is
  requested) a short N-frame loop of the *same* tile — non-directional. No 8
  facings, no walk cycle.
- [prompts.py](sprite-gen/app/prompts.py) gets `build_tile_prompt(base)`:
  appends `seamless top-down isometric ground tile, tileable, flat lighting,
  no shadows, centered` instead of facing/walk-frame words. Input is the tile's
  stored base prompt.
- Storage `put_tile`: `tiles/<name>/static.png` for the image;
  `tiles/<name>/atlas.png` + `atlas.json` for the animated loop. On the `stub`
  backend this is instant placeholder pixels; the code path is identical for
  real SD later.

### Node bridge (mirrors the entity routes)

- `POST /api/tile-jobs` (adminGuard) → calls sprite-gen `/generate` with
  `kind:"tile"`; records a `sprite_sets` row (reused — `creature` holds the tile
  name, `entity_type_id` null). Returns `job_id` + recipe.
- `GET /api/tile-jobs/:jobId` → proxies job status (reuses the existing
  `spriteGen.getJob` proxy).
- `POST /api/tile-types/:id/image` (adminGuard) → approve a static texture: set
  `tile_types.image` = key, `render_mode = 'image'`.
- `POST /api/tile-types/:id/sprite` (adminGuard) → approve an animated atlas: set
  `tile_types.sprite = {atlas_key, manifest_key, frames}`, `render_mode = 'animated'`.

### Asset serving (the missing piece)

Neither entities nor tiles can currently get pixels to the browser — there is no
MinIO-serving route (grep for `api/sprites` finds none; a known entity fast-follow
bug is exactly this 404). Slice B adds:

- `GET /api/assets/*` → streams the object from MinIO
  (`get_object("sprites", key)`) with cache headers. Unblocks tile rendering and
  fixes the entity preview 404.

Note the storage contract nests the key under the bucket name: physical path is
`sprites/tiles/<name>/...` inside bucket `sprites`, so the route fetches
`get_object("sprites", "tiles/<name>/...")`.

### Admin UI

The tile edit modal gains **Generate texture** and **Generate animation**
buttons. Each kicks a job, polls `GET /api/tile-jobs/:jobId`, shows a live
preview thumbnail (from `/api/assets/*`), and an **Approve** button that links it
(image or sprite route). On stub the job returns near-instantly.

### Testing

- Job-flow test (mocked sprite-gen): `POST /api/tile-jobs` records a queued
  `sprite_sets` row; approve writes the key and flips `render_mode` (mutation
  test — assert the row before/after).
- `build_tile_prompt` appends tile styling and contains **no** facing/walk words
  (guards against reusing the creature branch).
- Asset route streams a known object and 404s a missing key.
- The route-protection test (`tests/auth_protection.test.js`) still enumerates
  every mutating `/api` route and finds the three new ones guarded — a low/zero
  match fails, as today.

### Deliverable

Edit a tile's prompt → Generate → placeholder texture appears → Approve →
`tile_types.image`/`sprite` populated and served via `/api/assets/*`.

---

## Slice C — Rendering

### The tile draw loop

[RenderSystem.js:102-116](frontend/src/games/something2/src/js/systems/RenderSystem.js#L102)
fills each visible diamond with `def.color`. Slice C adds a fallback chain
mirroring entities (`animated → image → color`):

- `animated` mode + atlas loaded → draw the current animation frame masked into
  the diamond.
- `image` mode + texture loaded → draw the static texture masked into the diamond.
- otherwise → the current flat-color diamond, unchanged. Un-generated tiles and
  any load failure look exactly like today.

### Diamond masking, cached per texture

Clipping every visible cell every frame is wasteful (a chunk view is hundreds of
cells). Instead, when a tile texture loads, pre-render it **once** into an
offscreen canvas already masked to the diamond shape, cached per tile type (and
per frame for animated). The hot loop does a single `drawImage` of the cached
diamond — the same cost as today's fill, no per-cell clip.

### Animation

For `animated` tiles the manifest carries `frames` + fps; the loop selects the
current frame from `nowMs` (already threaded into the renderer for entity
animation) and draws that frame's cached diamond. All cells of one tile type
share a single cache set — one per tile *type*, not per cell.

### Loading

`ImageManager` preloads each tile type's texture/atlas from `/api/assets/<key>`
when a world's tile set is known (`mapTiles` is already passed into the renderer).
Missing or slow images render color until they arrive; nothing blocks.

### Toggle

A global key (alongside the existing entity render-mode toggle) flips tile
textures on/off, to compare textured vs. flat and sidestep any perf surprise.

### Testing

- Fallback selector unit test: `animated`+atlas → frame; `image`+key → static;
  neither → color.
- Diamond-mask cache builds once per texture (spy/counter — not once per cell).
- Browser pass: a generated tile renders on the map; an animated tile shimmers;
  color fallback intact for un-generated tiles.

### Deliverable

Approved tiles show their generated texture (animated tiles shimmer) in-world,
with clean color fallback.

---

## Global constraints

- Every mutating `/api` route stays behind `adminGuard`; the route-protection
  test must find the new routes.
- `render_mode` defaults keep all existing tiles rendering as flat color until a
  texture is generated and approved — this feature is strictly additive on screen.
- Creature generation (`kind` default) is untouched; the tile branch is opt-in.
- Stub backend is the default everywhere; real SD is an env switch, not a code
  change.

## Out of scope

- Real SD/GPU art verification (deferred until a GPU is available; stub proves
  the pipeline).
- Seamless tile-to-tile edge blending / autotiling — each tile is an independent
  diamond texture.
- Per-world or per-instance tile variation (all cells of a type share one texture).
- Bulk "generate all tiles" batch action (per-tile generate only, for now).
- Reworking the entity sprite flow (the `/api/assets/*` route incidentally fixes
  its preview 404, but entity rendering is otherwise untouched).

## Build order

A (schema) → B (generation + serving) → C (rendering). Each slice is shippable
and independently testable. Each gets its own implementation plan.
