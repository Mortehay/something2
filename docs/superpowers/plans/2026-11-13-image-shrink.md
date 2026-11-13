# Image Shrink Tab + On-Demand Creature Art Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin "Images" tab that makes WebP web copies of game art (single or batch, undoable, logged in DB), served to players only; plus loading hostile-creature art on demand.

**Architecture:** Catalog columns keep pointing at the original PNG. A new `image_variants` table maps a catalog cell (table, natural key, column) to a WebP copy; a cached serve map swaps keys in game-facing API payloads only. Shrinking is a pure `sharp` module; a standalone in-memory batch runner drives it; every action is appended to `image_operations`.

**Tech Stack:** Node 20 / Express / pg / node-pg-migrate / MinIO client / `sharp` (new); React + TanStack Query + styled-components; `node --test`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-image-shrink-design.md` (commits 093e8c9b, 44186a77). Read it before any task.

## Global Constraints

- Originals are never overwritten or deleted by this feature. Only new objects are written.
- Output format: WebP, quality 85, alpha preserved. Never upscale.
- Default presets: entity image 256 (longest edge), tile image 256, character appearance image 384, item icon 128, catalog_art icon kinds (`GAME_ART_KINDS`) 128, other catalog_art kinds 256, every sprite sheet and effect strip scale 1.0 (format only).
- Web copy keys: `seedsync/<sha256-of-webp-bytes>/<basename>.webp` (immutable cache per `assetCache.js`).
- Sprite sheets: manifest `cell` and every `frames` rect scaled; all resulting values must be whole pixels, else refuse with error `fractional_cell`. Resample per frame.
- Effect strips: new width must equal `frames × newCellW` exactly (`frames` = row's `sprite_frames`, same rule as `spriteFrameCount`, clamp 1..64).
- Admin tabs, sprite pipeline, seed export see originals; only game-facing payloads are substituted.
- A variant whose original changed (column value differs from `original_key`, or object etag differs from `original_etag`) is **stale**: serve the original.
- Tests never touch the shared dev DB or bucket: DB tests via `privateTestDb()` / `node scripts/testdb.js run -- <file>`; object store via a fake store (`tests/seed_sync_assets_db.test.js` `fakeStore()` pattern).
- Never `git checkout`/`stash`/branch in the shared checkout; work in an own worktree.
- Migration timestamp: next free after the newest in `backend/migrations/` at merge time.

## Review Focus

1. **Art rewritten under the same key** (sprite batch "use good frames") → players must get the new original, tab shows `stale`. Test in Task 3.
2. **Admin tab sharing a query cache with the game** (vfx/aura/buff/status hooks share keys by design) → admin must still see originals after the game loaded web copies. Test in Task 4.
3. **Batch with one corrupt/missing original** → that row logs `failed`, the rest succeed, run ends `done`. Test in Task 5.
4. **Sheet whose scale gives fractional cells** (e.g. 96×128 at 0.3) → refused before any write, nothing logged as ok. Test in Task 1 + Task 3.
5. **Seeded database with variants but different original keys** (Orange Pi) → variants bind to the target's originals on first load, not reported stale. Test in Task 7.

---

## File Structure

Backend (new): `src/services/imageShrink.js` (pure sharp transforms), `src/services/imageCatalog.js` (which columns are images, kinds, presets — from seed registry), `src/services/imageVariants.js` (DB: list, shrink, undo, serve map, key swap), `src/services/imageShrinkRun.js` (in-memory batch runner), `src/api/imageVariantRoutes.js` (admin routes), `migrations/<ts>_image_variants.js`.
Backend (modify): `package.json` (sharp), `src/services/assetStore.js` (statObject, readObject), `src/index.js` (webp content type, mount routes, substitution on game endpoints), `src/api/characterRoutes.js`, `src/api/auraEffectsRoutes.js`, `src/api/buffVisualsRoutes.js`, `src/api/statusVisualsRoutes.js`, `src/services/seedSync/{registry,coverage,assets}.js`, `seeds/sync/art.json`.
Frontend (new): `ImagesAdmin.jsx`, `useImages.js`. (modify): `useMaps.js`, `src/js/core/Game.js`, `src/js/entities/CreatureManager.js`, `frontend/src/ui/navSections.js`, `frontend/src/App.jsx`, `src/js/i18n/uk/react.js`.

---

### Task 1: Pure shrink transforms (sharp)

**Files:**
- Modify: `backend/package.json` (add `sharp`), `compose/develop/backend.Dockerfile` only if the alpine build fails without it
- Create: `backend/src/services/imageShrink.js`
- Test: `backend/tests/image_shrink.test.js`

**Interfaces:**
- Produces:
  - `shrinkImage(buf: Buffer, { maxEdge?: number, quality?: number = 85 }) -> Promise<{ buffer: Buffer, width, height, srcWidth, srcHeight }>`
  - `shrinkSheet(buf: Buffer, manifest: object, { scale: number, quality?: 85 }) -> Promise<{ buffer, manifest, width, height }>` — manifest deep-copied; `cell` and every `frames[k]` rect × scale; other fields untouched.
  - `shrinkStrip(buf: Buffer, frames: number, { scale: number, quality?: 85 }) -> Promise<{ buffer, width, height }>`
  - `class ShrinkError extends Error { code }` — codes `fractional_cell`, `bad_image`.

- [ ] **Step 1: Write failing tests** (build inputs with sharp `create` in the test; no fixtures):
  - `shrinkImage caps longest edge and keeps aspect`: 944×758 RGBA in, `maxEdge:256` → `width 256, height 206` (round), output starts with `RIFF....WEBP`, `srcWidth 944`.
  - `shrinkImage never upscales`: 100×80 with `maxEdge:256` → 100×80, still WebP.
  - `shrinkImage keeps alpha`: fully transparent corner pixel stays alpha 0 after decode.
  - `shrinkSheet scales cell and every frame`: 384×256 sheet, manifest `{cell:[96,128], frames:{'idle/s/0':[0,0,96,128],'idle/s/1':[96,0,96,128],'walk/s/0':[0,128,96,128]}, quality:[{x:1}]}`, scale 0.5 → image 192×128, `cell [48,64]`, frames `[0,0,48,64]`,`[48,0,48,64]`,`[0,64,48,64]`, `quality` deep-equal input.
  - `shrinkSheet has no bleed`: frame 0 solid red, frame 1 solid blue → after 0.5, every pixel in new frame 0 rect has blue channel < 8.
  - `shrinkSheet refuses fractional cells`: scale 0.3 → rejects `ShrinkError` code `fractional_cell`.
  - `shrinkStrip keeps width = frames × cell`: 768×128, frames 6, scale 0.5 → 384×64; scale 0.3 → `fractional_cell`.
  - `scale 1.0 converts format only`: sheet dims and manifest unchanged, output WebP.
- [ ] **Step 2:** `cd backend && node --test tests/image_shrink.test.js` → FAIL (module missing).
- [ ] **Step 3:** `npm install sharp` in `backend/`; implement. Per-frame: `extract` each rect, `resize` exact to scaled w/h (Lanczos3), `composite` onto a transparent canvas of the new size, encode `webp({quality, alphaQuality:100})`. Scaled value check: `Number.isInteger(v * scale)` within 1e-9.
- [ ] **Step 4:** re-run → PASS. Also `docker compose -f compose/develop/docker-compose.yml build backend` succeeds (sharp linuxmusl prebuilt).
- [ ] **Step 5:** commit `feat(images): sharp shrink transforms for images, sheets, strips`.

### Task 2: Schema, asset store helpers, WebP serving

**Files:**
- Create: `backend/migrations/<ts>_image_variants.js`
- Modify: `backend/src/services/assetStore.js`, `backend/src/index.js:3845`
- Test: `backend/tests/assets_route.test.js` (add case), `backend/tests/image_variants_schema_db.test.js`

**Interfaces:**
- Produces tables:
  - `image_variants(id serial PK, sync_uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), subject_table text NOT NULL, subject_key text NOT NULL, subject_column text NOT NULL, original_key text NULL, original_etag text NULL, web_key text NULL, web_sprite jsonb NULL /* {atlas_key, manifest_key} */, active boolean NOT NULL DEFAULT true, params jsonb NOT NULL, original_bytes int, web_bytes int, original_width int, original_height int, web_width int, web_height int, created_at, updated_at, UNIQUE(subject_table, subject_key, subject_column), CHECK ((web_key IS NULL) <> (web_sprite IS NULL)))`
  - `image_operations(id bigserial PK, op text CHECK IN ('shrink','undo','reactivate'), subject_table, subject_key, subject_column text NOT NULL, original_key text, web_key text, params jsonb, bytes_before int, bytes_after int, actor int REFERENCES users(id) ON DELETE SET NULL, batch_id uuid NULL, status text CHECK IN ('ok','failed'), error text, created_at timestamptz DEFAULT now())`, index on `(created_at DESC)` and `(batch_id)`.
  - (Check the users table name/PK in an existing migration before writing the FK.)
- Produces `assetStore.statObject(key) -> Promise<{ size: number, etag: string } | null>` (null on NotFound), `assetStore.readObject(key) -> Promise<Buffer>`; both exported.

- [ ] **Step 1: Failing tests:** `assets_route.test.js` → `GET /api/assets/seedsync/abc/x.webp` responds `Content-Type: image/webp`. Schema DB test: insert a variant with both `web_key` and `web_sprite` null → check violation; duplicate subject triple → unique violation.
- [ ] **Step 2:** run `node --test tests/assets_route.test.js` and `node scripts/testdb.js run -- tests/image_variants_schema_db.test.js` → FAIL.
- [ ] **Step 3:** migration (copy style of `1714440889000_effect_display.js`), `else if (/\.webp$/i.test(key)) res.type('image/webp');`, store helpers via the minio client's `statObject` / `getObject`.
- [ ] **Step 4:** both runs PASS.
- [ ] **Step 5:** commit `feat(images): image_variants/image_operations tables, webp serving`.

### Task 3: Image catalog, shrink/undo, serve map

**Files:**
- Create: `backend/src/services/imageCatalog.js`, `backend/src/services/imageVariants.js`
- Test: `backend/tests/image_variants_db.test.js`

**Interfaces:**
- Consumes: Task 1 transforms, Task 2 tables + `statObject`/`readObject`, `seedSync/registry.js` art group `assets`, `keyText` (`seedSync/assets.js`), `GAME_ART_KINDS` (`services/gameArt.js`).
- Produces (`imageCatalog.js`):
  - `imageColumns() -> Array<{ table, column, assetType: 'image'|'sprite', strip: boolean, kind: string }>` — walks registry art-group asset columns of type image/sprite; `strip` true for `sprite_image` on vfx/aura/buff/status tables; `kind` = `entity`, `entity_sheet`, `tile`, `tile_sheet`, `appearance`, `appearance_sheet`, `item`, `art:<subject_kind>`, `effect:<table>`.
  - `defaultParams(kind) -> { maxEdge?: number, scale?: number, quality: 85 }` per Global Constraints.
- Produces (`imageVariants.js`), all `(pool, store, …)`; `subject = { table, key, column }`:
  - `listImages(pool, store, { kind?, state?, minBytes? }) -> Array<{ subject, kind, label, original_key, manifest_key|null, bytes, state: 'original'|'shrunk'|'stale'|'undone', variant|null }>`
  - `shrinkSubject(pool, store, subject, params|null, { actor, batchId }) -> operation row` — reads original (+manifest for sheets), transforms, writes WebP (+ new manifest JSON under `seedsync/<sha>/manifest.json`), upserts variant (`active=true`, `original_key`, `original_etag` from `statObject`), logs `ok`; on throw logs `failed` with `error` (ShrinkError code or message) and rethrows nothing.
  - `undoSubject(pool, subject, { actor, batchId })` → `active=false`, log `undo`. `reactivateSubject` → `active=true`, log `reactivate` (refuse if stale: shrink again instead).
  - `getServeMap(pool, store) -> Promise<Map<originalKey, { web_key?, web_sprite? }>>` cached 60 s; `invalidateServeMap()`. Only active, non-stale variants. Binds unbound rows (null `original_key`, from seed) to the current column value + its etag and persists that.
  - `webArt(map, def) -> def` — returns a shallow copy with `image`, `icon`, `sprite_image` and `sprite.{atlas_key, manifest_key}` swapped when mapped; untouched otherwise (same object if nothing mapped).

- [ ] **Step 1: Failing DB tests** (private DB, fake store holding real PNG buffers made with sharp; seed one `entity_types` row with `image` key, one with a box `sprite`):
  - `shrink writes a webp, keeps the column, logs ok`: after `shrinkSubject` the `entity_types.image` value is unchanged; fake store has a new `seedsync/<sha>/….webp`; original object bytes unchanged; one `image_operations` row `op shrink status ok`.
  - `serve map swaps only active variants`: `webArt(map, def).image === web_key`; after `undoSubject` + `invalidateServeMap`, `webArt` returns original.
  - `stale when original rewritten under same key` (Review Focus 1): overwrite original bytes in the fake store (new etag) → `listImages` state `stale`, `webArt` returns original.
  - `stale when column points elsewhere`: update `entity_types.image` to a new key → stale.
  - `sheet refusal logs failed, writes nothing` (Review Focus 4): params `{scale:0.3}` on a 96×128 sheet → op `failed`, error `fractional_cell`, no new objects, no variant row.
  - `sheet shrink serves new atlas and manifest`: `webArt(map, def).sprite` has both keys swapped; other sprite fields kept.
  - `listImages filters`: `kind:'entity'` excludes sheets; `minBytes` excludes small; `state:'shrunk'` only active non-stale.
- [ ] **Step 2:** `node scripts/testdb.js run -- tests/image_variants_db.test.js` → FAIL.
- [ ] **Step 3:** implement. `label` = row's `name`/`label`/`subject_key` (whichever the table has). `bytes` from `statObject`.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(images): catalog, shrink/undo service, serve map`.

