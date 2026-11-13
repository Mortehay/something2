# Image shrink tab + on-demand creature art — design

Date: 2026-11-13. Status: approved (approach B).

## Why

Game art is far heavier than what the game draws. The seed set is 1,606 PNGs /
283 MB; creature art alone is 380 files at 944×758, ~367 KB each (136 MB),
drawn on screen at roughly 30–120 px. Icons are 256 px drawn at 30–48 px.
On first entry the client also downloads art for **every creature type in the
catalog**, not just those present (`Game.preloadSprites`,
`frontend/src/games/something2/src/js/core/Game.js` ~L933): a village visit
pulls Rime/Construct/Hive/Drowned art at 200–500 KB each, queued behind the
ImageManager concurrency limiter at 4–5 s each. Behind a tunnel or on the
Orange Pi this dominates load time.

Spike (2026-11-13, PIL, Lanczos, all seed PNGs, scratchpad only) — total
**230 MB → 17 MB** as WebP q85 at the presets below, no visible difference at
200 px side by side (3 largest creatures + icons):

| Kind | n | now | PNG resized | WebP q85 |
|---|---|---|---|---|
| creatures @256 | 380 | 143 MB | 31.6 | 7.6 |
| items/skills/passives @128 | 872 | 55.6 | 19.7 | 5.7 |
| tiles @256 | 50 | 13.7 | 3.9 | 1.0 |
| character looks @384 | 30 | 12.0 | 2.8 | 0.6 |
| buffs (no resize) | 55 | 5.5 | 5.5 | 2.4 |

## Goals

1. Admin **Images** tab: list every game image, filter by kind (and by size /
   state), shrink one image or a filtered batch, undo (fall back to the
   original) one or a batch.
2. Every shrink/undo is recorded in the database.
3. Players download the shrunk WebP copy; everything else keeps working on
   the original PNG.
4. Server serves WebP correctly (the "PNG part at server side").
5. Separate slice: the client loads creature art only for creatures it
   actually needs, not the whole catalog.

## Non-goals

- Changing how art is generated, approved, or stored as originals.
- Touching the PNG decoders in the sprite pipeline (`pngAlpha`, `pngTrim`,
  `spriteIncremental`, `spriteTurnaround`, `spriteSizeCheck`) — they only
  ever see originals under this design.
- Audio.
- (Auto-shrinking was a non-goal until the owner asked for it on
  2026-11-13 — see "Auto-shrink".)

## Anti-goals (would be a failure even if it "works")

- An original is ever overwritten or deleted by this tool.
- A shrunk sprite sheet whose manifest is not rescaled (animations crop the
  wrong rectangle).
- The sprite pipeline, autotrim, seed export, or any admin tab starts
  receiving the WebP copy instead of the original.
- A shrink/undo that players never see because the browser keeps a
  year-cached copy under the same URL.
- Mutating the shared dev DB / asset store in tests (project rule).

## Approaches considered

- **A. Rewrite the image column to the WebP key.** Game needs no change, but
  ~10 server readers (redraw, turnaround, size check, autotrim, seed
  export/import…) then receive WebP and each must learn to look up the
  original; a missed one fails silently. Rejected.
- **B. Keep the column on the original; map original → web copy; substitute
  on game-facing output.** *Chosen.* Pipeline/export/admin untouched; a
  missed endpoint degrades to "serves the original" (slow, correct); new
  key on every shrink/undo defeats stale caches.
- **C. Serve the variant transparently under the original URL.** Zero
  client change, but seed-synced keys are cached `immutable` for a year, so
  shrink and undo never reach returning players. Rejected.

## Design

### Data

New table `image_variants` (one row per original that has ever been shrunk):

- `original_key` text PK — the object-store key held in the catalog column
  (image or sprite `atlas_key`).
- `web_key` text — the WebP object key (content-addressed, see below).
- `original_manifest_key` / `web_manifest_key` text, nullable — sprite sheets only.
- `active` boolean — true = players get `web_key`; Undo sets false (keeps the
  file so re-enable is instant).
- `width`, `height`, `bytes` of original and web copy; `params` jsonb
  (`maxEdge` or `scale`, `quality`, `format`).
- `original_sha256` — hash of the original bytes the web copy was made from.
- `updated_at`.

**Stale variants (call made by the designer).** Some originals are rewritten
under the *same* key (sprite-batch "use good frames",
`spriteBatchRoutes.js` ~L1172; `artSeed.js` fixed `seededKey`; tiles and
character appearances per `assetCache.js`). The variant then describes old
art. Policy: when substitution or the tab finds the original's current hash
≠ `original_sha256`, the variant is **stale** — players get the original
(never old art), and the tab shows state "stale" with a one-click re-shrink
(and a "re-shrink all stale" batch). No hook into the sprite pipeline. Hash
check cost: compute on write paths the tool controls and verify lazily (e.g.
object etag/size + cached hash); exact mechanism is the builder's.

New table `image_operations` (append-only log):
`id`, `op` ('shrink' | 'undo' | 'reactivate'), `original_key`, `web_key`,
`params` jsonb, `bytes_before`, `bytes_after`, `actor` (admin user id),
`batch_id` (uuid shared by one batch run, null for single), `status`
('ok' | 'failed'), `error` text, `created_at`.

