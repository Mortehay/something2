# Seed/Export Plan 3: Art and Audio Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two groups to the Seed / Export tab, **Art** (images, sprite atlases, art prompt descriptions and notes) and **Audio** (clips, bindings, prompts). Each moves both its rows and its binary files between PCs through git, with the same preview, baselines and history as the data groups. Both run as cancellable background jobs.

**Architecture:**
- The Plan 2 engine (`backend/src/services/seedSync/`) gains three TableSpec features:
  - `rowFilter`: a table where only some rows sync.
  - `versioned`: history tables with an `active` flag.
  - `slice`: a group that owns only some columns of a table another group owns.
- It also gains one new kind of column, an *asset* column. Its local value is an object-store key. In the file it is written as a repo file path plus a content hash, and a per-PC cache table (`seed_asset_hashes`) translates between the two without downloading anything at status time.
- Binary groups run their export and seed through an in-process, single-flight job runner. The UI polls it, following the `bulk-image-jobs` pattern.

**Tech Stack:** Node/Express with raw `pg`, node-pg-migrate, `node:test`, React + TanStack Query, vitest. Object store through `src/services/assetStore.js` (MinIO).

**Spec:** `docs/superpowers/specs/2026-10-18-seed-export-tab-design.md`. Plan 2 (`docs/superpowers/plans/2026-10-18-seed-export-plan2-data-groups.md`) defines the engine this plan extends.

## Global Constraints

- **Never mutate the shared dev DB `game_db`.**
  - Every DB test and script runs on the scratch DB `game_db_seedsync`, with BOTH `DATABASE_URL` and `TEST_DATABASE_URL` set to it.
  - Read-only queries against `game_db` are allowed.
- **Never touch the real object store or the real `backend/seeds/` tree from tests.**
  - Tests use a fake store (the `art_seed_policy.test.js` pattern: an in-memory `Map` with `putObject` / `getObjectStream` / `objectExists` / `ensureBucket` / `BUCKET`).
  - Tests use a temp seeds root (`SEED_SYNC_DIR` plus a new `SEED_ASSETS_ROOT`).
- `ai_providers.auth_token` never appears in any file, response or diff. That already holds; Art and Audio reference providers only by uuid.
- Each group's file is `backend/seeds/sync/<group>.json` (format v2). Binary files go under `backend/seeds/` at paths relative to `SEED_ASSETS_ROOT`, which defaults to `backend/seeds`. They reuse the existing directories, so git does not grow twice:
  - `textures/{tiles,entities,items,skills,passives,character-appearances}/`
  - `textures/catalog/<subject_kind>/` for any other catalog_art kind
  - `textures/sprites/<table>/`
  - `audio/{music,ambience,sfx}/`
- The legacy make targets (`art-export`, `art-seed`, `audio-export`, `audio-seed`) and their manifests stay untouched and keep working.
- Commits: `type(seed-sync): summary (SOMET-640)`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work happens in a throwaway worktree on branch `feat/seed-export-plan3`. Never checkout, stash or reset in the shared checkout. Never push.

## Decisions (rulings made while planning; the spec allowed or left them open)

1. **Art and Sprites are one group, "Art".** `render_mode`, `image` and `sprite` describe one picture together. Seeding them in two groups could leave `render_mode='animated'` with no atlas. The dev DB has **0** rows that use a sprite atlas today.
2. **`sprite_sets` is EXCLUDED** as machine-local job state (21 queued and 12 approved rows, none with an atlas). Approved atlases travel through the `sprite` columns.
3. **Unbound audio clips do not travel** (`rowFilter`), as in the legacy `audioSeed`.
4. **Asset hashes:**
   - Images and sprite parts use the sha256 of the committed file.
   - Audio uses the existing `audio_clips.sha1`, which every write path fills (0 NULL on dev), so audio needs no cache.