### Task 4: Substitute web copies in game-facing payloads

**Files:**
- Modify: `backend/src/index.js` (`/api/map/config` :844, `/api/map/tiles` :856, `/api/game-art` :3973, `/api/vfx-effects` :2051), `backend/src/api/characterRoutes.js` (:32, :45), `backend/src/api/auraEffectsRoutes.js:60`, `backend/src/api/buffVisualsRoutes.js:24`, `backend/src/api/statusVisualsRoutes.js:14`; frontend `useMaps.js` (useVfxEffects, useAuraEffects, useBuffVisuals, useStatusVisuals), `src/js/core/Game.js:989`
- Test: `backend/tests/image_variants_serve_db.test.js`, `frontend/src/games/something2/__tests__/useMapsArtKeys.test.js`

**Interfaces:**
- Consumes: `getServeMap`, `webArt` (Task 3).
- Rule: unconditional substitution on `/api/map/config`, `/api/map/tiles`, `/api/characters`, `/api/characters/classes` (class + `appearances[]`), `/api/game-art` (each `[k].image`). On shared endpoints (vfx/aura/buff/status) substitute **only when `req.query.art === 'web'`**.
- Frontend: game hooks in `useMaps.js` request `?art=web` and use query keys `[<existing key>, 'web']` (prefix match keeps every existing admin `invalidateQueries([<key>])` working). `Game._fetchStatusVisuals` adds `?art=web`.

