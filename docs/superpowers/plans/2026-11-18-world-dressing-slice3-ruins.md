# World Dressing — Slice 3: Generated Ruin Sites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (owner chose native). Steps use `- [ ]`.

**Goal:** Every bounded world (except boss arenas and `*: Hub` worlds) gets a seeded scatter of half-destroyed buildings — broken wall rings with walkable gaps — in a style that matches its biome, without ever sealing a required point.

**Architecture:** Ruins are persisted, fully resolved stamps in a new `worlds.structures` jsonb column (`[]` default). `buildWorldGenConfig` passes them through and `generateRegion` stamps them after villages, so /chunk, the authority, seed-map's guard, population and the scanners all see them from the row they already load. A pure `generateStructureSites` places candidates and accepts a site only if `assertNavigable` (decorations included) still passes with the site's interior added as a required tile. `ensureStructures` (service) + `scripts/seed-structures.js` write rows and clear `world_chunks`; seed-map calls it per world before its navigability guard.

**Tech Stack:** Node CJS + pg, node:test; GPU-box art queue (kind `tile`).

**Spec:** `docs/superpowers/specs/2026-11-17-world-dressing-design.md` (Slice 3 + "Decisions settled after builder check").

## Global Constraints

- New tiles (append to `DEFAULT_TILE_TYPES`, never reorder): `ruined_wall` (wall_height 32), `burnt_wall` (32), `mossy_wall` (32), `weathered_wall` (24) — all `walkable:false`; `rubble_floor`, `charred_floor` — `walkable:true`, speed 0.95. No name may match `PATH_NAME_RE` (`/path|dirt|road|trail|earth|sand/i`) — hence `weathered_wall`, not `sandworn_wall`.
- Stored stamp shape (one array element): `{ type, minRow, minCol, width, height, wallTile, floorTile, gaps: [[row,col],...], source: 'auto' }`. Stamping never reads the catalog.
- Sizes: width 3–5, height 3–4. Ring keep fraction `wall_keep` per style (0.5–0.7); ≥ 2 gaps, on ≥ 2 different sides.
- Count per world: `min(STRUCTURE_CAP=16, floor(width*height / 700))`; attempts `count*40`.
- Placement exclusions (Chebyshev radius from the cell): map edge 2; carved paths/roads 1; village footprint+houses ring 4; doorway arrival / portal ends / entry spawn / village spawns / dungeon boss / chests / waypoints 4; pens and saved character positions 2; persisted creatures 0 (their tile only); other sites 2.
- Whole footprint + 1-ring margin: in bounds, walkable terrain, one biome region (`sampleBiomeRegion` same record), the region's biome has a style.
- Eligible worlds: bounded, name not `Boss Arena:%`, not ending `: Hub`.
- Persisted ruins are re-validated whenever `ensureStructures` runs: an `auto` site whose footprint is no longer all walkable / in bounds is dropped and re-rolled; a valid one is kept byte-identical.
- Branch `feat/world-dressing-ruins`, commits `type(scope): summary (SOMET-773)`.

## Review Focus

1. **A ruin seals something** — every accepted site passes `assertNavigable(noGeneratedRoads, required + interiors, {decorationDefs})`; Task 4 tests a corridor fixture where a candidate would close it and must be rejected.
2. **Parity** — the authority's explicit `SELECT` must include `structures` (Task 3 test reads authority/server.js); every other builder site uses `SELECT *`.
3. **Catalog edits never move live ruins** — stamping reads only the stored stamp (Task 3 test: same stamp, catalog changed ⇒ same grid).
4. **Re-seed with changed terrain** — invalid auto sites dropped/re-rolled, valid ones untouched (Task 5 test).
5. **Stale caches** — `world_chunks` for every changed world is deleted; the backend must restart (authority caches loadWorld) — deploy step.

---

### Task 1: Ruin tiles
**Files:** `backend/seeds/data/tileTypes.js`; Test `backend/tests/tile_catalog_integrity.test.js` (or new `ruin_tiles.test.js`).
- [ ] Test: the 6 names exist with the walkable/wall_height above; none matches `PATH_NAME_RE`; prompts non-empty (walls via `wall(...)`, floors via `floor(...)`); appended after every pre-existing tile (index > index of `road_ash`).
- [ ] FAIL → implement → PASS → commit `feat(ruins): ruin wall and floor tiles (SOMET-773)`.

### Task 2: Structure style catalog
**Files:** Create `backend/seeds/data/structureTypes.js` exporting `STRUCTURE_TYPES` (`{ name, biomes, wallTile, floorTile, sizes:[[w,h]...], wallKeep, weight }`); Test `backend/tests/structure_types_catalog.test.js`.
Styles: `overgrown_hut` (Meadow, Verdant Jungle; mossy_wall/rubble_floor), `burned_cabin` (Deep Forest, Ashfields, Blightworks; burnt_wall/charred_floor), `broken_watchtower` (Highlands, Sunken Ruins, Grave of Titans; ruined_wall/rubble_floor, sizes [[3,3]]), `buried_walls` (Arid Dunes, Storm Coast; weathered_wall/rubble_floor), `snowed_hut` (Frozen Waste, Frostvault; ruined_wall/rubble_floor), `rotted_stilts` (Mire, Gloomfen; burnt_wall/rubble_floor), `collapsed_crypt` (Catacombs, Ossuary, Cavern, Fungal Deep, Hive Warrens, Deepvault, Sunken Foundry, Fallen Sanctum; ruined_wall/rubble_floor).
- [ ] Test: names unique; biomes exist in `STARTER_BIOMES`; tiles exist in `DEFAULT_TILE_TYPES` with wall/floor walkability as expected; sizes within 3–5 × 3–4; 0.5 ≤ wallKeep ≤ 0.7; no biome in two styles.
- [ ] FAIL → implement → PASS → commit.