5. **Seeded object keys:**
   - Images and sprite parts are content-addressed: `${BUCKET}/seedsync/<sha256>.<png|json>`. An upload is skipped when the key already exists, so it is idempotent, and an aborted apply leaves only harmless orphans.
   - Audio uses `audio/<kind>/<sync_uuid>.ogg`, because `audio_clips.storage_key` is UNIQUE and two clips can hold identical bytes.
6. **No processing on seed.** PC B gets exactly the bytes PC A's game shows. The only processing is on export: icons (`item_types.icon`, catalog_art `skill`/`passive_label`) are capped at 256 px on the longest edge with `shrinkToEdge`, as the legacy exporter does.
7. **A missing object refuses the export.** If an image key points at an object that is not in the store, export refuses with `assets_missing` and lists the rows. A silent null would delete that art on the other PC.
8. **Versioned prompt tables** (`art_prompt_descriptions`, `audio_prompts`):
   - Only active rows sync.
   - A new version inherits the sync_uuid of the latest row with the same natural key, via a BEFORE INSERT trigger.
   - Uniqueness is `UNIQUE (sync_uuid) WHERE active`.
   - Take-git updates the active row in place. Delete-local deactivates it (`active=false`); it never DELETEs. The history on each PC stays local.
9. **Seed all and Export all changed skip binary groups.** They show "Art and Audio run separately", with each group's own button. A multi-minute run hidden inside a modal is worse than a visible job.
10. **Restart:** at backend boot, every `seed_export_runs` row still `running` becomes `failed` with the error `interrupted: backend restarted`. No new status is needed.
11. **Orphan files are not pruned.** After a rename or delete, an export reports `orphanFiles: N` in the run summary and deletes nothing.

## Review Focus

1. A pulled git file that has no matching binary on disk (the json was pulled but the png was not committed): the preview must show the row blocked with `asset_file_missing`, never apply a key that points at nothing. → Task 3 test `preview blocks a row whose asset file is missing or altered`.
2. A legacy `make art-export` overwrites a png after the sync export: the preview must block that row with `asset_file_mismatch`. → same Task 3 test.
3. The first sync on a PC whose art came from the legacy seeder: every art row shows as changed and red (no cache entry), and one bulk "Take git" resolves them all. → Task 4 round-trip test, case `legacy-seeded PC`.
4. Cancel during a long export: the run row ends `cancelled`, a later export succeeds, and no half-written file stays (files are written tmp, then renamed). → Task 5 test `cancel mid-export`.
5. A second click while a job runs answers 409 `busy` with the current job, never a second job. A data-group seed during an art job answers 409 too. → Task 5 route test.

---

### Task 1: Migration — identities, versioned uniqueness, asset cache

**Files:**
- Create: `backend/migrations/1714440800000_seed_sync_plan3.js` (check `ls backend/migrations | tail` first; the timestamp must sort after `1714440790000_seed_sync_plan2.js` and collide with nothing)
- Test: `backend/tests/seed_sync_plan3_migration_db.test.js`

**Interfaces:**
- Produces: a `sync_uuid uuid NOT NULL` column with these backfills and constraints:

| Table | Backfill | Constraint |
|---|---|---|
| `catalog_art` | `md5('s2sync:catalog_art:'||subject_kind||'|'||subject_key)::uuid` | UNIQUE |
| `character_appearances` | md5 over `entity name|variant` (join `entity_types.name`) | UNIQUE |
| `audio_clips` | `= id` | UNIQUE |
| `audio_bindings` | md5 over `subject_kind|subject_key|slot|clip sync_uuid` | UNIQUE |
| `art_prompt_notes` | md5 over `subject_kind|subject_key|kind|note` | UNIQUE (inactive rows get the same formula plus `'|'||id`) |
| `art_prompt_descriptions` | md5 over `subject_kind|subject_key` | partial `UNIQUE (sync_uuid) WHERE active` |
| `audio_prompts` | md5 over `subject_kind|subject_key|slot` | partial `UNIQUE (sync_uuid) WHERE active` |

  - Every new row defaults to `gen_random_uuid()`, except on the two versioned tables. There a `BEFORE INSERT` trigger sets `NEW.sync_uuid` when it is NULL: to the sync_uuid of the most recent row (highest `id`) with the same natural key, otherwise to the md5 formula.
  - The table `seed_asset_hashes(object_key text PRIMARY KEY, sha256 text NOT NULL, file text NOT NULL, bytes integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`.
  - The migration keeps Plan 2's pre-checks, which throw and never delete: duplicate natural keys among active rows, and a sync_uuid collision.