- [ ] **Step 1: Failing tests:**
  - backend: with one active variant per kind, `GET /api/map/config` entity `image` = web key; `GET /api/vfx-effects` returns original; `GET /api/vfx-effects?art=web` returns web key; `/api/characters/classes` swaps class and appearance keys; `/api/game-art` swaps `skill[k].image`.
  - frontend (Review Focus 2): the game hooks' query keys end with `'web'` and their URLs contain `art=web`; admin hooks (`useVfxEffectsAdmin`, `useAuraEffectsAdmin`, `useBuffVisualsAdmin`, `useStatusVisualsAdmin`) keep their original keys and URLs without `art=web`.
- [ ] **Step 2:** `node scripts/testdb.js run -- tests/image_variants_serve_db.test.js`; `cd frontend && npx vitest run src/games/something2/__tests__/useMapsArtKeys.test.js` → FAIL.
- [ ] **Step 3:** implement; `getServeMap` errors must not fail the endpoint (log, serve originals).
- [ ] **Step 4:** → PASS; also run existing `tests/game_art_route.test.js`, `tests/assets_route.test.js` → PASS.
- [ ] **Step 5:** commit `feat(images): serve web copies to the game client`.

### Task 5: Batch runner + admin routes

**Files:**
- Create: `backend/src/services/imageShrinkRun.js`, `backend/src/api/imageVariantRoutes.js`
- Modify: `backend/src/index.js` (mount near :646: `app.use('/api/admin/images', imageVariantRoutes(guardPool))`)
- Test: `backend/tests/image_variant_routes_db.test.js`