### Task 3: Persisted stamps reach every generator
**Files:** Create `backend/migrations/1714440892773_world_structures.js` (`worlds.structures jsonb NOT NULL DEFAULT '[]'`); modify `backend/src/services/worldGenConfig.js` (`structures: Array.isArray(row.structures) ? row.structures : []`), `backend/src/authority/server.js:843` (add `structures` to the SELECT), `backend/src/services/mapService.js` (`stampStructures(grid, rMin, cMin, rows, cols, structures)` called in `generateRegion` after villages; ring cells → `wallTile` unless in `gaps` → `floorTile`; interior → `floorTile`); Tests `backend/tests/structures_stamp.test.js`, `backend/tests/worldGenConfig.test.js` (key list gains `structures`).
- [ ] Tests: a 4×3 stamp with gaps [[r,c]] renders ring walls, gap floor, interior floor; cells outside untouched; chunk seam: stamping a site straddling two chunks gives the same cells as one region; `generateRegion` output identical to before for `structures: []`; authority SELECT text contains `structures`.
- [ ] FAIL → implement → PASS → run decoration/navigability pure tests → commit.

### Task 4: Pure site generator
**Files:** Create `backend/src/services/structureSites.js` exporting `generateStructureSites(world, { styles, decorationDefs, required, avoid, keep = [] })` → array of stamps; Test `backend/tests/structure_sites.test.js`.
`world` is a world config (as from `buildWorldGenConfig`, `noGeneratedRoads` NOT set: live roads count as roads). `required` = [{row,col,what}] (arrival points etc.), `avoid` = [{row,col,radius}]; `keep` = already-valid stored sites (kept first, count toward the target). Seeded with `hash2(seed ^ STRUCTURE_SEED_XOR, i, j)`; each accepted site is validated by `assertNavigable({...world, structures: [...accepted, site], noGeneratedRoads: true}, [...required, ...interiorCenters], { decorationDefs })` returning no problems.
- [ ] Tests: deterministic; every site obeys the exclusions (on a fixture with a village, a path and an avoid point); footprint terrain walkable + one biome; ≥ 2 gaps on ≥ 2 sides; interior reachable from the entry spawn; a narrow-corridor fixture where the only fitting spot would seal the corridor yields no site there; world with no styled biome → []; `keep` sites returned unchanged and not overlapped.
- [ ] FAIL → implement → PASS → commit.

### Task 5: `ensureStructures` + script + seed-map hook
**Files:** Create `backend/src/services/worldStructures.js` (`ensureStructures(client, worldId, { decorationDefs, regenerate=false, log })` → `{ kept, added, dropped, skipped }`), `backend/scripts/seed-structures.js` (`--world`, `--dry-run`, `--regenerate`), Makefile target `seed-structures`; modify `backend/scripts/seed-map.js` (call per world before the navigability guard); Tests `backend/tests/world_structures_db.test.js` (TEST_DATABASE_URL gated).
Loads row, links, villages, biomes, tile types, and avoid points from `world_chests`, `waypoints`, `pens`/`pen` creatures, `world_creatures`, `characters` (x,y of that world). Skips ineligible worlds. Re-validates stored auto sites; writes `structures`; `DELETE FROM world_chunks WHERE world_id` when changed.
- [ ] Tests: idempotent (second call kept=N, added=0, no write); Boss Arena / Hub skipped; a stored site made invalid (terrain changed under it) is dropped and re-rolled; a persisted creature's tile and a character position are never inside a footprint; chunks deleted only when changed; seed-map applies all shipped specs cleanly (existing test) with ruins on.
- [ ] FAIL → implement → PASS → commit.

### Task 6: Tile art
- [ ] Insert the 6 tile rows in the dev DB (seed-catalogs from the worktree after applying the migration), enqueue `POST /api/art-jobs {kind:'tile', keys:[6]}`, inspect (walls must tile as a vertical surface; floors as seamless ground), redraw with corrections as needed, export with `artSeed.exportArt({kinds:['tile'], only})` via the HTTP store into `seeds/textures/tiles`, commit.

### Task 7: Rollout + verification
- [ ] Dev DB: migration, seed-catalogs, `seed-structures` (dry-run first, record counts), then the branch backend on :13201 + branch vite.
- [ ] Roads-off seal scan of all dev worlds with ruins: 0 sealed. Count ruins per world / style.
- [ ] Browser: one screenshot per style; walk through a gap into a ruin.
- [ ] Full backend + frontend suites vs main baseline; final whole-branch review (fresh opus); fix; land; Plane Done with deploy steps (migration → seed-catalogs → art-seed → seed-structures → restart backend).