- [ ] **Step 1: Write the failing test.** On the scratch DB, insert fixture rows into each table with the migration down, then run the migration up. The test is named `plan3 migration backfills deterministic identities and versioned inheritance`, and it asserts:
  - the backfill values equal the md5 formulas above, recomputed in the test with `crypto.createHash('md5')`
  - `audio_clips.sync_uuid = id`
  - inserting a second `audio_prompts` version (deactivate old, insert new, as `audioPrompts.save` does) gives the new row the old row's sync_uuid
  - two active rows with one sync_uuid fail with 23505
  - the migration down drops everything it added
- [ ] **Step 2:** Run `DATABASE_URL=$SCRATCH TEST_DATABASE_URL=$SCRATCH node --test tests/seed_sync_plan3_migration_db.test.js`. Expect FAIL (the migration is missing).
- [ ] **Step 3:** Write the migration (up and down), following the structure and pre-checks of `1714440790000_seed_sync_plan2.js`.
- [ ] **Step 4:** Run the test. Expect PASS. Also run `tests/seed_sync_plan2_migration_db.test.js` and `tests/audio_library_db.test.js`. Expect PASS: they clone rows, and the memory notes that a new UNIQUE column breaks row-cloning tests.
- [ ] **Step 5:** Read-only, against `game_db`, run the pre-check SELECTs: 0 duplicates and 0 collisions. Record the counts in the report.
- [ ] **Step 6: Commit** `feat(seed-sync): plan 3 identities and asset hash cache (SOMET-640)`.

### Task 2: Engine — `rowFilter`, `versioned`, `slice`

**Files:**
- Modify: `backend/src/services/seedSync/registry.js` (TableSpec docs, `fkProblems`, `tableSpecs`), `exportGroup.js`, `diffGroup.js`, `applySeed.js`, `txn.js`, `coverage.js`
- Test: `backend/tests/seed_sync_spec_features_db.test.js` (uses `_withTestGroups` with throwaway tables created in the test)

**Interfaces:**
- TableSpec gains these optional fields:
  - `rowFilter: string`: an SQL predicate over unaliased columns of `spec.table`. It is ANDed into every SELECT, lock-for-update, DELETE and UPDATE the engine issues for that table: export, readLocal, keyIndex, referenceInfo and apply.
  - `versioned: true`: implies `rowFilter: 'active'`. The upsert uses `ON CONFLICT (sync_uuid) WHERE active`, adopt and update add `AND active`, and a delete becomes `UPDATE ... SET active = false`.
  - `slice: true, columns: string[]`: the group owns only `columns` (plus `sync_uuid` and `naturalKey`, which are read but never written).
    - Export and diff read only those columns.
    - Apply only `UPDATE ... SET <columns> WHERE sync_uuid = $1`; it never inserts, deletes or adopts.
    - A git row whose uuid is not local gets `blockedReason: 'owner_missing'`, with the message "seed <owner group label> first".
    - A local row that is not in git is `only_here` and keep-only: a `delete` decision on it refuses with `invalid_decision`.
- Delete blocking (`referencingFks` / `blockReason`): an FK from an `EXCLUDED` table whose `confdeltype` is `'n'` (ON DELETE SET NULL) no longer blocks. Example: `audio_jobs.clip_id`.
- Coverage: a table may appear in one full spec plus any number of slices. `coverageProblems` adds a check: for a sliced table, every column that the full spec omits with reason `'art group (plan 3)'` is in exactly one slice's `columns`, and no slice column appears unomitted in the full spec.