**Interfaces:**
- Consumes: Task 3 service. Pattern: `services/bulkImageRegeneration.js` (in-memory `current`, single-flight, cancel). Do **not** reuse `seedSync/jobs.js` (would block Seed/Export).
- Produces `imageShrinkRun.startRun(pool, store, { op: 'shrink'|'undo', subjects, params|null, actor }) -> view`, `getRun() -> view|null`, `cancelRun()`; `view = { id /*= batch_id*/, op, total, done, failed, status: 'running'|'done'|'cancelled', startedAt, finishedAt }`. Calls `invalidateServeMap()` at end.
- Routes (all `router.use(requireAdmin(pool))`):
  - `GET /` `?kind&state&minBytes` → `listImages`; `GET /kinds` → `[{ kind, defaults }]`
  - `POST /runs` `{ op, subjects, params? }` → 201 view; 409 `{error:'run in progress'}` if running; 400 if `subjects` empty
  - `GET /runs/current` → view|null; `POST /runs/current/cancel`
  - `POST /reactivate` `{ subject }` → op row
  - `GET /operations` `?batch_id&limit=100` → newest first

- [ ] **Step 1: Failing tests** (supertest mini app like `tests/tunnel_routes_db.test.js`):
  - non-admin → 403 on every route.
  - `batch continues past a bad row` (Review Focus 3): 3 subjects, middle original missing in fake store → run ends `done`, `done 3`, `failed 1`, 2 ok + 1 failed operations sharing `batch_id`.
  - second `POST /runs` while running → 409.
  - cancel stops before next subject, status `cancelled`.
  - `GET /operations?batch_id=` returns only that batch.
