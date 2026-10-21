# Biome Scenery Density Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill every biome with its own scenery: clumped "features" (trees, boulders, cacti) placed off-centre and blocking only a small circle at their base, plus several flat walk-through "ground cover" objects per tile.

**Architecture:** `generateChunkDecorations` stays the single pure, seeded source of scenery for the `/chunk` endpoint, the authority's collision and seeding's navigability check. It gains sub-tile offsets, a per-type blocking radius, per-biome densities and a second cover pass. Collision on both sides switches from "blocked tile → fixed centre square" to "circles inside the tile". The client draws features in the depth-sorted list at their own anchor and cover in a cheap ground pass beneath everything.

**Tech Stack:** Node/Express CommonJS backend (`node --test`), node-pg-migrate migrations, raw `pg`; React + canvas frontend (vitest, node env, no DOM).

**Spec:** `docs/superpowers/specs/2026-10-22-biome-scenery-density-design.md`

## Global Constraints

- Generator stays a pure function of (world seed, final tile grid, defs). Nothing is persisted. Output order is deterministic: features by (row, col), then cover by (row, col, emission index).
- Client `ChunkedMap.isWalkable` and server `ServerMap.isWalkable` must give identical answers for identical generator output.
- A blocking circle never crosses its tile's edge, so collision looks at one tile only.
- Ground cover never blocks and is never excluded by the spawn/portal/village blocker rules. It does skip carved path/road cells.
- Existing data only gains: the migration adds types, widens `spawn_tiles` and **appends** to `biomes.flora_types`. It never removes or reorders. Inserts are `ON CONFLICT (name) DO NOTHING`, except that an empty `prompt` is filled, the same policy as `scripts/seed-catalogs.js:597`.
- `backend/src/services/worldGen/worldGen.js` is NOT modified (byte-parity port of the GPU box generator).
- Null biome densities reproduce today's feature look: `feature_density` null → `DECO_FILL` (0.6); `cover_density` null → 0.
- DB-backed tests run against a scratch database with BOTH `DATABASE_URL` and `TEST_DATABASE_URL` set to it. Never mutate the shared dev DB.
- Work in a throwaway git worktree, never by switching the shared checkout's branch.
- A type with no art must never draw as a solid square. Cover without art is skipped. A feature without art draws a soft ellipse placeholder in the type's `color`, so collision and visuals stay consistent.

## Review Focus

1. **Legacy defs without the new columns** (an older authority cache, or test fixtures with only `name/walkable/spawn_tiles/chance`) must behave as features with default radius. Test in Task 2.
2. **A biome whose flora lists only cover types, or only features**, must still place what it can, with no crash and no empty-pick NaN. Test in Task 2.
3. **Cover on a carved path / road / village wall cell** must not appear, or trails become unreadable. Test in Task 2.
4. **A player standing exactly on a circle's edge, or at a tile corner next to a blocker**, must get the same answer from client and server. Mirror test in Task 3.
5. **A world whose `feature_density` / `cover_density` is garbage** (negative, NaN, string from the admin form) must clamp to a sane value, not break a whole world. Tests in Task 2 (normalisation) and Task 6 (API validation).

---

## File Structure

- `backend/migrations/<next-ts>_biome_scenery.js` — columns + additive catalogue rollout (Task 1).
- `backend/seeds/data/sceneryCatalog.js` — NEW. Single source of the new types, widened spawn tiles, per-biome additions and densities (Task 1). Consumed by the migration and `scripts/seed-catalogs.js`.
- `backend/src/services/decorationDefs.js` — select the new columns (Task 2).
- `backend/src/services/biomes.js`, `backend/src/services/mapService.js` (`normalizeBiomes`, `generateChunkDecorations`) — densities + generator (Task 2).
- `backend/src/authority/collision.js`, `frontend/.../core/ChunkedMap.js` — circle collision (Task 3).
- `backend/src/index.js` `/chunk` handler (~5711), `frontend/.../net/chunkFetcher.js`, `net/ChunkStreamer.js` — cover payload (Task 4).
- `frontend/.../systems/RenderSystem.js` — feature anchoring, cover pass, placeholder (Task 5).
- `EntityTypesAdmin.jsx`, `BiomesAdmin.jsx`, entity/biome CRUD in `index.js` — admin fields (Task 6).
- `backend/scripts/scenery-report.js` — NEW. Read-only per-biome report (Task 7).