- [ ] **Step 1: Write the failing tests** in `seed_sync_spec_features_db.test.js`:
  - `rowFilter hides filtered rows from export, diff and delete`: a row with `keep=false` is absent from the file and never shows as only_here, and a deleted_in_git row with the filter false is untouched.
  - `versioned take-git updates the active row in place, delete deactivates`: assert the row counts with `active` true and false after each apply, and that the inactive history row is unchanged.
  - `versioned new version on this PC keeps identity`: after a local new version, the diff kind is `edited_here`, not key-clash or new.
  - `slice exports only its columns and updates in place`: change one sliced column in the file; after apply, only that column changed, and the owner's non-slice columns and row count are unchanged.
  - `slice git row missing locally is blocked owner_missing; delete decision on slice row refuses`.
  - `SET NULL fk from excluded table does not block delete`.
  - A coverage unit test (no DB): `coverageProblems` flags a column that is omitted as art but sits in no slice, and a column in two slices.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement. Route every table-scoped SQL statement through one helper, `scopeSql(spec, alias?) -> string` in `registry.js`, which returns `''` or `' AND (<predicate>)'`. That way no query site can forget the filter. Also `grep -n "FROM \${quoteIdent(spec.table)}\|quoteIdent(spec.table)" seedSync/*.js`, and in the report list each site and how it is scoped.
- [ ] **Step 4:** Run the new tests and every `tests/seed_sync_*` file. Expect all PASS: the Plan 1 and Plan 2 behaviour must not change.
- [ ] **Step 5: Commit** `feat(seed-sync): row filters, versioned tables and column slices (SOMET-640)`.

### Task 3: Asset columns — translation, cache, export staging, seed upload

**Files:**
- Create: `backend/src/services/seedSync/assets.js`
- Modify: `exportGroup.js`, `diffGroup.js`, `applySeed.js`, `canonical.js` (only if the asset value needs a canonical type)
- Test: `backend/tests/seed_sync_assets_db.test.js`

**Interfaces:**
- Consumes: Task 1 `seed_asset_hashes`, and Task 2 `slice` and `rowFilter`.
- TableSpec gains `assets: { [col]: AssetSpec }`, where AssetSpec is:
  - `{ type: 'image', dir: string | (row) => string, maxEdge?: number | (row) => number|null }`
  - `{ type: 'sprite', dir }`
  - `{ type: 'audio', dir: (row) => string }`
- Values in a file, and in the diff's local form:
  - **image**: `{ file: "<dir>/<name>.png", sha256: "<64 hex>" }`
  - **sprite**: `{ atlas: { file, sha256 }, manifest: { file, sha256 }, ...rest }`, where `rest` is the jsonb's other keys (`static_frame`, `frames`), i.e. everything except `atlas_key` and `manifest_key`
  - **audio**: `{ file: "audio/<kind>/<safeName(label)>-<sync_uuid first 8>.ogg", sha1 }`, computed from the row alone
  - **Empty values:** NULL and `''` travel unchanged.
  - **Local key with no cache entry:** `{ unhashed: "<object_key>" }`. It never equals a git value, so the row reads as edited here.