- [ ] **Step 2:** `node scripts/testdb.js run -- tests/image_variant_routes_db.test.js` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(images): admin image routes and batch runner`.

### Task 6: Images admin tab

**Files:**
- Create: `frontend/src/games/something2/ImagesAdmin.jsx`, `frontend/src/games/something2/useImages.js`
- Modify: `frontend/src/ui/navSections.js` (entry near Tunnels :79), `frontend/src/App.jsx` (`<Route path="images" …>` inside `RequireAdmin`), `frontend/src/games/something2/src/js/i18n/uk/react.js` (`"Images": "Зображення"` and the tab strings)
- Test: `frontend/src/ui/__tests__/navRoutes.test.js` (already checks nav↔routes; must stay green), `frontend/src/games/something2/__tests__/imagesModel.test.js`

**Interfaces:**
- Consumes: Task 5 routes. Hook pattern: `useTunnels.js` (`apiFetch` + `authHeaders`, polling `runs/current` every 1 s while running).
- Pure helpers in `frontend/src/games/something2/imagesModel.js`: `estimateWebBytes(rows, paramsByKind) -> number` (ratio table from spike: entity 0.053, icons 0.10, tile 0.073, appearance 0.05, sheets/strips 0.44), `formatBytes(n) -> string`.

- [ ] **Step 1: Failing tests:** `imagesModel.test.js` — `estimateWebBytes` of one 455 KB entity row ≈ 24 KB (±1 KB); `formatBytes(455000) === '455 KB'`, `formatBytes(31_200_000) === '31.2 MB'`.
- [ ] **Step 2:** `cd frontend && npx vitest run src/games/something2/__tests__/imagesModel.test.js src/ui/__tests__/navRoutes.test.js` → FAIL.
- [ ] **Step 3:** implement the layout in the spec ("Admin tab" section): filters (kind, state, min KB), table with checkbox, preview original vs web copy (`assetUrl`), bytes, px (from variant), state badge, per-row Shrink (overridable `maxEdge`/`scale`) / Undo / Reactivate, select-all-matching, footer with selection total and estimate, batch Shrink/Undo, run progress, History list with batch filter. `--s2-*` tokens, light and dark.
- [ ] **Step 4:** → PASS; `npx vitest run` whole frontend → no new failures vs baseline.
- [ ] **Step 5:** commit `feat(images): Images admin tab`.

### Task 7: Seed sync carries variants

**Files:**
- Modify: `backend/src/services/seedSync/registry.js` (art group, new spec after `character_appearances`), `backend/src/services/seedSync/coverage.js` (classify `image_operations` as `EXCLUDED` with reason "local audit log"), `backend/src/services/seedSync/assets.js` (:396 ext and :656/:660 content type from the object's extension instead of hardcoded png), `backend/tests/seed_sync_registry_db.test.js:62-79` (table list), `backend/seeds/sync/art.json`
- Test: `backend/tests/seed_sync_image_variants_db.test.js` (matches `ISOLATED_TEST_FILE`, runs on `game_test_sync`)

**Interfaces:**
- Registry spec: `{ table: 'image_variants', naturalKey: ['subject_table','subject_key','subject_column'], omit: { ...LOCAL, original_key: 'local', original_etag: 'local' }, assets: { web_key: { type:'image', dir:'textures/web' }, web_sprite: { type:'sprite', dir:'textures/web_sprites' } } }` — no `maxEdge`.
- Consumes `getServeMap` binding rule (Task 3) for the target side.

- [ ] **Step 1: Failing tests:**
  - export → seed round trip: a WebP `web_key` exports as `.webp` and imports with `image/webp` (not resampled, bytes equal).
  - Review Focus 5: after seeding into a DB whose `entity_types.image` is a different key, the imported variant has `original_key` null; first `getServeMap` binds it to the target's current key and serves the web copy (`webArt` swaps), not stale.
  - coverage test (`tests/seed_sync_coverage_db.test.js`) green.
- [ ] **Step 2:** `node scripts/testdb.js run -- tests/seed_sync_image_variants_db.test.js tests/seed_sync_coverage_db.test.js tests/seed_sync_registry_db.test.js` → FAIL.
- [ ] **Step 3:** implement; add the migration's `sync_uuid` backfill per `migrations/1714440810000_seed_sync_plan4.js:23-26` if Task 2 did not (fresh table: default is enough).
- [ ] **Step 4:** → PASS; also `tests/seed_sync_assets_db.test.js`, `tests/seed_sync_checked_in_files.test.js` → PASS.
- [ ] **Step 5:** commit `feat(images): seed sync carries web copies`.

### Task 8: Hostile creature art on demand (slice 2)

**Files:**
- Modify: `frontend/src/games/something2/src/js/core/Game.js` (`preloadSprites` :934, creature snapshot :1437, nearby wait :1645), `frontend/src/games/something2/src/js/entities/CreatureManager.js` (`_applyTypeVisuals` :22)
- Test: `frontend/src/games/something2/src/js/core/__tests__/creatureArtOnDemand.test.js`

**Interfaces:**
- Produces `Game.ensureEntityArt(typeName: string) -> Promise<void>` — idempotent per type; loads `def.image`, `def.sprite.atlas_key`, fetches + attaches `manifest_key` to the shared `def.sprite` (the per-def body of today's `preloadSprites`, extracted).
- `isHostileCreature(def) -> boolean` = `def.isCreature === true && def.faction === 'hostile'` (export from `systems/entryArt.js`).
- `CreatureManager` constructor option `onType(typeName)` called once per newly seen type in `_applyTypeVisuals`; Game passes `(n) => this.ensureEntityArt(n)`.

- [ ] **Step 1: Failing tests** (fake ImageManager recording `load` keys):
  - `preloadSprites skips hostile creatures`: types `{Wolf:{isCreature:true,faction:'hostile',image:'w'}, Guard:{isCreature:true,faction:'guard',image:'g'}, Merchant:{isCreature:false,pointKind:'merchant',image:'m'}, Tree:{isCreature:false,image:'t'}, Hero:{isCreature:false,image:'h'}}` → loads `g,m,t,h`, not `w`.
  - `first snapshot of a type loads its art once`: two `applySnapshot` with Wolf creatures → `load('w')` exactly once.
  - `nearby entry wait covers creatures in the snapshot`: wait names include `w` and `load('w')` was called before `whenSettled`.
  - existing `entryRaces.test.js`, `animationPrefs.test.js`, `CreatureManager.visuals.test.js` stay green (`_animOn` gating unchanged).
- [ ] **Step 2:** `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/creatureArtOnDemand.test.js` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS + the three existing files.
- [ ] **Step 5:** commit `feat(game): load hostile creature art on first sight`.

### Task 10: Auto-shrink new and regenerated art (run after Task 8, before Task 9)

**Files:**
- Create: `backend/src/services/imageAutoShrink.js`
- Modify: `backend/src/services/gameSettings.js` (key `image_auto_shrink`, boolean, default true), `backend/src/index.js` (start the sweep at boot; poke from entity/tile image + sprite approval routes), `backend/src/api/spriteBatchRoutes.js` (poke after "use good frames"), `backend/src/services/spriteJobQueue.js` (poke after approval write), `backend/src/services/catalogSubjects.js` (poke after art write), seed apply of the art group (poke after apply), `frontend/src/games/something2/ImagesAdmin.jsx` + `useImages.js` (toggle bound to the setting; history shows `auto`)
- Test: `backend/tests/image_auto_shrink_db.test.js`

**Interfaces:**
- Consumes: `listImages`/`shrinkSubject` (Task 3), `imageShrinkRun.startRun`/`getRun` (Task 5), game settings getter.
- Produces: `findAutoShrinkWork(pool, store, { checkEtags: boolean }) -> Array<{ subject, params|null }>` (no variant → `null` = kind default; stale → previous params; undone and not stale → excluded; last op for the current original was an auto `failed` → excluded); `runAutoShrinkSweep(pool, store, { checkEtags }) -> view|null` (null when setting off, nothing to do, or a run is active); `requestAutoShrink()` (debounced 5 s, `checkEtags:false`); `startAutoShrinkTimer(pool, store, { intervalMs = 120000 })` / `stopAutoShrinkTimer()`.
- Ops from the sweep: `actor` NULL, `params.auto = true`.

- [ ] **Step 1: Failing tests** (private DB, fake store, real sharp PNGs):
  - `new art gets a web copy`: entity with image, no variant → sweep → variant active, op `params.auto === true`, `actor` null.
  - `regenerated art is re-shrunk with previous params`: shrink with `maxEdge 200`, change the column to a new original → sweep → new variant from the new original with `maxEdge 200`.
  - `same-key rewrite needs the etag pass`: rewrite original bytes under same key → `checkEtags:false` finds nothing, `checkEtags:true` re-shrinks.
  - `undone is never auto-shrunk`: shrink then undo → sweep → still inactive, no new op.
  - `setting off does nothing`: `image_auto_shrink=false` → sweep returns null, no ops.
  - `busy runner skips`: a manual run active → sweep returns null, no ops.
  - `failed auto is not retried until the original changes`: corrupt original → one failed op; second sweep → no new op; change original → retried.
  - `sheet is built from original then shrunk`: a sprite column whose atlas is a PNG original → web_sprite set, original atlas untouched.
- [ ] **Step 2:** `node scripts/testdb.js run -- tests/image_auto_shrink_db.test.js` → FAIL.
- [ ] **Step 3:** implement; pokes are one-line calls wrapped so a poke error never fails the write route.
- [ ] **Step 4:** → PASS; re-run `tests/image_variants_db.test.js`, `tests/image_variant_routes_db.test.js`, and the touched routes' existing tests → PASS.
- [ ] **Step 5:** commit `feat(images): auto-shrink new and regenerated art`.

### Task 9: End-to-end check on a private stack

No product code. Never against the shared dev DB or bucket.

- [ ] **Step 1:** `node backend/scripts/testdb.js reset` → private `game_test` seeded; start a backend on a spare port with `DATABASE_URL=<testdb url>` and `MINIO_BUCKET=images-e2e-<date>` (create bucket, seed art into it), frontend pointed at it.
- [ ] **Step 2:** In headless Chrome (`--mute-audio`): open `game/images`, filter kind `entity`, batch Shrink all → run completes, History shows the batch, footer total drops.
- [ ] **Step 3:** Enter the game: Network panel shows `.webp` with `image/webp`, creature entity requests ≤ 40 KB, no Rime/Construct/Hive/Drowned requests in a village without them; creatures render the same size as before (screenshot before/after at the same spot).
- [ ] **Step 4:** Undo one creature → after ≤ 60 s reload the game requests its original PNG.
- [ ] **Step 5:** tear down the private backend, drop `game_test`, remove the e2e bucket. Record results in the Plane item.