One migration, node-pg-migrate format like `backend/migrations/*`. Mind the
recurring timestamp-collision pattern: pick the next free timestamp at merge.

### Which images exist

The source of truth for "game image columns" is the seed registry
(`backend/src/services/seedSync/registry.js`, `assets:` entries):
`catalog_art.image` (skills/passives/… by `subject_kind`),
`entity_types.image|sprite`, `tile_types.image|sprite`,
`character_appearances.image|sprite`, `item_types.icon`,
`vfx_effects|aura_effects|buff_visuals|status_visuals.sprite_image`.
The tab's listing is built by walking that registry, so a new art column
added to the registry shows up automatically. "Kind" for the filter = table
(+ `subject_kind` for `catalog_art`) + image vs sprite sheet.

### Shrinking

- Library: `sharp` added to `backend` (base image `node:20-alpine`; sharp
  ships prebuilt musl binaries — verify the dev and orangepi images build).
- Output: WebP, quality 85, alpha preserved.
- Single images: resize so the longest edge ≤ preset (never upscale).
- Sprite sheets: resize by a **scale factor** (default 1.0 = convert format
  only), then rewrite the manifest with every pixel field (frame rects,
  cell w/h, anchors — whatever the manifest holds) multiplied and rounded
  consistently; store as a new manifest object.
- Default presets (editable per run in the tab, overridable per image):
  creatures 256, character looks 384, tiles 256, item/skill/passive icons
  128, VFX/aura/buff/status sheets scale 1.0, sprite sheets scale 1.0.
- Web copy key: content-addressed under `seedsync/<sha256>/…webp` (or a
  sibling prefix that `assetCache.js` treats as immutable), so it gets the
  one-year cache and a new URL whenever the bytes change.
- Batch runs as a background job (pattern: existing job-style admin routes);
  per-image failure is logged in `image_operations` and does not stop the batch.
  Tab shows progress and the per-image result.

### Display size after shrinking (owner raised 2026-11-13)

Checked in the client: **on-screen size never comes from file pixels**, so
nothing in the renderer needs recalculating. Every draw sizes its box from
world units and fits the image into it by aspect:
`fitSpriteRect(img.width, img.height, …)` (`RenderSystem.js` ~L165, ~L4757,
~L5042), icons fit into a fixed size (`gameArt.js` ~L62), effect sheets
derive frame geometry from the loaded image (`RenderSystem.js` ~L1760,
~L2388), and the walk anchor shift is in source px but scaled by
`r.dw / sw` at draw (`RenderSystem.js` ~L4805). Aspect ratio is preserved by
every resize, so these are scale-invariant.

What **does** depend on pixels, and is therefore a hard rule for the tool:

1. **Box sprite-sheet manifests** carry pixel geometry: `cell: [w, h]` and
   `frames: { "idle/s/0": [x, y, w, h], … }`. A shrunk sheet must ship a
   rewritten manifest with `cell` and every `frames` rect scaled.
2. **Frames must stay on an exact integer grid.** Pick the scale so the new
   cell is whole pixels in both axes (e.g. 96×128 → 48×64 at 0.5; reject or
   snap scales that give fractional cells), and resample **per frame**
   (cut each cell, resize, paste into the new grid) so neighbouring frames
   never bleed into each other's edges.
3. **Effect strips** (VFX/aura/buff/status, frames side by side, geometry
   from `spriteSourceRect(w, h, frames, i)` = `floor(w / frames)`,
   `core/vfx.js` ~L355): the shrunk width must be exactly
   `frames × newCellW`, else frames drift. Same per-frame resample.
4. Other manifest fields (`quality`, `rows`, `actions`, ids) are copied
   unchanged; they hold no pixel values.
5. Never upscale. Images already at or below the preset are converted to
   WebP only.

Tests must pin: manifest `cell` and every `frames` rect scaled exactly;
sheet dimensions = grid × new cell; effect strip width divisible by frame
count; a frame's content does not include pixels from its neighbour.

### Serving to the game (substitution)

- A backend helper loads active `image_variants` into an in-memory map
  (refreshed on any shrink/undo) and exposes `toWeb(key)` /
  `toWebSprite(spriteObj)`.
- Applied on the **game-facing** responses that carry art keys:
  `/api/entity-types`, tile types (via `/api/map/config` / `/api/worlds/*`
  as applicable), `/api/game-art`, `/api/vfx-effects`, `/api/buff-visuals`,
  `/api/status-visuals`, aura data, character appearances, and any
  WebSocket payload that carries an image/atlas key. Several of these
  endpoints are shared with admin tabs; the game opts in (e.g. a query flag
  or a dedicated header) so **admin keeps seeing originals**.
- The client's ImageManager cache key is the asset key; since the def it
  receives already holds the web key, renderer lookups stay consistent as
  long as every path that hands the client a key is substituted the same
  way. A path missed = client fetches the original (correct, slower).

### Server PNG fixes