- File name: `<dir>/<safeName(natural key parts joined '|')>.<ext>` (`safeName` comes from `artSeed.js`). Inside one export, a later row (natural-key order) whose name collides gets `-<sha256 first 8>`. A file already recorded in the cache for that key keeps its recorded path.
- `assets.js` exports:
  - `assetsRoot() -> string`: `process.env.SEED_ASSETS_ROOT || path.join(__dirname, '../../../seeds')`
  - `localAssetValue(spec, col, row, cache) -> value`: pure
  - `loadCache(db, keys: string[]) -> Map(key -> { sha256, file, bytes })`
  - `prepareExportAssets(pool, store, group, { onProgress, signal }) -> { downloaded, reused, missing: [{ table, key, objectKey }], orphanFiles }`
    - Runs outside the lock.
    - For every non-empty local asset key, it downloads, processes (`shrinkToEdge` when `maxEdge`), writes the file (tmp, then rename, then `matchOwner`) and upserts the cache. It does this only when the key is uncached, or when the cached file is missing on disk or its on-disk sha256 differs.
    - Audio: it downloads only when the file is missing or its sha1 differs from the row's `sha1`.
    - It checks `signal.aborted` between assets and throws `SyncRefused('cancelled')`.
  - `checkGitAssets(root, rows, spec) -> Map(sync_uuid -> 'asset_file_missing' | 'asset_file_mismatch')`: hashes only the files of the rows passed.
  - `uploadGitAssets(store, rows, spec, { onProgress, signal }) -> Map(sync_uuid -> { [col]: localValue })`
    - image and sprite parts go to `${BUCKET()}/seedsync/<sha256>.<ext>`; the upload is skipped when `objectExists`.
    - audio goes to `audio/<kind>/<sync_uuid>.ogg`.
  - `recordCache(db, entries)`
- Export (`exportGroup`):
  - For a group with any asset column, it calls `prepareExportAssets` first.
  - A non-empty `missing` list throws `SyncRefused('assets_missing', 'regenerate or clear these images first', { rows })` before any file is written.
  - Inside the locked transaction, exportTable translates through the cache. A key that is still uncached throws `SyncRefused('assets_changed', 'art changed during export, run it again')`.
  - The run summary gains `{ downloaded, reused, orphanFiles }`.
- Preview: `annotate` sets `blockedReason` from `checkGitAssets` for rows whose default or chosen action takes git (changed, new, adopt). That puts it into the signature automatically.
- Apply: `uploadGitAssets` runs first, outside the transaction and cancellable, for the rows the decisions take from git. Then the transaction writes the object keys in place of the file values. `recordCache` runs inside the same transaction, after the writes.

- [ ] **Step 1: Write the failing tests** (fake store, temp `SEED_SYNC_DIR` and `SEED_ASSETS_ROOT`, a `_withTestGroups` group with one image, one sprite and one audio column):
  - `export writes asset files and translates keys to file+hash`: the file bytes equal the store bytes (or the shrunk bytes with `maxEdge`), the json holds `{ file, sha256 }`, and the cache rows exist.
  - `re-export reuses cached files without downloading`: the fake store counts `getObjectStream` calls; the second export makes 0.
  - `uncached local key reads as edited here`.
  - `export refuses assets_missing when an object is gone, and writes no file`.
  - `preview blocks a row whose asset file is missing or altered`: delete one png and flip one byte in another, and assert both blockedReasons.
  - `apply uploads content-addressed objects and writes local keys`: assert the row's key equals `${BUCKET}/seedsync/<sha>.png`, the object exists, the cache has the entry, and the next diff is in sync.
  - `audio value uses sha1 column and per-clip key`.
  - `cancel during prepare throws cancelled and leaves no tmp files`.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement `assets.js` and the three integration points.
- [ ] **Step 4:** Run the new tests and every `tests/seed_sync_*` file. Expect PASS.
- [ ] **Step 5: Commit** `feat(seed-sync): asset columns with file+hash travel and per-PC cache (SOMET-640)`.

### Task 4: Art and Audio groups in the registry, plus coverage and round trip

