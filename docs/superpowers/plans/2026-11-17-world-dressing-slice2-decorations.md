# World Dressing — Slice 2: Decoration Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (owner chose native). Steps use checkbox (`- [ ]`) syntax.

**Goal:** 60 new decoration types (trees, bushes, ground cover, water plants, rocks, logs, underground and abyssal set pieces) placed in every biome, with approved GPU-box art, and a separate never-blocking ground layer so maps look full without more obstacles.

**Architecture:** Decorations stay `entity_types` rows placed by the one pure `generateChunkDecorations` (server `/chunk` + authority overlay share it; the client trusts the list). New: `entity_types.deco_layer` (`'main'|'ground'`); a second ground pass fills tiles the main pass left empty using only ground defs; `loadDecorationDefs` only returns types with art (the no-placeholder gate). Catalog rows live in `seeds/data/decorationTypes.js` with a `biomes` list each; `biomes.js` merges those into every biome's `flora_types`. Art comes from the existing art-job queue (`POST /api/art-jobs` + `/dispatch`, kind `entity`) on the GPU box.

**Tech Stack:** Node/Express CJS + pg (backend, `node --test`), Vite ESM client (vitest), node-pg-migrate.

**Spec:** `docs/superpowers/specs/2026-11-17-world-dressing-design.md` (Slice 2; owner raised the count to 60 on 2026-11-17).

## Global Constraints

- Exactly the 60 names in Task 3's table; names unique across `entity_types`.
- `deco_layer = 'ground'` ⇒ `walkable = true` (enforced by a DB check and a catalog test).
- `loadDecorationDefs` keeps `ORDER BY id ASC` (parity); adds `image IS NOT NULL AND image <> ''` and returns `deco_layer`.
- Existing 7 types keep their rows/weights; `NEW_DECORATIONS` existing 4 entries unchanged.
- `PATH_NAME_RE`, terrain banding, biome `terrain_tiles` order: untouched.
- Prompts are plain subjects via `styleEntityPrompt(...)` (framing added by the generator).
- Ground pass constants: `GROUND_SEED_XOR = 0x165667b1`, `GROUND_CELL = 4`, `GROUND_DENSITY = 0.35`, `GROUND_FILL = 0.55`, `GROUND_PICK_XOR = 0xd3a2646c`.
- Never mutate the shared dev DB destructively; DB tests via `node scripts/testdb.js run` (private DB). Seeding new catalog rows + art jobs on the dev DB is the normal workflow.
- Worktree `.worktrees/world-dressing-deco`, branch `feat/world-dressing-decorations`; commit subject `type(scope): summary (SOMET-772)`.

## Review Focus