- `/api/assets/*`: set `image/webp` for `.webp`.
- `assetStore.putObject` callers in the new tool pass `image/webp`.
- Seed export/import: `image_variants` travels with the seed so seeding
  another database (e.g. Orange Pi) brings the shrunk copies along without
  re-running the tool. Originals continue to travel as today. Seed export
  rewrites object keys (`seedsync/<sha>/<file>`) and downsizes icons
  (`maxEdge`), so a variant cannot be identified by object key across
  databases. Calls made by the designer:
  - In the seed a variant is identified by **(table, row natural key,
    column)** — e.g. `entity_types` / `Rime Caster` / `image` — not by
    `original_key`. Its `web_key` / web manifest are asset columns.
  - Apply resolves that triple to the target's current original key, and
    sets `original_sha256` to the **target's** original hash (the seed binds
    the pair), so an export-downsized icon is not falsely stale.
  - Apply follows the normal seed rule: the seed's variant replaces the
    target's for that triple; a triple absent from the seed is left alone.
  - Internally `image_variants` may therefore key by (table, row id,
    column) rather than `original_key`; builder's choice, as long as
    substitution can look up by original key at serve time.

### Admin tab

Route `game/images` inside the `RequireAdmin` block in
`frontend/src/App.jsx`, plus a sidebar entry like the other admin tabs.
Layout:

```
Images                     [kind ▾] [state: all|original|shrunk ▾] [> N KB]
┌──┬─────────────┬─────────┬────────┬──────────┬──────────┬──────────────┐
│☐ │ preview     │ name    │ size   │ px       │ state    │ actions      │
│☐ │ [img]       │ Rime C. │ 455 KB │ 944×758  │ original │ Shrink ▾     │
│☐ │ [img]       │ Hive S. │  21 KB │ 256×205  │ shrunk   │ Undo · Redo  │
└──┴─────────────┴─────────┴────────┴──────────┴──────────┴──────────────┘
Selected 87 · 31.2 MB → est. ~3 MB   preset: 256 px, q85   [Shrink] [Undo]
History ▸ (image_operations, newest first, filter by batch)
```

- Per-row: preview of original vs web copy side by side, sizes, Shrink with
  overridable preset, Undo.
- Batch: select all matching filter → Shrink / Undo.
- Follow existing admin tab conventions (styled-components `--s2-*` tokens,
  TanStack Query, uk i18n strings).

### Auto-shrink (owner request 2026-11-13)

When art is generated, approved or regenerated, its web copy is prepared
automatically. Sprite sheets are always built from the **original**
picture (the pipeline only ever sees originals), and the finished sheet is
then shrunk as its own web copy.

- Setting `image_auto_shrink` (boolean, default **true**) in the existing
  game settings (`backend/src/services/gameSettings.js`); toggle shown in
  the Images tab.
- What is auto-shrunk: every image/sheet with **no variant** (default preset
  for its kind) and every **stale** variant (re-shrunk with its previous
  `params`). A subject the admin **undid** (`active=false`, not stale) is
  never auto-shrunk again — undo wins until the admin acts.
- Trigger: a periodic sweep (every 2 min) plus an immediate, debounced
  `requestAutoShrink()` poke from the main write paths (entity/tile image +
  sprite approval routes in `index.js`, sprite batch "use good frames" in
  `api/spriteBatchRoutes.js`, `spriteJobQueue.js` approval, catalog art
  approval in `services/catalogSubjects.js`, seed apply of the art group).
  The poke carries no subject: the sweep diffs the catalog against
  `image_variants`, so a write path without a poke is still picked up by
  the next periodic sweep. No hook changes any write path's behaviour.
- Detection cost: new/changed column values are found from the DB alone
  (column value ≠ `original_key`); same-key rewrites need etag stats, done
  on the periodic sweep only.
- Runs through the same single-flight batch runner as the tab; if a manual
  run is active, the sweep skips and retries next tick. Operations are
  logged with `actor` NULL and `params.auto = true`; the tab's history
  shows them as "auto".
- Failures are logged like any batch row; a subject whose auto-shrink
  failed is not retried until its original changes again (no retry storm).

### Slice 2: creature art on demand

Decided with the owner (2026-11-13):

- **Only hostile creature types** load on demand. Player classes, NPCs
  (merchants, quest givers) and props (which reuse entity art) stay
  preloaded as today.
- A creature type's art is requested when a creature of that type is first
  known to the client (spawn / snapshot in AOI).
- At map entry, the entry wait covers only creature types **present in the
  initial snapshot**. No new server-side "what can spawn here" list.
- A type first seen later shows the existing colour fallback until its art
  lands (~20 KB once shrunk). Accepted by the owner.
Must keep working: `whenSettled` entry wait, `isQuiet` (Amber Stance ready
signal, preload chip), Animations setting gating (`_animOn`).

## Builder's calls

- Exact job/progress mechanism for batches; exact sharp options beyond
  WebP q85; preview UX details; how the game opts into substitution; how the
  substitution map is refreshed across processes (single backend today).
- Test strategy (private test DB per project rules; never the shared dev DB
  or bucket).