**Files:**
- Modify: `backend/src/services/seedSync/registry.js`, `coverage.js`
- Modify: `backend/tests/seed_sync_registry_db.test.js`, `backend/tests/seed_sync_coverage_db.test.js`
- Create: `backend/tests/seed_sync_art_audio_roundtrip_db.test.js`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- `GROUPS` gains, after `quests`, in this order:
  - `{ id: 'art', label: 'Art', binary: true, tables: [...] }`, with tables in this write order:
    1. `catalog_art`: naturalKey `['subject_kind','subject_key']`; refs `provider_id → ai_providers by uuid`; assets `image: { type:'image', dir: (r) => ({ skill:'textures/skills', passive_label:'textures/passives', character_appearance:'textures/character-appearances', item:'textures/items' }[r.subject_kind] || 'textures/catalog/' + r.subject_kind), maxEdge: (r) => (['skill','passive_label','item'].includes(r.subject_kind) ? 256 : null) }`. Task 3's AssetSpec accepts `maxEdge` as a number or as `(row) => number|null`.
    2. `art_prompt_descriptions`: `versioned: true`; naturalKey `['subject_kind','subject_key']`; omit `id`, `created_at`, `active`.
    3. `art_prompt_notes`: `versioned: true`; naturalKey `['subject_kind','subject_key','kind','note']`; omit `id`, `created_at`, `active`.
    4. `character_appearances`: naturalKey `['entity_type_id','variant']`; refs `entity_type_id → entity_types by uuid`; assets `image` (dir `textures/character-appearances`) and `sprite` (dir `textures/sprites/character_appearances`).
    5. Slice `tile_types`: columns `image`, `render_mode`, `sprite`; assets `image` (`textures/tiles`) and `sprite` (`textures/sprites/tile_types`).
    6. Slice `entity_types`: columns `image`, `sprite`, `render_mode`, `display_width`, `display_height`, `prompt`; assets `image` (`textures/entities`) and `sprite` (`textures/sprites/entity_types`).
    7. Slice `item_types`: column `icon`; asset `icon: { type:'image', dir:'textures/items', maxEdge: 256 }`.
  - `{ id: 'audio', label: 'Audio', binary: true, tables: [...] }`:
    1. `audio_clips`: naturalKey `['sync_uuid']` (the clip has no other natural key; a rename is a label change). If the engine cannot take `sync_uuid` as a natural key, use `['kind','label','sha1']` instead and record that ruling; `rowFilter: 'EXISTS (SELECT 1 FROM audio_bindings b WHERE b.clip_id = audio_clips.id)'`; omit `id: 'local'`, `created_at`; refs `provider_id → ai_providers by uuid`; assets `storage_key: { type:'audio', dir: (r) => 'audio/' + r.kind }`.
    2. `audio_bindings`: naturalKey `['subject_kind','subject_key','slot','clip_id']`; refs `clip_id → audio_clips by uuid`; omit `id`, `created_at`.
    3. `audio_prompts`: `versioned: true`; naturalKey `['subject_kind','subject_key','slot']`; omit `id`, `created_at`, `active`.
- The Plan 2 `omit` reasons `'art group (plan 3)'` on `tile_types`, `entity_types` and `item_types` stay as they are. The Task 2 coverage check now proves the slices cover them exactly.
- Coverage:
  - `PENDING` loses every P3 entry.
  - `EXCLUDED` gains `sprite_sets: 'machine-local sprite job queue; approved atlases travel in the sprite columns (art group)'` and `seed_asset_hashes: 'seed sync per-PC asset hash cache'`.
- `getGroup(id).binary` is `true` for art and audio, and absent elsewhere.

- [ ] **Step 1: Write the failing tests.**
  - registry test: the order and binary flags.
  - coverage test: the live schema has 0 problems, with no PENDING P3 entry.
  - round-trip test `art and audio round trip byte-identical`, on the scratch DB with a fake store:
    - Seed fixture rows: a tile with an image, an entity with a sprite (atlas plus manifest), an item icon of 512 px, a skill catalog_art row, a description with two versions, a note, an appearance, and two clips with bindings and a prompt.
    - Then: export art and audio → wipe those tables' rows and the fake store → seed with all decisions `git` → export again. The json `tables` and every referenced file are byte-identical across the two exports, and the icon file is ≤ 256 px.
  - Case `legacy-seeded PC`: rows whose keys hold the same picture under a legacy key `${BUCKET}/x/seeded/static.png`, with no cache. The preview shows them red and changed. After a bulk `git` decision, the next diff is in sync.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement the registry entries and the coverage changes.
