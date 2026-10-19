# Seed/Export Plan 4a: Maps Through Spec Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maps travel between PCs as the checked-in `.map.json` spec files, which the GPU box generates. The Seed / Export tab's **Maps** row does three things:
- It seeds changed specs on this PC (full apply plus world rebuild).
- It writes the admin's hand edits back into the spec files.
- It pushes those edits to the GPU box when the box is reachable.

**Architecture:**
- Maps is a seed-sync group with its own **adapter**, not TableSpecs. Its unit of sync is a spec file, not a DB row.
- A manifest `backend/seeds/sync/maps.json` lists the spec files with their hashes and names the entry world.
- A per-PC table records the spec hash applied here, exported from here, and pushed to the box.
- The spec format gains three optional fields, so every World Map Editor edit is expressible: a graph position, an explicit-edge link, and a cross-spec link target.
- A DB→spec writer turns the current DB state of a spec's worlds back into that spec.
- The local generator fallback is Plan 4b (separate ticket, blocked on the box's generator source).

**Tech Stack:** Node/Express, raw `pg`, node-pg-migrate, `node:test`; the existing `seeds/mapSpec.js` validator, `scripts/seed-map.js` applier and `services/worldGenService.js` box client.

**Spec:** `docs/superpowers/specs/2026-10-18-seed-export-tab-design.md`, plus the user decisions of 2026-10-19 below.

## User decisions (2026-10-19)
1. The GPU box generates maps. The generated specs travel through git and each PC builds worlds from them (option 1).
2. When the box is unreachable, fall back to a local generator. **No local generator exists**, so this becomes Plan 4b. Until then, the Maps row shows "GPU box unreachable" for box actions, and seeding from specs in git works offline.
3. Hand edits made in the World Map Editor are written back into the specs, and the box is told about them.
4. Git decides the entry world.
5. A seed re-populates changed worlds. `applyMapSpec` already converges a world to its spec (populate, guards, chest, villages, chunk cache).

## Global Constraints

- Never mutate the shared dev DB `game_db` (read-only SELECTs only).
  - Every DB test runs on the scratch DB `game_db_seedsync`, with BOTH `DATABASE_URL` and `TEST_DATABASE_URL` set.
  - Tests touching `worlds.is_entry` also hold the entry lock from `backend/tests/helpers/entryWorld.js`.
- **Never call the real GPU box from tests.** Inject the `deps` fetch that `worldGenService` already accepts.
- **Never write into the real `backend/seeds/maps/` from tests.** The maps dir is read at call time from `SEED_MAPS_DIR`, defaulting to `backend/seeds/maps`.
- Never cascade into player data. Removing a spec from git never deletes its worlds: they show as "only on this PC".
- Exactly one entry world after any Maps seed, applied only through `setEntryWorld` / `setEntryWorldByName`.
- `make seed-map` keeps working, and it records the spec as applied on this PC.
- Work happens in a throwaway worktree on branch `feat/seed-export-plan4` (based on main), with commits `type(scope): summary (SOMET-641)` and the Co-Authored-By trailer. Never push.

## Decisions (made while planning)

1. **Spec extensions (all optional, so the existing specs stay valid and byte-identical):**
   - World key `graph: [x, y]`: an explicit map-graph position that wins over `grid × 220`. The writer emits it only when the DB position differs from the grid-derived one.
   - Link `kind: 'edge'`: a compass doorway with an explicit `edge`, and no grid-delta check. The writer uses it for a hand-added link that the grid cannot express. A grid-consistent compass link keeps the plain form.
   - Link `to_name`: the target is a world by NAME in another spec, instead of a spec-local `to` key. Apply resolves it from the DB. A missing target is an apply error naming the world.
2. **Pruning respects other specs.** `applyMapSpec(pool, spec, { moveEntry, keepSlots })` takes extra keep-slots: every `from:edge` declared by any spec in the manifest. `pruneCompassLinks` then never deletes a link another spec declares, including cross-spec inbound links.
3. **World→spec membership** is derived by scanning the spec files (world names are unique). A DB world in no spec is listed in the preview as a warning: "not in any map spec — not synced; create it through Generated Worlds". It is never exported.
4. **The entry world lives in the manifest** (`entry_world: "<name>"`). Specs keep their own `is_entry` for validity. The Maps seed applies every spec with `moveEntry: false`, then calls `setEntryWorldByName(manifest.entry_world)`.
5. **Each spec's status on this PC:**

   | Status | Meaning | Red? |
   |---|---|---|
   | `in_sync` | git's spec hash equals the applied hash, and there are no hand edits | |
   | `git_newer` | git's spec hash ≠ the applied hash, and there are no hand edits | |
   | `edited_here` | the writer's output for the current DB ≠ the spec at the last applied or exported hash | |
   | `conflict` | both git_newer and edited_here | red |
   | `new` | in git, never applied here | |
   | `only_here` | applied here, gone from git | |

   Decisions per spec: **Take git** (apply the spec) and **Keep local**. Keep local records git's hash as applied, mirroring Plans 1–3. `only_here` is keep-only.
6. **Export** writes back every spec in `edited_here`, then rewrites the manifest. `git_newer` and `conflict` refuse, as in every group.
7. **Box push** happens after a successful export, best effort. Each spec the box knows is PATCHed with the changed fields of its world entries. The box knows a spec when a GET of `/api/worlds/{name}` succeeds.
   - On failure (unreachable, auth, 4xx), the spec records `box_error`. The export still succeeds, and the row shows "GPU box not updated: <error>". The next export retries.
   - A spec the box does not know (hand-authored, like `vale-region`) is skipped silently.

## Review Focus
1. Seed → export with no edits leaves every spec file byte-identical (canonical JSON). → Task 3 test `writer is identity on an unedited seed`.
2. A hand-added link between worlds of two specs survives seeding either spec. → Task 2 test `cross-spec link is kept by both specs' prune`.
3. A spec removed from git never deletes worlds or player data. → Task 4 test `removed spec is only_here, nothing deleted`.
4. With the box down, export still writes the specs, and the row says the box was not updated. → Task 5 test `box unreachable: export ok, box_error recorded`.
5. Two specs that both say `is_entry`: exactly one entry world after the seed, the manifest's. → Task 4 test `entry world comes from the manifest`.

---

### Task 1: Migration and the map spec state table

**Files:**
- Create: `backend/migrations/<next after 1714440800000>_seed_sync_plan4.js`
- Test: `backend/tests/seed_sync_plan4_migration_db.test.js`

**Interfaces:**
- Produces:
  - `map_spec_state(spec_name text PRIMARY KEY, applied_sha256 text, applied_at timestamptz, exported_sha256 text, exported_at timestamptz, box_pushed_sha256 text, box_error text, updated_at timestamptz NOT NULL DEFAULT now())`.
  - `world_point_kinds.sync_uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()`, backfilled with `md5('s2sync:world_point_kinds:'||kind)::uuid`.
- Down drops both.

- [ ] **Step 1:** Write the failing test `plan4 migration: map_spec_state and point kind identity`. It covers the backfill formula, a working default for a new row, and that down drops both.
- [ ] **Step 2:** Run it. FAIL.
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** Run it plus `seed_sync_plan3_migration_db`. PASS.
- [ ] **Step 5:** Commit `feat(seed-sync): map spec state table (SOMET-641)`.

### Task 2: Spec format extensions and an applier that respects other specs

**Files:**
- Modify: `backend/seeds/mapSpec.js` (WORLD_KEYS gains `graph`; link validation for `kind:'edge'` and `to_name`), `backend/scripts/seed-map.js` (`applyMapSpec` options and graph override), `backend/src/services/mapLinks.js` (`pruneCompassLinks` keep-slots for inbound links)
- Test: `backend/tests/map_spec_extensions_db.test.js`; the existing `map_spec*`/`seed_map*` tests stay green

**Interfaces:**
- `validateMapSpec` accepts:
  - `graph: [int, int]`
  - links `{ kind: 'edge', from, to | to_name, edge: 'N'|'E'|'S'|'W' }`, with the grid check skipped for `kind:'edge'`
  - `to_name` on compass/edge/portal links. A spec-local `to` and `to_name` are mutually exclusive.
- `applyMapSpec(pool, spec, { moveEntry = true, keepSlots = [] } = {})`:
  - `keepSlots` are `'<world name>:<edge>'` strings declared by other specs.
  - It writes `graph` when present.
  - It resolves `to_name` by world name, and throws an Error listing missing names before any write.
- `pruneCompassLinks(client, worldIds, keepSlots, { keepNames })`: the inbound delete spares links whose `from_name:edge` is in keepSlots.

- [ ] **Step 1: Write the failing tests:**
  - `graph overrides grid position`
  - `edge link applies without a grid check and survives re-seed`
  - `to_name link resolves across specs; missing target refused before writes`
  - `cross-spec link is kept by both specs' prune`
  - `existing specs validate and apply unchanged` (vale-region and p5-descent through `validateMapSpec`)
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the new tests plus `ls backend/tests | grep -E "map_spec|seed_map|map_links|village|chest|waypoint"`. PASS, or the same red as main.
- [ ] **Step 5:** Commit `feat(maps): spec graph positions, edge and cross-spec links (SOMET-641)`.

### Task 3: DB → spec writer

**Files:**
- Create: `backend/src/services/mapSpecExport.js`
- Test: `backend/tests/map_spec_export_db.test.js`

**Interfaces:**
- `specFromDb(db, spec, { otherSpecWorlds: Map(worldName -> specName) }) -> spec'`:
  - It returns a new spec, keeping every authored field the DB cannot change: roads, pens, the biome plan beyond the stored columns, comments and key order.
  - It overwrites every field an admin route can change:
    - Inventory them by reading every route that writes `worlds`, `map_links`, `waypoints`, `world_chests` and `villages` (index.js ~2430–5460).
    - At least these world columns: name, size, seed, biomes, biome_cell, allowed_creature_types, entry_spawn, density, level band, safe settings, boss and graph position.
    - Links: compass (plain when grid-consistent, else `kind:'edge'`), portals, cross-spec (`to_name`).
    - Village boxes and gates, waypoints, chest position.
    - Per-point art choices, but only if the spec format already carries them. Otherwise note it in the report and do not add a key.
- `canonicalSpecJson(spec) -> string`: a stable two-space-indented JSON with the existing files' key order. The two checked-in specs must round-trip through it byte-identically.

- [ ] **Step 1: Write the failing tests** (prefixed world names, entry lock held):
  - `canonicalSpecJson is identity on the checked-in specs`
  - `writer is identity on an unedited seed`: seed vale-region and p5-descent, run specFromDb, and the canonical JSON equals the file.
  - `each admin edit appears in the written spec`. Edit through the same SQL the admin routes run:
    - a world field
    - a dragged graph position
    - an added grid-inconsistent link
    - a link to a world of the other spec
    - a moved village
    - a moved waypoint
    - a moved chest

    Each edit appears in the written spec, validates, and re-applies to the same DB state.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. PASS.
- [ ] **Step 5:** Commit `feat(maps): write DB map edits back into spec files (SOMET-641)`.

### Task 4: Maps group adapter in seed sync

**Files:**
- Create: `backend/src/services/seedSync/mapsGroup.js`
- Modify:
  - `registry.js`: groups may carry `adapter`; add `{ id: 'maps', label: 'Maps', adapter: 'maps' }` after `progression`. `world_point_kinds` becomes the FIRST table of Entities, with naturalKey `['kind']` and ref `default_entity_type_id → entity_types by uuid` resolved in the deferred pass. If the engine needs a `deferred: true` flag on the ref for a forward in-group ref, add it, and teach the order test.
  - `coverage.js`: `PENDING` is emptied. `maps` and `map_entities` are EXCLUDED as "dead: discrete-map system of the paused Go engine (0 rows, no writer)". `worlds`, `map_links`, `waypoints`, `world_chests` and `villages` go in a new list `SPEC_SYNCED` with the reason "synced as map spec files (maps group)". `map_spec_state` is EXCLUDED as "seed sync per-PC map spec state".
  - the export, diff, preview and apply entry points (or `seedExportRoutes.js` plus `scripts/seed-sync.js`): dispatch to the adapter for adapter groups.
  - `backend/scripts/seed-map.js`: record `applied_sha256` after a successful apply.
- Test: `backend/tests/seed_sync_maps_db.test.js`; update the registry and coverage tests.

**Interfaces:**
- The adapter exposes the same shapes the routes and UI already consume:
  - `status(db)`: like diffGroup's summary. Rows are per spec: `{ table: 'map_specs', key: specName, syncUuid: md5uuid('map_specs:'+name), kind, defaultDecision, blockedReason, allowedDecisions, fields }`. `fields` lists changed worlds by name.
  - `preview(db)`: `{ rows, signature, warnings }`. Warnings list worlds that are in no spec.
  - `apply(db, decisions, { signature })`:
    - Under the seed_sync advisory lock, for each spec decided `git`, in manifest order: `applyMapSpec(..., { moveEntry: false, keepSlots })`.
    - Then `setEntryWorldByName(manifest.entry_world)`.
    - Then write the applied hashes.
    - One transaction if `applyMapSpec` accepts a client. Otherwise apply spec by spec, and report a partial failure, listing the specs applied and the one that failed. Record the choice and why in the report.
    - Run rows go through runs.js as usual.
  - `export(db)`: refuses `git_newer`/`conflict`. Writes `specFromDb` output for every `edited_here` spec (tmp, then rename), then the manifest, then the `exported_sha256` values.
- Manifest `backend/seeds/sync/maps.json`: `{ header (as other groups), specs: [{ name, sha256 }], entry_world }`. Specs are read from `SEED_MAPS_DIR`.

- [ ] **Step 1: Write the failing tests:**
  - `fresh PC: new specs seed and land in sync`
  - `admin edit → edited_here → export writes spec → other PC git_newer → seed → in sync`
  - `both sides changed → conflict, red, export refused`
  - `removed spec is only_here, nothing deleted`
  - `entry world comes from the manifest`
  - `make seed-map records applied hash`
  - registry: order, plus `world_point_kinds` in Entities
  - coverage: 0 problems, PENDING empty
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run every `tests/seed_sync_*` file plus `seed_export_routes_db`, `seed_sync_cli_db` and the Task 2 map tests. PASS.
- [ ] **Step 5:** Commit `feat(seed-sync): Maps group over spec files (SOMET-641)`.

### Task 5: Push hand edits to the GPU box, and the UI note

**Files:**
- Modify: `backend/src/services/seedSync/mapsGroup.js` (push after export), `backend/src/services/worldGenService.js` (only if a helper is missing), and the frontend `seedExportModel.js` / `SeedExportAdmin.jsx` (the box note)
- Test: `backend/tests/seed_sync_maps_box_db.test.js`, plus a frontend model test

**Interfaces:**
- `pushToBox(db, specNames, deps) -> [{ spec, status: 'pushed'|'skipped'|'failed', error }]`.
  - For each spec, GET `/api/worlds/{name}`: a 404 means skipped.
  - PATCH the changed fields of the spec, computed by diffing the box's spec against ours: only the keys that differ, at world/link/village granularity.
  - On success, set `box_pushed_sha256`; on failure, set `box_error`.
  - It runs after a successful export, and never fails the export.
- Group status: a row `note` "GPU box not updated: <error>" when `box_error` is set, or when `box_pushed_sha256 ≠ exported_sha256` for a spec the box knows. The UI shows the note under the Maps row.
- Plan 4b note: when the box is unreachable, the row note reads "GPU box unreachable — new regions need the box (local generator: SOMET-<4b id>)".

- [ ] **Step 1: Write the failing tests** (injected fetch):
  - `box unreachable: export ok, box_error recorded`
  - `box knows spec: PATCH carries only changed keys`
  - `box does not know spec: skipped silently`
  - frontend: the note renders
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. PASS. Then run the whole frontend vitest suite.
- [ ] **Step 5:** Commit `feat(seed-sync): push map spec edits to the GPU box (SOMET-641)`.

### Task 6: Verification (no product code unless a defect)

- [ ] **CLI journey** on the scratch DB with a temp `SEED_MAPS_DIR` copy of the two specs:
  1. Seed via the Maps group.
  2. Apply an admin-style edit (SQL as the route runs it).
  3. Export, show the spec diff, then simulate the other PC (fresh worlds) and seed.
  4. Show the edit applied, in sync, and exactly one entry world.
  5. Clean up the prefixed rows.
- [ ] **Box:** probe `GET /api/auth/mode`. If the box is reachable, PATCH a throwaway test region only, never a real one; skip if none exists. If it is unreachable, report that and rely on the injected tests.
- [ ] **Read-only on `game_db`:** count the DB worlds that are in no spec (the warning list the user will see), and run the writer's dry output on both specs against `game_db`. That shows the hand edits that currently live only in the DB.
- [ ] Put the results into a SOMET-641 Plane comment.

---

## Out of scope
- **Plan 4b (new ticket):** a local generator fallback when the box is unreachable. It needs the generator source from the Windows box.
- Git buttons (SOMET-642) and the Orange Pi tab (SOMET-643).
