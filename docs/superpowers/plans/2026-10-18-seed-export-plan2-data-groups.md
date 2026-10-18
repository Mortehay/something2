# Seed / Export — Plan 2: Data Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the eight remaining data groups to the Seed / Export tab: Items, Attack Effects, Aura Effects, Creature Behaviors, Entities, Biomes, Skill Tree and Progression.

To get there:
- The engine learns to handle groups made of several tables.
- Foreign keys travel between PCs as references, not as local ids.
- A test fails whenever a database table belongs to no group.
- A CLI makes the engine usable headless.

**Architecture:**
- **Groups.** A group becomes an ordered list of table specs, written to one file per group. Diff and apply run per table inside one group transaction.
- **References.** FK columns are declared as `refs`. Export translates a local id into the target's `sync_uuid`, or into its name for lookup tables. Apply translates back to a local id, and refuses with a clear reason when the target is missing.
- **Identity.** Child tables get `sync_uuid`. Their deterministic backfill is built from their composite natural key.
- **Renames.** Renames are applied by uuid. The by-name cascades the admin routes already perform (entity and aura renames) are run in the same transaction.

**Tech Stack:** Express (CommonJS, raw `pg`), node-pg-migrate, `node --test`, React + TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-seed-export-tab-design.md`. Builds on Plan 1 (`docs/superpowers/plans/2026-10-18-seed-export-foundation.md`, merged at 8356e2ca).

**Inventory this plan relies on:** a read-only scan of routes and the scratch-DB schema, summarized in the Global Constraints and Task 6. The builder re-verifies every table name, FK and natural key against the live schema before relying on it.

## Global Constraints

Everything in Plan 1's Global Constraints still applies:
- admin-only routes
- `auth_token` never leaves the PC
- deterministic sorted JSON
- scratch-DB-only tests with `sx_` rows under `SEED_SYNC_TEST_LOCK`
- a stale-preview signature that covers row values
- a worktree branch
- Plane ids in commits, here SOMET-639

On top of that:
- **Group order.** Groups seed in this order, which is also registry order:
  1. `tile_types`
  2. `items`
  3. `attack_effects`
  4. `aura_effects`
  5. `creature_behaviors`
  6. `entities`
  7. `biomes`
  8. `skill_tree`
  9. `progression`
  10. `quests`
  11. `ai_providers`
- **Group tables**, in the order each group writes them:

  | Group | Tables |
  |---|---|
  | `items` | `item_types`, `affix_types` |
  | `attack_effects` | `vfx_effects`, `creature_skills` |
  | `aura_effects` | `aura_effects` |
  | `creature_behaviors` | `creature_behaviors`, `creature_abilities`, `creature_behavior_skills`, `behavior_drops`, `chest_loot` |
  | `entities` | `entity_types`, `creature_drops`, `class_loadouts` |
  | `biomes` | `biomes` |
  | `skill_tree` | `passive_nodes`, `passive_edges` |
  | `progression` | `game_settings` |

- **Lookup tables are referenced by name and never exported.** These are `elements`, `attack_origins`, `impact_behaviors`, `projectile_shapes` and `world_point_kinds`. They are migration-seeded and have no admin write route.
- **Excluded tables.** `merchant_stock` is excluded because it is derived from items and villages.
- **File format v2:** `{ header: { group, exported_at, exported_by, schema_version, row_counts: { <table>: n } }, tables: { <table>: [rows] } }`.
  - The reader still accepts a v1 file (`{ header{row_count}, rows }`) for a single-table group.
  - Export always writes v2.
- **Ref columns in files.**
  - A column declared `{ table: T, by: 'uuid' }` holds the target row's `sync_uuid`, or null.
  - `{ table: T, by: 'key', keyCol: K }` holds the target's natural key value (for example `elements.name`).
  - Numeric ids never appear in a file.
- **By-name references** stay as values. These are jsonb or text names such as `entity_types.auras`, `spawn_tiles`, `vfx`, `biomes.creature_types`, `flora_types`, `terrain_tiles`, `path_tile` and `creature_skills.summon_entity`.
  - Preview warns about any name that does not resolve: `warnings: [{ code: 'dangling_name', table, key, column, name }]`.
  - Apply still proceeds. *My call:* the game already tolerates these names, and blocking on them would make a partial sync impossible.
- **Deterministic `sync_uuid` backfill** for the new tables is `md5('s2sync:' || <table> || ':' || <natural key string>)::uuid`. The natural key string is built from referenced natural keys, never local ids.
  - For a single-column key it is the value.
  - For a composite key, the parts are joined with `|`, and each FK part uses the referenced row's natural key (for example `creature_drops`: `<entity name>|<item name>`).
  - This lets two PCs agree on identity before they ever sync.
- **Refusals added:**
  - `SyncRefused('missing_ref', ..., { refs: [{ table, key, column, target }] })` when a referenced row does not exist locally and is not created in the same seed.
  - `SyncRefused('invalid_value', ..., { key, error })` when a `game_settings` value fails `assertValid`.

## Review Focus

1. **Rename across groups.** An entity renamed on PC A is applied by uuid on PC B. Afterwards `worlds.allowed_creature_types` / `dungeon_boss`, `world_creatures.type`, and `biomes.creature_types` / `flora_types` on B use the new name, exactly as the admin PUT would leave them. Pinned in Task 5.
2. **Child rows when the parent is deleted.** Deleting a behavior in git deletes its in-group children (abilities, behavior skills, drops) in the same transaction. A reference from outside the group still blocks the delete (for example `entity_types.behavior_id`, NO ACTION). Never a CASCADE into player data. Pinned in Task 5.
3. **Self-reference order.** `item_types.ammo_type_id` points at another `item_types` row that is new in the same seed. Apply inserts both. Pinned in Task 5.
4. **Missing reference target.** An entity row references a behavior uuid absent both locally and in git. The result is a `missing_ref` refusal naming the entity and behavior, with nothing written. It must not be a 23503/500. Pinned in Task 5.
5. **Composite identity on two PCs that never synced.** The same `creature_drops` pair exists on both PCs, created by seed-catalogs. Both get the same deterministic uuid, so the pair is "in sync" or "changed", never "new" plus "only here". Pinned in Task 1.

---

### Task 1: Migration: sync_uuid for Plan 2 tables, unique composite keys

**Files:**
- Create: `backend/migrations/<next>_seed_sync_plan2.js`. Take a timestamp above the current highest (`ls backend/migrations | sort | tail -1`) and re-check it before merging.
- Test: `backend/tests/seed_sync_plan2_migration_db.test.js`

**Interfaces:**
- Produces `sync_uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()` on these tables, backfilled deterministically:

  | Table | Backfill key string |
  |---|---|
  | `item_types` | name |
  | `affix_types` | key |
  | `vfx_effects` | name |
  | `creature_skills` | name |
  | `aura_effects` | name |
  | `creature_behaviors` | name |
  | `creature_abilities` | behavior.name\|slot |
  | `creature_behavior_skills` | behavior.name\|slot |
  | `behavior_drops` | behavior.name\|item.name |
  | `chest_loot` | level_min\|level_max\|item.name |
  | `entity_types` | name |
  | `creature_drops` | entity.name\|item.name |
  | `class_loadouts` | entity.name\|item.name |
  | `biomes` | name |
  | `passive_nodes` | key |
  | `passive_edges` | a.key\|b.key, with the pair ordered as stored |
  | `game_settings` | key |

- Produces new unique constraints on `creature_drops (entity_type_id, item_type_id)`, `behavior_drops (behavior_id, item_type_id)` and `chest_loot (level_min, level_max, item_type_id)`.
  - Before adding them, the migration counts duplicates. If any exist it throws an Error that lists them, so the operator dedupes deliberately.
  - It never deletes rows. *My call:* the shared dev DB holds real data, and a silent dedupe is a destructive surprise.

- [ ] **Step 1: Write the failing test.**
  - every listed table has a non-null unique `sync_uuid`
  - for one migration-seeded row per table (pick rows that exist on a fresh scratch DB after seed-catalogs), `sync_uuid` equals the deterministic formula computed in the test
  - a duplicate `creature_drops` pair insert fails with 23505
- [ ] **Step 2: Run it and confirm it fails.** Run it on the scratch DB with both env vars set.
- [ ] **Step 3: Write the migration.** Same shape as `1714440780000_seed_sync.js`. Composite backfills use `UPDATE ... FROM` joins to the referenced tables. Do the duplicate check before adding the unique constraints. `down` reverses everything.
- [ ] **Step 4: Migrate the scratch DB and run the test until it passes.** Also run `down 1` and then `up` again.
- [ ] **Step 5: Commit.** `feat(seed-sync): sync_uuid + unique keys for plan-2 tables (SOMET-639)`

---

### Task 2: Registry v2: multi-table groups and declared refs

**Files:**
- Modify: `backend/src/services/seedSync/registry.js`
- Test: `backend/tests/seed_sync_registry_db.test.js` (extend), `backend/tests/seed_sync_canonical.test.js`

**Interfaces:**
- `GROUPS` entries become `{ id, label, tables: [TableSpec] }`. The old single-table fields of Plan 1 groups are converted to one-element `tables`.
- `TableSpec = { table, naturalKey: string[], omit: {col: reason}, secretColumns: string[], refs: { [col]: { table, by: 'uuid' } | { table, by: 'key', keyCol } }, validate?: 'game_settings' }`
- `getGroup(id)` is unchanged.
- `tableSpecs(group) -> TableSpec[]`
- `liveColumns(db, spec)` excludes `omit` and `secretColumns`, includes ref columns, and keeps them sorted.
- **Removal:** Plan 1's "no FK column may be live" guard becomes "every FK column is either in `refs` or in `omit` with a reason". `tile_types.ai_provider_id` moves from omit to `refs: { ai_provider_id: { table: 'ai_providers', by: 'uuid' } }`.
  - *My call:* that is the column Plan 1 deferred to this plan. `ai_providers` travels, so the pin can travel too.
- Plan 2 group entries are added in Task 6. This task only changes the shape, and keeps the 3 existing groups behaving identically.

- [ ] **Step 1: Write the failing tests.**
  - `every FK column is a declared ref or omitted`: for every spec, `pg_constraint contype='f'` columns ⊆ keys(refs) ∪ keys(omit).
  - `a declared ref matches the real FK target`: `refs[col].table` equals the FK's referenced table.
  - The existing column-set equality, now per TableSpec.
  - `plan-1 groups unchanged`: `liveColumns` for quests and ai_providers is identical to before. tile_types gains only `ai_provider_id`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass**, along with all existing `seed_sync_*` tests.
- [ ] **Step 5: Commit.** `refactor(seed-sync): multi-table groups with declared refs (SOMET-639)`

---

### Task 3: Export and read v2 with ref translation

**Files:**
- Modify: `backend/src/services/seedSync/exportGroup.js`, `canonical.js`, `diffGroup.js` (only `validateDoc` / `readExport`)
- Create: `backend/src/services/seedSync/refs.js`
- Test: `backend/tests/seed_sync_export_db.test.js` (extend), `backend/tests/seed_sync_refs_db.test.js`

**Interfaces:**
- Produces from `refs.js`:
  - `async buildRefMaps(db, spec) -> { toRef: {col: Map(localId → refValue)}, fromRef: {col: Map(refValue → localId)} }`. It loads only the target columns it needs.
  - `exportRow(row, spec, maps) -> row`: each ref column's local id is replaced by its uuid or key value. Null stays null.
  - `async resolveRow(gitRow, spec, maps, pending) -> { row, missing: [{ column, target, value }] }`. `pending` holds refValues created earlier in the same seed.
- Export writes v2. `header.row_counts` is per table. Rows are sorted by the natural key (a composite key compares part by part, plain code-unit compare).
- `readExport` accepts v1 (single-table group only) or v2. `validateDoc` checks each table separately:
  - uuid format
  - no duplicate uuid
  - no duplicate natural key
  - `row_counts` matches
  - every table in the file belongs to the group

  An unknown table in the file is a `SyncFileError`.

- [ ] **Step 1: Write the failing tests.**
  - An entity whose `behavior_id` points at behavior X exports `behavior_id` as X's `sync_uuid`. An item with `element` exports the element name. `JSON.stringify(file)` contains no local numeric id for any ref column.
  - A v1 Plan-1 file (written by hand in the v1 shape) still reads and diffs with no changes.
  - A v2 file with an unknown table, or a mismatched `row_counts`, raises `SyncFileError`.
  - Second export is byte-identical, for a multi-table group.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass**, along with all `seed_sync_*` tests.
- [ ] **Step 5: Commit.** `feat(seed-sync): v2 export with uuid/name refs (SOMET-639)`

---

### Task 4: Diff v2 per table

**Files:**
- Modify: `backend/src/services/seedSync/diffGroup.js`
- Test: `backend/tests/seed_sync_diff_db.test.js` (extend)

**Interfaces:**
- `GroupDiff.rows[]` gains `table`.
  - `counts`, `localEdits`, `gitChanges` and `status` are aggregated across the group's tables.
  - `tables: [{ table, counts }]` is added.
  - A row's `key` for display is the natural key joined with ` → ` after ref translation. For a ref part, that is the referenced row's natural key, e.g. `Goblin → Rusty Sword`.
- Hashes are computed on the exported form, with refs translated.
- `adopt_identity` matches on the translated composite natural key.
- `warnings` gains `dangling_name` entries. The list of by-name columns comes from a per-spec `nameRefs: { [col]: { table, keyCol, shape: 'text'|'array'|'object-values' } }` in the TableSpec.
- Seed-time name checks also count names that are created by the same group file.

- [ ] **Step 1: Write the failing tests.**
  - multi-table aggregation, with `counts` summed
  - a child row edited on both sides is red, with `table` set
  - `adopt_identity` on a composite key
  - an entity whose `auras` names a non-existent aura produces a `dangling_name` warning
  - Plan-1 single-table diff output unchanged except for the added `table` field
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass**, along with all `seed_sync_*` tests.
- [ ] **Step 5: Commit.** `feat(seed-sync): per-table diff for multi-table groups (SOMET-639)`

---

### Task 5: Apply v2: refs, order, in-group children, renames, validation

**Files:**
- Modify: `backend/src/services/seedSync/applySeed.js`
- Create: `backend/src/services/seedSync/renameCascade.js`
- Modify: `backend/src/index.js` and `backend/src/api/auraEffectsRoutes.js`, so the admin PUT routes call the extracted cascade instead of their inline SQL. Behaviour must stay unchanged.
- Test: `backend/tests/seed_sync_apply_db.test.js` (extend), `backend/tests/seed_sync_rename_db.test.js`

**Interfaces:**
- Produces from `renameCascade.js`:
  - `async cascadeEntityRename(client, oldName, newName)`, extracted from the inline SQL in the entity PUT (index.js ~1104-1150, which touches worlds, world_creatures and biomes).
  - `async cascadeAuraRename(client, oldName, newName)`, extracted from `auraEffectsRoutes.js`.
- Apply order inside a group transaction:
  1. Deletes, children first (reverse table order).
  2. Adopts.
  3. Upserts, parents first (table order). Ref columns are resolved through `resolveRow`, with uuids created earlier in this seed counted as `pending`.
  4. A self-reference whose target appears later in the same table is handled in two passes: insert with the ref null, then a second-pass UPDATE.
  5. Renames: when an upsert changes `entity_types.name` or `aura_effects.name` for an existing uuid, call the cascade with the old and new name in the same transaction.
- Delete blocking (`referencingFks`):
  - An FK from another table **in the same group** does not block when the referencing rows are deleted in the same seed, or are cascade children of the deleted row within the group.
  - Any other referencing row blocks the delete with its reason. That includes rows in other groups, player data (`player_items` → `item_types`) and maps.
- `missing_ref` refusal, and `invalid_value` for `game_settings` (use `assertValid` from `services/gameSettings.js`). Both are raised before any write.
- Baselines and the signature work per row, as in Plan 1. The signature parts include `table`.

- [ ] **Step 1: Write the failing tests.** One each for Review Focus 1–4, plus:
  - deleting a behavior in git deletes its abilities, behavior skills and drops in the same transaction
  - a `game_settings` value that fails validation is refused with `invalid_value`
  - the existing admin rename tests (grep tests for the entity rename cascade and the aura rename) still pass, now through the extracted functions
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass**, along with all `seed_sync_*` tests and the existing entity and aura route tests.
- [ ] **Step 5: Commit.** `feat(seed-sync): multi-table apply with refs, renames, in-group deletes (SOMET-639)`

---

### Task 6: Register the eight Plan 2 groups with round-trip tests

**Files:**
- Modify: `backend/src/services/seedSync/registry.js`
- Test: `backend/tests/seed_sync_groups_roundtrip_db.test.js`

**Interfaces:**
- One TableSpec per table listed in Global Constraints. The builder fills in `naturalKey`, `refs`, `nameRefs` and `omit` from the live schema. Fixed decisions:
  - **`entity_types`:**
    - omit `image`, `sprite`, `render_mode`, `display_width`, `display_height` and `prompt` (all "art group (plan 3)"), plus `ai_provider_mode` ("per-PC")
    - refs `behavior_id` (uuid), `ai_provider_id` (uuid), `element` (key elements.name) and `point_kind` (key world_point_kinds.kind)
    - nameRefs `auras` → aura_effects.name, `vfx` → vfx_effects.name and `spawn_tiles` → tile_types.name
  - **`item_types`:**
    - omit `icon` (art)
    - refs `ammo_type_id` (uuid, self), `attack_origin` (key), `element` (key), `impact_behavior_id` (key impact_behaviors.name) and `projectile_shape_id` (key projectile_shapes.name)
    - nameRefs `vfx` (object values → vfx_effects.name)
  - **`biomes`:** nameRefs `terrain_tiles` and `path_tile` → tile_types.name; `creature_types` and `flora_types` → entity_types.name
  - **`creature_skills`:** nameRefs `summon_entity` → entity_types.name and `vfx` → vfx_effects.name
  - **`passive_nodes`:** every column travels. The admin edits label, kind and grants; the seeder writes the structural columns. *My call:* full fidelity.
  - **`passive_edges`:** naturalKey `[a_id, b_id]`, both refs by uuid to passive_nodes
  - **`game_settings`:** naturalKey `[key]`, omit `updated_at`, `validate: 'game_settings'`
- The UI needs no new code for the groups to appear: it lists the groups from the API.

- [ ] **Step 1: Write the failing round-trip tests.** For each Plan 2 group, on the scratch DB with temp `SEED_SYNC_DIR`:
  1. Export, then export again: byte-identical.
  2. Change one `sx_` row (or a scratch-only setting value restored afterwards), seed the earlier file back with `take git`, then export: byte-identical to the first export.
  3. Diff shows `in_sync`.

  `skill_tree` and `progression` must restore any real row they touch.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Then run the full backend suite (the common-context command). Failing files must be in the base-identical list kept in the SDD ledger.
- [ ] **Step 5: Commit.** `feat(seed-sync): plan-2 data groups (SOMET-639)`

---

### Task 7: Coverage test: every table is classified

**Files:**
- Create: `backend/src/services/seedSync/coverage.js`
- Test: `backend/tests/seed_sync_coverage_db.test.js`

**Interfaces:**
- Produces from `coverage.js`:
  - `EXCLUDED = { [table]: reason }`. This is player and runtime data, derived tables, lookups, seed-sync's own tables and node-pg-migrate's `pgmigrations`.
  - `PENDING = { [table]: 'plan 3 (art/sprites/audio)' | 'plan 4 (maps)' }`
- The categories come from the inventory: art/audio tables → plan 3; maps and worlds tables → plan 4; runtime and player tables → excluded; `merchant_stock` → excluded (derived); lookups → excluded (referenced by name).

- [ ] **Step 1: Write the test** `every public table is in a group, excluded with a reason, or pending a named plan`. It reads every `information_schema.tables` base table in `current_schema()` and asserts each is in exactly one of: a group TableSpec, `EXCLUDED`, or `PENDING`. It also fails when an entry names a table that no longer exists.
- [ ] **Step 2: Run it and confirm it fails** (no `coverage.js` yet).
- [ ] **Step 3: Implement** `coverage.js` with the classification.
- [ ] **Step 4: Run it and confirm it passes.**
- [ ] **Step 5: Commit.** `test(seed-sync): every table classified (SOMET-639)`

---

### Task 8: CLI

**Files:**
- Create: `backend/scripts/seed-sync.js`
- Modify: `Makefile` (`seed-sync-status`, `seed-sync-export GROUP=`, `seed-sync-seed GROUP= RESOLVE=git|local`, run through `docker compose exec` like the existing `art-*` targets)
- Test: `backend/tests/seed_sync_cli_db.test.js` (spawns the script with env pointing at the scratch DB)

**Interfaces:**
- `node scripts/seed-sync.js status [--group=g]` prints one line per group: `id status localEdits gitChanges`. Exit 0.
- `node scripts/seed-sync.js export --group=g|--all` uses the engine's refusals. Exit code: 0 ok, 2 refused (code printed), 1 error.
- `node scripts/seed-sync.js seed --group=g|--all [--resolve=git|local]`:
  1. Previews.
  2. Without `--resolve`, refuses (exit 2) when any row is red.
  3. With `--resolve`, uses it for the red rows. Every other row uses its default, and blocked rows are never deleted.
  4. Applies with the preview's signature.
  5. Prints the summary.
- Like `seed-gear-ladder`, the script refuses to run without an explicit `DATABASE_URL`. It never uses the hard-coded localhost fallback.

- [ ] **Step 1: Write the failing tests.** status output; export then status `in_sync`; seed refuses red rows without `--resolve`; seed with `--resolve=git` applies; exit codes.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the script and the Makefile targets.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit.** `feat(seed-sync): headless CLI + make targets (SOMET-639)`

---

### Task 9: UI for multi-table groups

**Files:**
- Modify: `frontend/src/games/something2/SeedPreviewSection.jsx`, `SeedStatusPopup.jsx`, `seedExportModel.js`
- Test: `frontend/src/ui/__tests__/seedExportModel.test.js`, `frontend/src/games/something2/__tests__/seedAllModal.render.test.js`

**Interfaces:**
- Preview rows are grouped under a small sub-heading per table, using `tableLabel(table)`. For example `creature_drops` reads "Drops", `class_loadouts` "Class loadouts" and `passive_edges` "Edges". Unknown tables fall back to the raw name.
- The row key shows the server's display key, e.g. `Goblin → Rusty Sword`.
- `dangling_name` warnings are listed in the preview: "Goblin: aura 'Frost Ring' does not exist here".
- `missing_ref` and `invalid_value` refusals produce readable toasts that include the details.
- The popup's row list shows the table label.

- [ ] **Step 1: Write the failing tests.** Model tests for `tableLabel`, warning copy and grouping. Extend the render test with a two-table group.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass**, then run `npx vitest run` and `npx vite build`.
- [ ] **Step 5: Verify in the browser on the isolated stack** (recipe in the SDD ledger):
  - all 11 groups are listed
  - export all
  - edit an entity's drop and its behavior locally and in git, then seed the preview. Both are shown with table sub-headings.
  - Apply works
  - a rename travels and its cascade lands on worlds and biomes
- [ ] **Step 6: Commit.** `feat(seed-sync): multi-table preview UI (SOMET-639)`

---

## Out of scope (Plan 3 / 4 / later)

- **Art, sprites and audio:** art columns stay omitted here.
- **Maps:** worlds, links, villages, chests, waypoints, `world_point_kinds` defaults.
- **seed-catalogs overwrites.** `scripts/seed-catalogs.js` batches that use `ON CONFLICT DO UPDATE` can overwrite synced edits when run afterwards. Ruling: document this in the tab's help text later; changing seeder ownership is a separate decision.