- [ ] **Step 4:** Run every `tests/seed_sync_*` file, plus `tests/art_seed_policy.test.js` and the `tests/audio_*` files, on the scratch DB. Expect PASS.
- [ ] **Step 5: Commit** `feat(seed-sync): Art and Audio groups (SOMET-640)`.

### Task 5: Background jobs — runner, routes, restart, CLI

**Files:**
- Create: `backend/src/services/seedSync/jobs.js`
- Modify: `backend/src/api/seedExportRoutes.js`, `backend/src/services/seedSync/runs.js` (add `markInterruptedRuns`), `backend/src/index.js` (call it once at boot, after migrations), `backend/scripts/seed-sync.js`
- Test: `backend/tests/seed_sync_jobs_db.test.js`, extend `backend/tests/seed_export_routes_db.test.js`

**Interfaces:**
- `jobs.js`:
  - `startJob({ groupId, action, run: (ctx) => Promise<result> }) -> job`. Throws `SyncRefused('busy', 'another export or seed is running', { job })` while one is running. `ctx = { onProgress({ phase, done, total }), signal }`.
  - `currentJob() -> null | { id, groupId, action, phase, done, total, status: 'running'|'ok'|'failed'|'cancelled', error, result, startedAt, finishedAt }`. The last job stays visible until the next one starts.
  - `cancelJob() -> boolean`.
  - `isBusy() -> boolean`.
- `exportGroup(pool, groupId, { store, onProgress, signal } = {})` and `applySeed(pool, groupId, decisions, { signature, store, onProgress, signal })`. `store` defaults to `require('../assetStore.js')`.
  - Cancel is honoured only before the transaction begins. Once the transaction is open it completes.
  - A cancelled run's row ends `cancelled`.
- Routes:
  - `POST groups/:id/export` and `POST groups/:id/seed`, for a `binary` group, answer `202 { job }`. Data groups keep their synchronous 200 responses.
  - Any export or seed while `isBusy()` answers `409 { error: 'busy', job }`.
  - `GET /api/seed-export/jobs/current` → `currentJob()`.
  - `POST /api/seed-export/jobs/cancel` → `{ cancelled, job }`.
  - All are admin-only (the existing guard).
- `markInterruptedRuns(db) -> number`: `UPDATE seed_export_runs SET status='failed', error='interrupted: backend restarted', finished_at=now() WHERE status='running'`.
- CLI: `seed-sync.js export|seed --group art|audio` runs the engine directly, with `onProgress` printing `phase done/total` lines to stderr. Any change to the exit codes follows the existing table.

- [ ] **Step 1: Write the failing tests:**
  - `single flight`: a second `startJob` throws busy.
  - `cancel mid-export`: the fake store delays each `getObjectStream`; cancel after the first; then assert status `cancelled`, the run row `cancelled`, no `*.tmp` under the temp root, and that a following export ends `ok`.
  - `markInterruptedRuns marks only running rows`.
  - routes:
    - binary export → 202, then poll `jobs/current` until ok
    - data-group seed while busy → 409 busy
    - `jobs/cancel` when idle → `{ cancelled:false }`
    - the route responses never contain `auth_token`
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the new tests, `tests/seed_export_routes_db.test.js`, `tests/seed_sync_cli_db.test.js` and every `tests/seed_sync_*` file. Expect PASS.
- [ ] **Step 5: Commit** `feat(seed-sync): background jobs for binary groups (SOMET-640)`.

### Task 6: Frontend — job progress, cancel, large previews, seed-all note

**Files:**
- Modify: `frontend/src/games/something2/useSeedExport.js`, `SeedExportAdmin.jsx`, `SeedPreviewModal.jsx`, `SeedPreviewSection.jsx`, `SeedAllModal.jsx`, `seedExportModel.js`
- Test: `frontend/src/games/something2/__tests__/` (next to the existing seed model and render tests)