(`frontend/...` = `frontend/src/games/something2/src/js`.)

---

### Task 1: Scenery catalogue, columns and additive rollout

**Files:**
- Create: `backend/seeds/data/sceneryCatalog.js`
- Create: `backend/migrations/<next free timestamp after 1714440824000>_biome_scenery.js`
- Modify: `backend/scripts/seed-catalogs.js` (decoration upsert loop ~597; biome seeding)
- Modify: `backend/seeds/data/biomes.js` (end-state flora lists + densities so a fresh seed equals a migrated DB)
- Test: `backend/tests/scenery_catalog.test.js` (pure), `backend/tests/scenery_migration_db.test.js` (scratch DB)

**Interfaces:**
- Produces `sceneryCatalog.js` exports:
  - `SCENERY_TYPES: Array<{ name, scenery_layer: 'feature'|'cover', walkable: boolean, block_radius: number, max_per_tile: number, spawn_tiles: string[], chance: number, display_width: number, display_height: number, color: string, prompt: string }>`
  - `SPAWN_TILE_ADDITIONS: { [existingTypeName]: string[] }` (e.g. `Stone: ['cave_floor','cobblestone','crypt_floor', ...]`)
  - `BIOME_SCENERY: { [biomeName]: { add: string[], feature_density: number|null, cover_density: number } }`, covering all 32 biomes.
  - `EXISTING_BLOCK_RADIUS: { Tree: 12, pine_tree: 10, dead_tree: 10, Stone: 14, IceRock: 14 }`
- DB columns: `entity_types.scenery_layer text NOT NULL DEFAULT 'feature' CHECK (IN ('feature','cover'))`, `entity_types.block_radius integer` (null = default), `entity_types.max_per_tile integer NOT NULL DEFAULT 2`, `biomes.feature_density real` (null), `biomes.cover_density real NOT NULL DEFAULT 0`.