1. **A new blocker seals a spawn/portal/village/road in some seeded world** → existing `authored_maps_navigability` / `navigability_roads` / `blackfen_sinks_navigable_seed` tests must stay green with the new defs passed in (Task 3 adds the new catalog to those fixtures' def source if they read it).
2. **Client/server parity**: the ground pass must be in `generateChunkDecorations` only (both consumers), never client-derived → Task 2 test that ground entries never carry `blocking: true` and that a tile is never in both passes.
3. **Types with no art yet** must not appear on the map (no coloured squares) → Task 1 loader test.
4. **Barren biomes**: every biome with non-empty `terrain_tiles` gets ≥1 decoration whose `spawn_tiles` intersects its terrain and whose `biomes` lists it → Task 3 invariant test.
5. **Authority cache**: after seeding, live authority worlds keep old defs until reloaded → Task 5 restarts the backend (dev) and the Plane comment states prod needs the same.

---

### Task 1: `deco_layer` column + loader art gate

**Files:** Create `backend/migrations/1714440891000_decoration_layer.js`; Modify `backend/src/services/decorationDefs.js`; Test `backend/tests/decorationDefs.test.js`.

**Interfaces — Produces:** `entity_types.deco_layer text NOT NULL DEFAULT 'main' CHECK (deco_layer IN ('main','ground'))` plus `CHECK (deco_layer = 'main' OR walkable = true)`; `loadDecorationDefs(pool)` → rows `{name, walkable, spawn_tiles, chance, deco_layer}`.

- [ ] Test: captured SQL still matches `/ORDER BY id/i`, now also `/image IS NOT NULL/i`, `/image <> ''/` and selects `deco_layer`.
- [ ] Run `cd backend && node --test tests/decorationDefs.test.js` → FAIL.
- [ ] Implement migration (up/down) + loader.
- [ ] Run → PASS. Commit `feat(decorations): ground layer column + art-gated loader (SOMET-772)`.

### Task 2: Ground pass in `generateChunkDecorations`

**Files:** Modify `backend/src/services/mapService.js:~624-829`; Test `backend/tests/mapService_decorations.test.js`.

**Interfaces — Consumes:** defs with `deco_layer`. **Produces:** entries `{name,row,col,blocking:false,ground:true}` for ground picks; main entries unchanged (no `ground` key).

Main pass skips `deco_layer === 'ground'` defs. For every tile the main pass did NOT fill (and not a carved path): ground density gate `globalValueNoise((seed ^ GROUND_SEED_XOR)>>>0, gRow, gCol, GROUND_CELL) >= GROUND_DENSITY`, fill roll `hash2((seed ^ GROUND_SEED_XOR ^ DECO_FILL_XOR)>>>0, gCol, gRow) < GROUND_FILL`, then the same biome-flora + spawn_tiles weighted pick among ground defs with `GROUND_PICK_XOR`.

- [ ] Tests: (a) with one main def (`Stone`, walkable false) and one ground def (`grass_tuft`, ground) on all-grass, output has both kinds, no tile appears twice, every `ground:true` entry has `blocking:false`; (b) a ground def never appears from the main pass (main-only def list ⇒ zero `ground` entries; ground-only list ⇒ zero non-ground entries); (c) determinism: two calls equal; (d) legacy: a def list with no `deco_layer` field behaves exactly as before (snapshot equal to calling with the same defs before the change — use the existing test's expected counts).
- [ ] FAIL → implement → PASS. Run the decoration/navigability test files: `node --test tests/mapService_decorations.test.js tests/decorationDefs.test.js tests/biomeDecorations.test.js tests/decoration_clearance.test.js tests/chunk_decorations_api.test.js`.
- [ ] Commit `feat(decorations): never-blocking ground layer pass (SOMET-772)`.

### Task 3: The 60-type catalog + biome wiring + seeding

**Files:** Modify `backend/seeds/data/decorationTypes.js` (add `WORLD_DRESSING_DECORATIONS`), `backend/seeds/data/biomes.js` (merge), `backend/scripts/seed-catalogs.js` (seed rows incl. `deco_layer`); Test `backend/tests/world_dressing_decorations_catalog.test.js` (new).

Each entry: `{ name, walkable, deco_layer, spawn_tiles, biomes, chance, display_width, display_height, color, prompt }`, `is_creature:false`, `render_mode:'static'`. Seeding uses the existing decoration upsert shape (insert; on conflict fill empty prompt only) plus `deco_layer`, and also re-asserts `spawn_tiles` and `deco_layer` on conflict for THESE rows (catalog facts, not admin edits — document it).

The 60 (walk = walkable; G = ground layer; size w×h):

| # | name | walk | layer | spawn_tiles | biomes |
|---|---|---|---|---|---|
| 1-2 | oak_tree_a, oak_tree_b (72×110) | no | main | grass, earth, leafs | Meadow, Deep Forest |
| 3-4 | birch_tree_a, birch_tree_b (60×110) | no | main | grass, highgrass, leafs | Meadow, Deep Forest, Highlands |
| 5 | willow_tree (80×110) | no | main | swamp, grass | Mire, Gloomfen |
| 6-7 | palm_tree_a, palm_tree_b (64×120) | no | main | sand, storm_shingle, jungle_floor | Storm Coast, Verdant Jungle, Arid Dunes |
| 8-9 | jungle_tree_a, jungle_tree_b (80×120) | no | main | jungle_floor, highgrass | Verdant Jungle |
| 10-11 | burnt_tree_a, burnt_tree_b (56×96) | no | main | ash_waste, ember_rock, earth, blight_floor | Ashfields, Blightworks, Deep Forest |
| 12 | snowy_pine (64×110) | no | main | snow, ice | Frozen Waste, Highlands |
| 13 | fallen_log (90×40) | no | main | grass, leafs, earth, swamp | Meadow, Deep Forest, Mire |
| 14 | mossy_log (90×40) | no | main | leafs, swamp, jungle_floor | Deep Forest, Verdant Jungle, Gloomfen |
| 15 | tree_stump (40×32) | yes | main | grass, leafs, earth, dirt | Meadow, Deep Forest, Highlands |
| 16-17 | cactus_a, cactus_b (44×80) | no | main | sand, dirt | Arid Dunes |
| 18 | berry_bush (44×40) | yes | main | grass, highgrass | Meadow, Deep Forest |
| 19-20 | fern_a, fern_b (40×36) | yes | main | leafs, highgrass, jungle_floor | Deep Forest, Verdant Jungle |
| 21-22 | dry_scrub_a, dry_scrub_b (40×32) | yes | main | sand, dirt, earth, rocks | Arid Dunes, Storm Coast, Sunken Ruins |
| 23 | snow_shrub (40×32) | yes | main | snow | Frozen Waste |
| 24 | thorn_bush (44×40) | yes | main | earth, dirt, ash_waste, blight_floor | Ashfields, Blightworks, Sunken Ruins |
| 25 | jungle_fern (48×44) | yes | main | jungle_floor | Verdant Jungle |
| 26 | heather (40×28) | yes | main | highland_rock, grass | Highlands |
| 27-28 | grass_tuft_a, grass_tuft_b (32×24) | yes | G | grass, highgrass, earth | Meadow, Deep Forest, Highlands, Verdant Jungle |
| 29-30 | flower_patch_a (yellow), flower_patch_b (blue) (32×20) | yes | G | grass, highgrass | Meadow, Highlands |
| 31 | clover_patch (32×18) | yes | G | grass, leafs | Meadow, Deep Forest |
| 32 | dune_grass (32×28) | yes | G | sand, storm_shingle | Arid Dunes, Storm Coast |
| 33 | frost_grass (32×24) | yes | G | snow, rime_floor | Frozen Waste, Frostvault |
| 34 | moss_patch (32×16) | yes | G | rocks, cave_floor, ruin_stone, leafs, cobblestone | Deep Forest, Sunken Ruins, Cavern, Catacombs |
| 35 | pebbles (28×14) | yes | G | earth, dirt, rocks, highland_rock, storm_shingle | Meadow, Highlands, Storm Coast, Arid Dunes, Cavern |
| 36 | fallen_leaves (32×14) | yes | G | leafs, earth | Deep Forest |
| 37-38 | reeds_a, reeds_b (40×56) | yes | main | water, swamp, cistern_shallows | Mire, Storm Coast, Sunken Cistern, Gloomfen |
| 39 | lily_pads (40×16) | yes | G | water, swamp | Mire, Gloomfen |
| 40 | cattails (36×60) | yes | main | swamp | Mire, Gloomfen |
| 41 | mangrove_roots (64×48) | yes | main | swamp, water | Mire |
| 42-43 | rock_small_a, rock_small_b (28×20) | yes | G | earth, dirt, rocks, grass, highland_rock, sand, storm_shingle | Meadow, Highlands, Arid Dunes, Storm Coast, Sunken Ruins |
| 44-45 | boulder_a, boulder_b (60×52) | no | main | rocks, highland_rock, earth | Highlands, Meadow, Cavern |
| 46 | mossy_rock (52×44) | no | main | grass, leafs, jungle_floor, ruin_stone | Deep Forest, Verdant Jungle, Sunken Ruins |
| 47 | sandstone_rock (56×48) | no | main | sand, dirt | Arid Dunes |
| 48 | basalt_rock (56×52) | no | main | ember_rock, ash_waste | Ashfields, Emberdepths |
| 49 | mushroom_cluster (36×32) | yes | G | cave_floor, fungal_floor, dirt, plague_floor, blight_floor | Cavern, Fungal Deep, Blightworks, Pestilent Deep |
| 50 | glowcap (32×32) | yes | G | fungal_floor, umbral_floor | Fungal Deep, Umbral Warren |
| 51 | giant_mushroom (60×90) | no | main | fungal_floor | Fungal Deep |
| 52 | crystal_cluster (48×56) | no | main | crystal_floor, rime_floor, ice | Crystal Hollows, Frostvault |
| 53 | stalagmite (36×64) | no | main | cave_floor, rocks, hive_floor | Cavern, Umbral Warren, Hive Warrens |
| 54 | bone_pile (40×24) | yes | G | bone_floor, crypt_floor, titan_floor, plague_floor, maw_floor | Ossuary, Catacombs, Grave of Titans, Pestilent Deep, The Maw |
| 55 | hive_lump (52×48) | no | main | hive_floor | Hive Warrens |
| 56 | rusted_scrap (40×24) | yes | G | vault_floor, foundry_floor | Deepvault, Sunken Foundry |
| 57 | broken_pillar (44×80) | no | main | ruin_stone, sanctum_floor, titan_floor, crypt_floor | Sunken Ruins, Fallen Sanctum, Grave of Titans, Catacombs |
| 58 | void_shard (40×72) | no | main | void_floor, chaos_floor, dream_floor | Abyssal Rift, Shattered Vault, Dreaming Dark |
| 59 | brimstone_vent (40×24) | yes | G | brimstone, ember_rock | Infernal Gate, Emberdepths |
| 60 | cistern_weed (36×20) | yes | G | cistern_shallows | Sunken Cistern |

Weights (`chance`): trees 0.12 per variant, logs/stumps 0.08, bushes 0.15, rocks 0.12, underground set pieces 0.15; ground layer 0.2 each (relative within the layer). Colours: any plausible hex (fallback only; art-gated anyway). Prompts: one concrete subject each, e.g. `styleEntityPrompt('a broad oak tree with a thick trunk and full round green crown')`; variants differ in the subject text (shape/season), not just a suffix.

`biomes.js`: export `BIOMES` built by mapping every biome to `flora_types: [...authored, ...namesListing(biome)]` (dedup, authored first). Do NOT touch terrain_tiles.

- [ ] Tests (catalog file): exactly 60 entries, unique names, none colliding with existing decoration/creature names in seeds; every `spawn_tiles` name exists in `tileTypes.js`; every `biomes` name exists in `biomes.js`; ground ⇒ walkable; every biome with terrain gets ≥1 placeable decoration (intersection of its terrain with a type listing it); each prompt non-empty and unique; display sizes > 0.
- [ ] FAIL → implement → PASS. Run backend suite via `cd backend && node scripts/testdb.js run > $SP/be.txt; echo $?` and compare against the main baseline (record baseline first).
- [ ] Commit `feat(decorations): 60-type world dressing catalog wired into biomes (SOMET-772)`.

### Task 4: Client — ground layer draws under actors

**Files:** Modify `frontend/src/games/something2/src/js/systems/RenderSystem.js` (`collectDecorations`); Test `frontend/src/games/something2/src/js/systems/__tests__/` (existing collectDecorations test file or new `groundDecorations.test.js`).

**Produces:** a drawable from an entry with `ground: true` has `order: -1` (draws before every order-0 actor/wall regardless of depth); others unchanged.

- [ ] Test → FAIL → implement → PASS; full frontend suite == baseline (2 known failures). Commit `feat(decorations): ground-layer decorations draw under actors (SOMET-772)`.

### Task 5: Seed, generate and approve art, export to seeds

- [ ] Land code on the dev stack's DB: run the migration + `make seed-catalogs` against the dev DB from the worktree code (docker exec with the worktree's files is not possible — the container mounts main; so run `node backend/scripts/seed-catalogs.js` on the host with the dev `DATABASE_URL` from `.env`, rewriting `db` → `localhost:15432`) and `node-pg-migrate up` likewise.
- [ ] Enqueue: `POST /api/art-jobs {kind:'entity', keys:[60 names]}` (active provider), then `POST /api/art-jobs/dispatch {provider_id}`; monitor `GET /api/art-jobs` until drained.
- [ ] Inspect every image (contact sheets of 12, read each); requeue any that is a tileset/framed card/wrong subject/opaque backdrop (`POST /api/art-jobs/requeue`), max 3 attempts, then rewrite that type's prompt and try once more; a type still failing is dropped from the catalog with a ledger ruling.
- [ ] `make art-export KIND=entity ONLY=<names>` → commit `backend/seeds/textures/entities/*` + manifest (fix root ownership per memory art-export-seed).
- [ ] Restart the dev backend so the authority reloads defs.

### Task 6: Verification

- [ ] `coverage.sh` against the dev backend: before numbers in the ledger; after must show (a) Deepvault/Hive worlds > 0, (b) total decorations up, (c) blocking share down or flat.
- [ ] Browser (muted headless Chrome): screenshots of Meadow, Deep Forest, Arid Dunes, Mire, Frozen Waste, a Hive Warrens world, an Ossuary world; no coloured boxes; ground cover under the player's feet.
- [ ] Final whole-branch review (fresh opus reviewer), fix Critical/Important TDD, land per standing authorization, Plane Done.