**Interfaces:**
- Consumes: Task 5 routes, plus `binary` in `GET /groups` items (add it there if Task 5 did not).
- `useSeedJob()`: polls `GET jobs/current` every 1000 ms while `status === 'running'`, otherwise does not poll. When a job turns `ok`, it invalidates the groups and runs queries.
- `useCancelSeedJob()`.
- `jobProgressText(job) -> string` (pure, in `seedExportModel.js`). Examples:
  - `"Downloading art 120 / 1100"`
  - `"Uploading audio 3 / 40"`
  - `"Writing database…"` when `total` is 0
  - `"Cancelled"`
  - `"Failed: <error>"`
- UI:
  - **Group row:** a binary group's row shows a progress bar and a Cancel button while its job runs. While any job runs, every export and seed button is disabled, with the tooltip "Another export or seed is running".
  - **Apply:** on a binary group, Apply in the preview closes the modal and the row shows the job.
  - **Seed all / Export all changed:** these list binary groups under "Art and Audio run separately", each with its own button, and never include them in the batch.
  - **Preview sections:** each section renders the first 200 rows, then a "Show 200 more" button. Bulk actions and filters still apply to all rows, not only the rendered ones.
  - **Asset values:** in field diffs, `{ file, sha256 }` shows as `file · sha256[0..8]`. `{ unhashed }` shows as "local art not exported yet".
  - **Blocked rows:** `asset_file_missing` shows as "File missing in git checkout — pull again or re-export on the other PC". `asset_file_mismatch` shows as "File changed outside the tab — re-export". `owner_missing` shows as "Seed <group> first".

- [ ] **Step 1: Write the failing tests:**
  - `jobProgressText` cases, each with its exact string.
  - Model: binary groups are excluded from the seed-all selection.
  - Render: a section with 450 rows renders 200, then 400 after one click, and a bulk "Take git" decides all 450.
  - Render: a binary group row while a job runs shows progress and Cancel, with the other buttons disabled.
- [ ] **Step 2:** `cd frontend && npx vitest run src/games/something2`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run src/games/something2` and then the whole `npx vitest run`. Expect PASS (read the exit code).
- [ ] **Step 5: Commit** `feat(seed-sync): job progress, cancel and large previews in the tab (SOMET-640)`.

### Task 7: Size report and browser check (no product code unless a defect is found)

**Files:**
- Create: `docs/superpowers/plans/2026-10-19-seed-export-plan3-size-report.md`

- [ ] **Step 1: Size report, read-only.**
  - From `game_db`: the counts of non-empty asset keys per table, the bytes of the existing files under `backend/seeds/textures` and `backend/seeds/audio`, and how many of today's audio files already match their row's sha1. That last count is the expected churn on the first audio export.
  - State the expected first-export churn for art. Every entity still re-downloads once, because legacy files were trimmed on upload.
  - Report the sprite growth (0 today) and give the LFS verdict: not needed while sprite atlases are 0. Revisit when the first atlas is approved.
- [ ] **Step 2: Browser check** against a backend pointed at the scratch DB and a scratch MinIO bucket, never the dev stack's DB. Use the recipe in the `dev-run-browser-verify` memory for admin UI without credentials. Screenshot each of these:
  - Art and Audio rows with their badges
  - an export job's progress bar and its Cancel button
  - a preview with more than 200 rows and "Show 200 more"
  - a blocked `asset_file_missing` row
  - history rows for the art export
- [ ] **Step 3: Commit** the report: `docs(seed-sync): plan 3 size report (SOMET-640)`.

---

## Out of scope

- Maps (Plan 4, SOMET-641), the git strip (SOMET-642) and the Orange Pi tab (SOMET-643).
- Pruning orphan files, and moving legacy manifests onto the sync files.
- A live reload after a seed; the restart banner from Plan 1 applies unchanged.