- [ ] **Step 1: Write the failing pure catalogue tests** in `scenery_catalog.test.js`:
  - `every SCENERY_TYPES name is unique and not an existing decoration name` (check against `NEW_DECORATIONS` names + `Tree`, `Stone`, `IceRock`).
  - `cover types are walkable with block_radius 0`.
  - `blocking features have 1 <= block_radius <= 20` (so the jitter window in Task 2 is never empty).
  - `every biome in seeds/data/biomes.js has a BIOME_SCENERY entry with cover_density in [0, 3] and feature_density null or in [0, 1]`.
  - `every biome gets at least one cover type that spawns on one of its terrain_tiles` (resolve the biome's end-state flora = seed flora ∪ `add`, intersect with cover types whose `spawn_tiles` meet `terrain_tiles`).
  - `every non-empty-floor biome gets at least one feature type that spawns on its terrain`. This closes the "listed but never spawns" gap. Walls/chasm/water floors don't count.
  - `every spawn_tiles entry names a real tile type`. Read names from `backend/seeds/data` tile-type seed, or hard-code the 50 names listed in the spec's DB dump if no seed module exports them.
  - `every type has a non-empty prompt built with styleEntityPrompt`. Cover prompts describe a flat, low object.
  - Content: the spec's catalogue table (section "Scenery catalogue") is the starting list. Cover sizes are 16–32 px; feature sizes follow existing trees/rocks.

- [ ] **Step 2: Run** `cd backend && node --test tests/scenery_catalog.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Write `sceneryCatalog.js`** to satisfy the tests. Update `seeds/data/biomes.js` flora lists to the end state (existing ∪ add, existing order first) and add `feature_density` / `cover_density` there.

- [ ] **Step 4: Run** the catalogue test. Expected: PASS.

- [ ] **Step 5: Write the failing migration DB test** `scenery_migration_db.test.js`:
  - `up adds the five columns with their defaults`.
  - `up inserts every SCENERY_TYPES row and sets EXISTING_BLOCK_RADIUS`.
  - `up appends to flora_types without removing or reordering`. Pre-set one biome's flora to a custom list including a non-catalogue name, run up, and assert the custom list is a prefix of the result.
  - `up is idempotent`: running up twice gives the same rows.
  - `an admin-edited type is not overwritten`: change a seeded type's chance, re-run up, and assert it's unchanged.

- [ ] **Step 6: Run** it against a scratch DB, expecting FAIL: `DATABASE_URL=$SCRATCH TEST_DATABASE_URL=$SCRATCH node --test tests/scenery_migration_db.test.js`.

- [ ] **Step 7: Write the migration.** `require('../seeds/data/sceneryCatalog.js')` at the top, following the `1714440042000_decoration_types.js` precedent. Use `ADD COLUMN IF NOT EXISTS`. Append flora with one `UPDATE biomes SET flora_types = flora_types || $missing::jsonb` per biome, where `$missing` = names not already present. `down` drops the columns only (it leaves rows alone).

- [ ] **Step 8: Extend `scripts/seed-catalogs.js`** to upsert `SCENERY_TYPES` with the same prompt-fill-only policy, and to write the new columns for rows it inserts.

- [ ] **Step 9: Run** both tests plus `tests/decoration_types_seed.test.js` and `tests/decorationDefs.test.js`. Expected: PASS.

- [ ] **Step 10: Commit** `feat(scenery): catalogue, columns and additive rollout for biome scenery`.

---

### Task 2: Generator: offsets, radius, per-biome density, cover pass

**Files:**
- Modify: `backend/src/services/decorationDefs.js:21-31`
- Modify: `backend/src/services/biomes.js:28` (select the two density columns)
- Modify: `backend/src/services/mapService.js` (`normalizeBiomes` ~166, constants ~620, `generateChunkDecorations` ~776)
- Test: `backend/tests/scenery_generator.test.js`; keep green: `mapService_decorations.test.js`, `biomeDecorations.test.js`, `decoration_clearance.test.js`, `chunk_decorations_api.test.js`, `navigability*.test.js`, `authority_collision.test.js`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces:
  - `loadDecorationDefs(pool)` rows add `scenery_layer, block_radius, max_per_tile` (still `ORDER BY id ASC`).
  - Normalised biome adds `featureDensity: number` (null/invalid → `DECO_FILL`, clamped to [0,1]) and `coverDensity: number` (null/invalid → 0, clamped to [0,3]).
  - `generateChunkDecorations(world, cx, cy, tiles, defs, opts = { cover: true })` returns `Array<Feature|Cover>`:
    - `Feature = { name, row, col, ox, oy, blocking, radius, layer: 'feature' }`
    - `Cover = { name, row, col, ox, oy, blocking: false, radius: 0, layer: 'cover' }`
    - `ox, oy` are integer tile-local pixels in [0,100]. `radius` is px (0 when walkable).
    - With `opts.cover === false` only features are returned (the authority and navigability pass this).
  - Exported constant `DEFAULT_BLOCK_RADIUS = 12`, used when a blocking def has null `block_radius`.

- [ ] **Step 1: Write failing tests** in `scenery_generator.test.js` (fixture style as `mapService_decorations.test.js:5-15`):
  - `legacy defs with no layer/radius act as features with DEFAULT_BLOCK_RADIUS` (Review Focus 1).
  - `feature anchor keeps its blocking circle inside the tile`: for every blocking feature, `radius <= ox <= 100-radius` and the same for `oy`.
  - `feature offsets vary`: over a 32x32 world, not every feature is at (50,50).
  - `at most one feature per tile; cover count per tile <= sum of max_per_tile of eligible cover types`.
  - `cover is never blocking and never on a path cell` (use a world with `pathCell` set, as in the existing path tests) (Review Focus 3).
  - `cover ignores the spawn blocker exclusion but features still honour it` (reuse the `decoration_clearance.test.js` setup).
  - `coverDensity 0 yields no cover; coverDensity 2 yields roughly 2 per eligible tile` (mean within ±25% over 32x32).
  - `featureDensity scales feature count` (0 → none; 1 → more than the 0.6 default).
  - `biome with only cover flora places cover and no features, no NaN` and the reverse (Review Focus 2).
  - `normalizeBiomes clamps garbage densities` (`-1`, `NaN`, `'x'`, `9`) (Review Focus 5).
  - `deterministic: same input twice is deepEqual; opts.cover=false equals the feature subset of the full output`.
  - Existing tests asserting `{name,row,col,blocking}` shape: update them to `assert.partialDeepStrictEqual` or field picks, not by deleting the assertion.

- [ ] **Step 2: Run** `node --test tests/scenery_generator.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.** Feature pass = current loop, plus:
  - Fill gate uses `region.featureDensity` instead of `DECO_FILL` (no biomes → `DECO_FILL`).
  - Eligible defs exclude `scenery_layer === 'cover'`.
  - Offsets: `J = min(25, 50 - radius)`, `ox = 50 + round((hash2(seed ^ DECO_OFFX_XOR, gCol, gRow) - 0.5) * 2 * J)`, same for `oy` with `DECO_OFFY_XOR`. Use new distinct salts.

  Cover pass, per in-bounds, non-path tile with `region.coverDensity > 0`:
  ```
  eligible = cover defs in region flora whose spawn_tiles include terrain
  n = floor(coverDensity + hash2(seed ^ COVER_N_XOR, gCol, gRow))   // stochastic rounding
  for k in 0..n-1:
    pick weighted by chance among eligible whose per-tile count < max_per_tile (stop if none left)
    ox, oy = 10 + floor(hash2(seed ^ COVER_X_XOR ^ (k * 0x9e3779b1), gCol, gRow) * 81), likewise oy
  ```
  Cover is emitted after all features.

- [ ] **Step 4: Run** the new test plus every "keep green" file above. Expected: PASS. If a navigability test now fails on a shipped world, fix the generator/exclusions; do not loosen the test.

- [ ] **Step 5: Pass `{ cover: false }`** at the authority (`collision.js:195`) and navigability (`navigability.js`) call sites.

- [ ] **Step 6: Commit** `feat(scenery): sub-tile features, per-biome density and a ground-cover pass`.

---

### Task 3: Circle collision, mirrored client/server

**Files:**
- Modify: `backend/src/authority/collision.js:143-224` (`blockedDecoTiles`, `blockedDecorationsFor`, `isWalkable`)
- Modify: `frontend/src/games/something2/src/js/core/ChunkedMap.js:37-96` (`setChunk`, `isWalkable`)
- Test: `frontend/src/games/something2/src/js/core/__tests__/sceneryCollisionMirror.test.js` (requires the backend modules, as `skillsCatalogParity.test.js:14` does); update `backend/tests/authority_collision.test.js`

**Interfaces:**
- Consumes: Task 2 `Feature` shape.
- Produces: on both sides, the per-chunk blocked structure is `Map<"lr,lc", Array<{ x: number, y: number, r: number }>>` (tile-local px). `isWalkable(worldX, worldY)` returns false when the point is within `r` (inclusive, `dx*dx + dy*dy <= r*r`) of any circle in its tile. The client builds the map in `setChunk` from `decorations.filter(d => d.blocking)`.

- [ ] **Step 1: Write the failing mirror test.** Build a backend `ServerMap` for a fixture world with blocking defs. Generate chunk (0,0)'s decorations with the backend generator and feed the same list into a client `ChunkedMap.setChunk`. For a 5 px grid over the chunk, plus each circle's exact edge points, assert `client.isWalkable === server.isWalkable` everywhere (Review Focus 4). Also assert:
  - `a point at a feature's anchor is blocked`;
  - `a point at the tile centre of a tile whose feature is offset is walkable when outside the circle`.

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/sceneryCollisionMirror.test.js`. Expected: FAIL on the offset/centre assertions.

- [ ] **Step 3: Implement** the circle structure and test on both sides. Replace the "~36x36" comments with the real rule.

- [ ] **Step 4: Run** the mirror test and `cd backend && node --test tests/authority_collision.test.js tests/navigability.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(scenery): blockers collide as per-type circles at their anchor, client and server`.

---

### Task 4: Compact cover over `/chunk`

**Files:**
- Modify: `backend/src/index.js` `/chunk` handler (~5711 and ~5720)
- Modify: `frontend/.../net/chunkFetcher.js:18`, `net/ChunkStreamer.js:53`, `core/ChunkedMap.js` (`setChunk`, `removeChunk`, new `coverInChunk`)
- Test: extend `backend/tests/chunk_decorations_api.test.js`; `frontend/.../net/__tests__/chunkFetcher.test.js` (create if absent)

**Interfaces:**
- Response: `decorations` carries only features (the full `Feature` objects). New field `cover: { types: string[], cells: number[] }`, where `cells` is a flat array of 5-tuples `[typeIndex, row, col, ox, oy, ...]` in generator order. `cover` is `{ types: [], cells: [] }` when there is none.
- Client: `fetchChunk` resolves `{ tiles, decorations, cover, biomes }`. `ChunkedMap.setChunk(cx, cy, grid, decorations = [], biomes = null, cover = null)` stores it. `coverInChunk(cx, cy) -> { types, cells }` (empty object shape when absent).

- [ ] **Step 1: Write failing tests.**
  - API: `response cover decodes to exactly the generator's cover entries`. Decode the tuples and deepEqual them against `generateChunkDecorations(...).filter(d => d.layer === 'cover')` with `name/row/col/ox/oy` picked. Also assert `decorations has no cover entries`.
  - Client: `chunkFetcher passes cover through and defaults it`.
- [ ] **Step 2: Run** both. Expected: FAIL.
- [ ] **Step 3: Implement** the encode (backend) and pass-through/storage (client).
- [ ] **Step 4: Run.** Expected: PASS. Record the JSON byte size of one dense-biome chunk response in the commit message as a baseline.
- [ ] **Step 5: Commit** `feat(scenery): ship ground cover to the client as a compact tuple array`.

---

### Task 5: Rendering: anchored features, cover ground pass, no-art placeholder

**Files:**
- Modify: `frontend/.../systems/RenderSystem.js` (`collectDecorations` ~280; new `static collectCover(chunkedMap, camera, decoTypes)`; draw call inserted before `buildDrawables` at ~483; placeholder branch where `drawEntity` falls back to `fillRect` for decorations)
- Test: `frontend/.../systems/__tests__/sceneryRender.test.js`

**Interfaces:**
- Consumes: Task 4 `coverInChunk`, Task 2 feature `ox/oy`.
- Produces:
  - `collectDecorations` sets `ref.x = tileX + ox - 50`, `ref.y = tileY + oy - 50` (so `drawEntity`'s centring lands on the anchor) and `depth = depthKey(tileX + ox, tileY + oy)`. A missing `ox/oy` defaults to 50.
  - `collectCover(...) -> Array<{ img, x, y, w, h }>`: world-space anchor-bottom-centred quads for cover in camera view. Types with no loaded image are skipped.
  - Placeholder: a decoration whose type has no `image`/`sprite` draws a soft ellipse (`type.color`, ~0.6 alpha, `display_width x display_height/3`) at its anchor instead of `fillRect`.

- [ ] **Step 1: Write failing tests** (pure, no canvas):
  - `feature drawable depth follows its anchor`: two features in one tile with oy 30 and 70; the oy 70 one sorts later under `compareDrawables`.
  - `missing ox/oy keeps the old tile-centre anchor`.
  - `collectCover skips types without an image and culls outside the camera rect`.
  - `cover never appears in the sorted drawables list`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Draw cover right after the ground/tile layer and before the sorted list. Allocate no objects per frame beyond the returned array: cache resolved images per type name. Implement the placeholder branch.
- [ ] **Step 4: Run** the new test plus existing RenderSystem/inspect tests. Also grep `inspect.js` and the minimap for one-decoration-per-tile assumptions (`decorationsInChunk`, `row,col` keys). Fix any hit with a test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scenery): draw features at their anchor and ground cover beneath actors`.

---

### Task 6: Admin fields

**Files:**
- Modify: `frontend/src/games/something2/EntityTypesAdmin.jsx` (~954-1040, the walkable/spawn_tiles block)
- Modify: `frontend/src/games/something2/BiomesAdmin.jsx` (form + card)
- Modify: `backend/src/index.js` biome CRUD (~2656-2830, follow `biomeCreatureDensity` at ~2674) and the entity-type create/update routes (find with `grep -n "entity-types" backend/src/index.js`)
- Test: `backend/tests/scenery_admin_api_db.test.js` (scratch DB); existing admin smoke tests stay green

**Interfaces:**
- API accepts and returns `scenery_layer`, `block_radius`, `max_per_tile` on entity types, and `feature_density`, `cover_density` on biomes.
- Validation:
  - `scenery_layer` ∈ {feature, cover}, else 400.
  - `block_radius` integer 0–20 or null.
  - `max_per_tile` integer 1–6.
  - `feature_density` null or a number clamped to [0,1].
  - `cover_density` a number clamped to [0,3].
  - Numeric strings are coerced; the response must return numbers, not NUMERIC strings.

- [ ] **Step 1: Write failing API tests**: round-trip of each field; a 400 for a bad layer; clamping of `cover_density: 9` → 3 and `'abc'` → 0 (Review Focus 5); `set → reopen → edit other field → save` keeps the values.
- [ ] **Step 2: Run** against the scratch DB. Expected: FAIL.
- [ ] **Step 3: Implement** the API, then the form fields. The Entities form shows "Layer" (feature/cover), "Block radius (px)" (only when not walkable) and "Max per tile" (only for cover). The Biomes form shows "Feature density" and "Cover density" next to the existing creature density.
- [ ] **Step 4: Run** the API test plus `npx vitest run` for the admin smoke tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scenery): edit layer, block radius and biome densities in admin`.

---

### Task 7: Scenery report, tuning, and live verification

**Files:**
- Create: `backend/scripts/scenery-report.js` (read-only)
- Modify: `backend/seeds/data/sceneryCatalog.js` (tuning values only), plus a follow-up migration only if tuned values must reach existing DBs. Same additive policy; densities may be updated only where the stored value still equals the previous seed value.

**Interfaces:**
- `node scripts/scenery-report.js [--chunks 6]` loads defs (`loadDecorationDefs`) and biomes from `DATABASE_URL` with SELECTs only. For each biome it builds a synthetic single-biome world config, generates N chunks and prints a table: biome, features, cover, blockers, blocking share. It ends with the overall blocking share.

- [ ] **Step 1: Write the script.** Exit 0 always: it's a report, not a gate (user decision).
- [ ] **Step 2: Run it** against a scratch DB that has been migrated and seeded. Tune `chance`, `feature_density` and `cover_density` in the catalogue until the overall blocking share is about 10% and no biome's features are all blockers. Paste the final table into the commit message.
- [ ] **Step 3: Run the full suite twice on the scratch DB** (`cd backend && DATABASE_URL=$SCRATCH TEST_DATABASE_URL=$SCRATCH npm test`, then `cd frontend && npm test`). The second run catches fail-then-pass on a fresh DB. Compare against main's known-red list, so no new failures.
- [ ] **Step 4: Browser verification** on an isolated vite (worktree, proxy to the shared backend after the migration is merged; or an isolated backend on the scratch DB). Walk a forest, a desert and a crypt and confirm:
  - several objects per tile;
  - cover beneath the player's feet;
  - walking behind tree crowns but blocked at the trunk;
  - no rubber-banding (client/server agree);
  - placeholder ellipses for art-less features, never squares;
  - frame rate comparable to before (compare `requestAnimationFrame` intervals with cover on and off).

  Save screenshots to the scratchpad.
- [ ] **Step 5: Commit** `chore(scenery): tune biome scenery densities and add scenery report`.

Art for the new types is generated afterwards by the user from the Art Generation tab (subject kind `entity`). It is not part of this plan's completion.
