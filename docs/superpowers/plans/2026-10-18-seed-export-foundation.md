# Seed / Export — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Seed / Export admin tab end to end. That means the history and baseline tables, travelling UUIDs, a group registry, export, status/diff, seed preview and apply, and the restart banner. It is proven on three single-table groups: **Quests, Tile Types (data columns), AI Providers**.

**Architecture:**
- A backend engine under `backend/src/services/seedSync/`, wrapped by an admin router at `/api/seed-export`.
- Engine pieces:
  - The registry: one entry per group.
  - The canonical serializer and hash.
  - Export: DB → `backend/seeds/sync/<group>.json`.
  - Diff: three-way, comparing git file vs DB vs baseline hashes.
  - Apply: one transaction per group.
- Live columns are read from `information_schema`, so a new column can't be silently left out.
- The frontend is one admin page with a pure view-model module that the vitest tests cover.

**Tech Stack:** Express (CommonJS, raw `pg`), node-pg-migrate, `node --test`, React + TanStack Query + styled-components, vitest (node env).

**Spec:** `docs/superpowers/specs/2026-10-18-seed-export-tab-design.md`

**Later plans (out of scope here; each is written after the previous one lands):**
2. Remaining data groups, with foreign keys written as UUIDs, the "every admin table is classified" coverage test, and a CLI over the engine (`status` / `export` / `seed --resolve=git|local`).
3. Art, Sprites and Audio: binary assets, plus a background job with polling.
4. Maps.
5. Git strip and the host-side git helper.

## Global Constraints

- Every `/api/seed-export/*` route is `adminGuard`ed. No response, export file, or diff payload ever contains `auth_token`.
- Rows travel by `sync_uuid`. Numeric `id` is never exported.
- Existing rows are backfilled with a deterministic UUID: `md5('s2sync:' || <table> || ':' || <natural key>)::uuid`. New rows get `DEFAULT gen_random_uuid()` (Postgres 15).
  - Spec deviation, *my call*: this is md5-derived rather than RFC UUIDv5. It is equally deterministic and needs no `uuid-ossp` extension.
- Export files live in `process.env.SEED_SYNC_DIR || path.join(__dirname, '../../../seeds/sync')`, which is `backend/seeds/sync/` in dev. The engine never assumes a repo or `.git`, so the future Orange Pi tab can reuse it.
- Export JSON format:
  - 2-space indent, trailing newline.
  - Object keys sorted at every depth.
  - Rows sorted by natural key.
- Every export file has a header: `{ group, exported_at, exported_by, schema_version, row_count }`.
  - `exported_by` is `process.env.SEED_PC_LABEL || os.hostname()`.
  - `schema_version` is `SELECT max(name) FROM pgmigrations`.
- Seed is refused when the file's `schema_version` is greater than this DB's: HTTP 409, `"run migrations first"`.
- DB tests:
  - Use `TEST_DATABASE_URL` and skip without it, following the `requireTestDb` pattern in `backend/tests/art_prompt_notes_db.test.js`.
  - Never run them against the shared dev DB.
  - Use row keys prefixed `sx_`, and assert only on those rows. The tables hold other data.
- Branch `feat/seed-export-foundation`, in its own worktree. Commit subject: `type(scope): summary (SOMET-NNN)`, with the Plane id of the task (P1.1–P1.7 = SOMET-632…638; module "Seed / Export tab").
- Done means three things:
  - backend `npm test` exits 0 (read the exit code)
  - frontend `npx vitest run` exits 0
  - browser verification of the tab

## Review Focus

1. **Postgres type drift breaks the round trip.** NUMERIC comes back from `pg` as a string, `float` as a number, `timestamptz` as a Date, and jsonb key order is arbitrary. Re-exporting an unchanged DB must still be byte-identical, and the hash must not flag unchanged rows. Pinned in Task 2 (`canonical normalizes numeric strings, dates and jsonb key order`) and Task 3 (`second export is byte-identical`).
2. **Both PCs hold the same quest but have never synced** (no baseline, different values). The row must show as red `edited_here`, not as a silent take-git. Pinned in Task 4.
3. **Deleting a quest that characters have started** (`character_quests` references it) must be blocked for that row with a reason, never cascaded. Pinned in Task 5.
4. **`auth_token` leaks through the diff.** The diff's field-level `local`/`git` values must exclude it, and a provider that is new from git must arrive with a NULL token. Pinned in Tasks 2 and 5.
5. **A hand-edited or truncated export file** (invalid JSON, missing header, unknown group). This must give a 422 with the file name, not a 500 or a partial apply. Pinned in Task 4.

---

### Task 1: Migration: history, baselines, travelling UUIDs

**Files:**
- Create: `backend/migrations/<next>_seed_sync.js`. Take a timestamp above the current highest (`ls backend/migrations | sort | tail -1`, currently `1714440770000`), re-check it just before merging, and see the header comment of `1714440760000_boss_loot_columns.js` for why.
- Test: `backend/tests/seed_sync_migration_db.test.js`

**Interfaces:**
- Produces:
  - Table `seed_export_runs`:
    - `id serial PK`
    - `group_id text NOT NULL`
    - `action text NOT NULL CHECK IN ('export','seed','git_pull','git_commit','git_push')`
    - `status text NOT NULL CHECK IN ('running','ok','failed','cancelled')`
    - `started_at timestamptz NOT NULL DEFAULT now()`
    - `finished_at timestamptz`
    - `pc_label text NOT NULL`
    - `git_commit text`
    - `summary jsonb NOT NULL DEFAULT '{}'`
    - `error text`
    - index on `(group_id, action, started_at DESC)`
  - Table `seed_row_hashes`:
    - `group_id text`
    - `sync_uuid uuid`
    - `hash text NOT NULL`
    - `updated_at timestamptz DEFAULT now()`
    - PK `(group_id, sync_uuid)`
  - Column `sync_uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()` on `quests`, `tile_types` and `ai_providers`, backfilled with the deterministic formula. The natural key is `key` for quests and `name` for the other two.

- [ ] **Step 1: Write the failing test.**
  - `seed_sync tables exist`: query `information_schema.columns` for both tables, and assert the column names listed above.
  - `existing rows get deterministic sync_uuid`:
    1. For each of `quests`/`key`, `tile_types`/`name` and `ai_providers`/`name`, insert an `sx_` row.
    2. Assert the DB default filled `sync_uuid`, i.e. it is non-null.
    3. Run `UPDATE ... SET sync_uuid = md5('s2sync:'||'<table>'||':'||<key>)::uuid` for that row, then assert the result equals `deterministicUuid('<table>', '<key>')` from Task 2's module. This pins the SQL and JS formulas together.
  - `sync_uuid is unique`: a duplicate insert raises `23505`.
- [ ] **Step 2: Run it and confirm it fails.** Run with a scratch DB: `cd backend && DATABASE_URL=$SCRATCH TEST_DATABASE_URL=$SCRATCH node --test tests/seed_sync_migration_db.test.js`. Expected: FAIL, because the tables and columns are missing.
- [ ] **Step 3: Write the migration.**
  1. `addColumns` with `sync_uuid` nullable.
  2. Backfill with an `UPDATE ... md5(...)::uuid`.
  3. `alterColumn` to `notNull` plus a default `gen_random_uuid()`.
  4. `addConstraint unique`.
  5. Create both tables.
  6. `down` reverses all of it.
- [ ] **Step 4: Migrate the scratch DB and re-run the test.** Run `DATABASE_URL=$SCRATCH npm run migrate:up`, then the test. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(seed-sync): history, baseline tables and sync_uuid (SOMET-632)`

---

### Task 2: Group registry, canonical rows, hashing

**Files:**
- Create: `backend/src/services/seedSync/registry.js`
- Create: `backend/src/services/seedSync/canonical.js`
- Test: `backend/tests/seed_sync_canonical.test.js` (pure)
- Test: `backend/tests/seed_sync_registry_db.test.js`

**Interfaces:**
- Produces from `registry.js`:
  - `GROUPS`: an ordered array, in seed order, of `{ id, label, table, naturalKey, omit: {col: reason}, secretColumns: [] }`. Plan 1 entries, in this order:
    - `{ id:'tile_types', label:'Tile Types', table:'tile_types', naturalKey:'name', omit:{ id:'local', created_at:'local', updated_at:'local', image:'art group (plan 3)', sync_uuid:'identity' } }`
    - `{ id:'quests', label:'Quests', table:'quests', naturalKey:'key', omit:{ id, created_at, sync_uuid } }`, using the same reason strings
    - `{ id:'ai_providers', label:'AI Providers', table:'ai_providers', naturalKey:'name', omit:{ id, created_at, updated_at, sync_uuid, models_cache:'machine cache', models_fetched_at:'machine cache' }, secretColumns:['auth_token'] }`
  - `getGroup(id) -> group`. Throws `Error('unknown group')`.
  - `async liveColumns(db, group) -> [{ name, dataType }]`: the table's columns from `information_schema`, minus `omit` and `secretColumns`, sorted by name.
- Produces from `canonical.js`:
  - `deterministicUuid(table, key) -> string`: md5 of `s2sync:${table}:${key}`, formatted 8-4-4-4-12.
  - `canonicalValue(value, dataType) -> json-safe value`. Converts:
    - `numeric` strings → Number
    - Date → ISO string
    - `json`/`jsonb` → keys sorted deeply
    - null stays null
  - `canonicalRow(row, columns) -> object`: only `columns`, plus `sync_uuid`, with keys sorted.
  - `rowHash(canonicalRow) -> string`: sha256 hex of `stableStringify(canonicalRow)`.
  - `stableStringify(value) -> string`: sorted keys, 2-space indent.

- [ ] **Step 1: Write the failing tests.**
  - `canonical normalizes numeric strings, dates and jsonb key order`:
    - `canonicalValue('0.50','numeric') === 0.5`
    - `canonicalValue(new Date('2026-10-18T00:00:00Z'),'timestamp with time zone') === '2026-10-18T00:00:00.000Z'`
    - `stableStringify(canonicalValue({b:1,a:{d:1,c:2}},'jsonb')) === stableStringify({a:{c:2,d:1},b:1})`
  - `rowHash ignores key order`: `rowHash({a:1,b:2}) === rowHash({b:2,a:1})`
  - `deterministicUuid is stable and uuid-shaped`: it matches `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`, and equal inputs give equal outputs.
  - DB test `every live column is exported or explicitly omitted`: for each group, every `information_schema` column is in `liveColumns` or in `omit`/`secretColumns`.
  - DB test `ai_providers liveColumns never includes auth_token`.
- [ ] **Step 2: Run them and confirm they fail.** Run `node --test tests/seed_sync_canonical.test.js tests/seed_sync_registry_db.test.js`. Expected: FAIL, because the module is not found.
- [ ] **Step 3: Implement both modules.** Use `crypto.createHash('md5')` and `crypto.createHash('sha256')`. Map `information_schema.columns.data_type` strings directly (`numeric`, `jsonb`, `timestamp with time zone`, …).
- [ ] **Step 4: Run them and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(seed-sync): group registry and canonical row hashing (SOMET-633)`

---

### Task 3: Export and run history

**Files:**
- Create: `backend/src/services/seedSync/runs.js`
- Create: `backend/src/services/seedSync/exportGroup.js`
- Test: `backend/tests/seed_sync_export_db.test.js`
- Modify: `.env.example` (add `SEED_PC_LABEL=` with a comment)
- Modify: `compose/develop/docker-compose.yml` (pass `SEED_PC_LABEL=${SEED_PC_LABEL:-}` to the backend service)

**Interfaces:**
- Consumes: Task 2's `getGroup`, `liveColumns`, `canonicalRow`, `rowHash` and `stableStringify`.
- Produces from `runs.js`:
  - `pcLabel() -> string`
  - `async schemaVersion(db) -> string`
  - `async startRun(db, groupId, action) -> runId`
  - `async finishRun(db, runId, { status, summary, error })`
  - `async lastRuns(db) -> { [groupId]: { export: run|null, seed: run|null } }`. Gives the latest `ok` run per action.
  - `async recentRuns(db, { limit = 50, groupId }) -> run[]`
- Produces from `exportGroup.js`:
  - `syncDir() -> string`
  - `fileFor(groupId) -> string`, i.e. `<syncDir>/<groupId>.json`
  - `async readExport(groupId) -> { header, rows } | null`. Returns null when the file is absent. Throws `SyncFileError` (`code: 'bad_file'`, `file`) on invalid JSON or a missing header.
  - `async exportGroup(pool, groupId) -> { runId, rowCount }`. Throws `SyncRefused` (`code: 'git_newer'`) when Task 4's `diffGroup` reports `gitChanges > 0`.

  Add that refusal in Task 4, Step 5, once `diffGroup` exists. In this task, `exportGroup` exports unconditionally.

- [ ] **Step 1: Write the failing tests.** Each test uses a temp dir set through `process.env.SEED_SYNC_DIR` before requiring the module.
  - `export writes header and sorted canonical rows`:
    1. Insert quests `sx_b` and `sx_a`.
    2. Run `exportGroup(pool,'quests')`.
    3. Parse the file and check:
       - `header.group === 'quests'`
       - `header.row_count === rows.length`
       - `sx_a` comes before `sx_b`
       - no row has `id` or `created_at`
       - every row has `sync_uuid`
  - `second export is byte-identical`: export twice, and the file bytes are equal except for `header.exported_at`. Compare with the header stripped.
  - `ai_providers export never contains auth_token`: insert an `sx_` provider with `auth_token 'sx-secret'`, export, and assert the raw file text does not include `sx-secret` or `auth_token`.
  - `export records a run and baselines`:
    - there is a `seed_export_runs` row with action `export` and status `ok`
    - `seed_row_hashes` has the `sx_a` hash equal to `rowHash` of its exported row
    - an `sx_` baseline for a row deleted before the export is gone
- [ ] **Step 2: Run them and confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Write the file atomically (write to `<file>.tmp`, then rename) so a crash never leaves a half file.
  - Replace the baselines for the group in one transaction: delete the group's hashes, then insert all of them.
  - `startRun` and `finishRun` wrap the whole operation. A thrown error finishes the run as `failed` with `error`.
- [ ] **Step 4: Run them and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(seed-sync): export groups to seeds/sync with run history (SOMET-634)`

---

### Task 4: Three-way diff and group status

**Files:**
- Create: `backend/src/services/seedSync/diffGroup.js`
- Modify: `backend/src/services/seedSync/exportGroup.js` (add the git_newer refusal)
- Test: `backend/tests/seed_sync_diff_db.test.js`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces `async diffGroup(pool, groupId) -> GroupDiff`, where:

```
GroupDiff = {
  groupId, header|null,
  status: 'never_exported'|'local_edits'|'git_newer'|'tokens_missing'|'in_sync',
  counts: { [kind]: n }, localEdits: n, gitChanges: n, tokensMissing: n,
  rows: [{ syncUuid, key, kind, defaultDecision: 'git'|'local'|'delete'|null,
           fields: [{ name, local, git }],   // only differing fields, secrets never included
           blockedReason: string|null }]      // filled by apply-time FK check in Task 5; null here
}
```

**Kinds and defaults.** This is the algorithm. B is the baseline hash, `hL` the local row's hash, `hG` the git row's hash.

| Git row | Local row | Condition | kind | default |
|---|---|---|---|---|
| ✓ | ✓ (by uuid) | `hL===hG` | not listed | – |
| ✓ | ✓ | B exists, `hL===B` (only git moved) | `changed` | `git` |
| ✓ | ✓ | B exists, `hG===B` (only local moved) | `not_exported` | `local` |
| ✓ | ✓ | no B, or both moved | `edited_here` | `null` (red) |
| ✓ | ✗ by uuid; a local row with the same natural key, whose uuid is not in git and has no B | – | `adopt_identity` | `git` |
| ✓ | ✗ | B exists (deleted here after sync) | `deleted_here` | `local` |
| ✓ | ✗ | no B | `new` | `git` |
| ✗ | ✓ | B exists and `hL===B` | `deleted_in_git` | `delete` |
| ✗ | ✓ | otherwise | `only_here` | `local` |

**Counts.**
- `localEdits` = `not_exported + edited_here + only_here + deleted_here`
- `gitChanges` = `changed + new + deleted_in_git + edited_here + adopt_identity`
- `tokensMissing`: AI Providers only, the number of rows where `auth_token IS NULL OR auth_token = ''`.

**Status precedence:** `never_exported` (no file) > `local_edits` > `git_newer` > `tokens_missing` > `in_sync`.

**Bad files.** A `SyncFileError` from `readExport` propagates. The route layer (Task 6) maps it to 422.

- [ ] **Step 1: Write the failing tests.** Each test sets its state with direct SQL plus hand-written files in the temp `SEED_SYNC_DIR`, then asserts on the `sx_` rows of `diffGroup(pool,'quests')`. One test per table row:
  - `changed`
  - `not_exported`
  - `edited_here when both sides moved`
  - `edited_here when no baseline (two PCs never synced)`
  - `adopt_identity on natural-key match`
  - `deleted_here`
  - `new`
  - `deleted_in_git`
  - `only_here`

  Plus:
  - `fields lists only differing columns`
  - `ai_providers diff never exposes auth_token`: a provider differs only in token, so it is not listed. `JSON.stringify(diff)` excludes the token value.
  - `status precedence`
  - `invalid JSON file raises SyncFileError with file name`
  - `exportGroup refuses with git_newer when gitChanges > 0`
- [ ] **Step 2: Run them and confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement `diffGroup`.** Load the git rows, the local canonical rows (selecting `liveColumns` plus `sync_uuid`) and the baselines in one read, then classify according to the table. Then add the refusal to `exportGroup`.
- [ ] **Step 4: Run them and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(seed-sync): three-way diff, group status, export refusal (SOMET-635)`

---

### Task 5: Apply a seed

**Files:**
- Create: `backend/src/services/seedSync/applySeed.js`
- Test: `backend/tests/seed_sync_apply_db.test.js`

**Interfaces:**
- Consumes: `diffGroup`, `readExport`, `schemaVersion` and the run helpers.
- Produces:
  - `async previewSeed(pool, groupId) -> GroupDiff`. This is `diffGroup` plus `blockedReason` on every row whose `defaultDecision` or possible decision is `delete`.
    - It finds every FK that references the group's table (`pg_constraint` with `confrelid = table::regclass`).
    - It counts the referencing rows.
    - The reason reads: `"${n} rows in ${referencingTable} reference this"`.
  - `async applySeed(pool, groupId, decisions: { [syncUuid]: 'git'|'local'|'delete' }) -> { runId, summary: { updated, created, deleted, kept, adopted } }`

**Rules:**
1. Refuse with `SyncRefused`:
   - code `schema_newer` when `header.schema_version > schemaVersion(db)`
   - code `undecided`, with the uuid list, when any `edited_here` row is missing from `decisions`
   - code `blocked`, with the uuid list, when a `delete` decision targets a row with a `blockedReason`
2. Run one transaction holding `pg_advisory_xact_lock(hashtext('seed_sync'))`. Then, for each listed row:
   - `git` on changed/edited_here/new → `INSERT ... ON CONFLICT (sync_uuid) DO UPDATE` with the live columns
   - `git` on adopt_identity → `UPDATE ... SET sync_uuid = git uuid, <cols> WHERE <naturalKey> = key`
   - `git` on deleted_here → re-insert
   - `delete` → `DELETE`
   - `local` → no write
   - For `secretColumns`, never write. A row new from git therefore gets NULL `auth_token`, and an existing row keeps its own.
3. **Baselines:**
   - every row written from git gets `B = hG`
   - deleted rows lose their B
   - `local` rows keep their old B
   - rows in sync with no B get `B = hL`, which establishes the baseline on the first sync
4. A failure rolls back, and the run finishes as `failed`.

- [ ] **Step 1: Write the failing tests.**
  - `apply writes chosen rows only`: `changed` + `git` → the DB gets the git value. `edited_here` + `local` → the DB keeps the local value and its B is unchanged.
  - `undecided red row refuses`
  - `delete blocked by character_quests`:
    1. Create a test character the way `tests/helpers/auth.js` does.
    2. Insert a `character_quests` row for the `sx_` quest.
    3. Assert the preview `blockedReason` matches `/character_quests/`.
    4. Assert `applySeed` with `delete` throws `blocked`, and the row still exists.
  - `new ai_provider from git arrives with NULL token; existing keeps its token`
  - `schema_newer refuses`
  - `adopt_identity rewrites sync_uuid`
  - `after apply, re-diff shows in_sync for applied rows`
  - `failure mid-apply rolls back everything`: force a `23505` via a natural-key clash, and assert that nothing changed.
- [ ] **Step 2: Run them and confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement `previewSeed` and `applySeed`.**
- [ ] **Step 4: Run them and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(seed-sync): seed preview and transactional apply (SOMET-636)`

---

### Task 6: Admin API and restart trigger

**Files:**
- Create: `backend/src/api/seedExportRoutes.js`
- Modify: `backend/src/index.js` (`app.use('/api/seed-export', seedExportRoutes(guardPool))` next to the other `src/api` mounts, around line 592; record `const PROCESS_STARTED_AT = new Date()` at module top)
- Modify: `.gitignore` (add `backend/src/.restart-trigger.json`)
- Test: `backend/tests/seed_export_routes_db.test.js` (supertest, admin token via `tests/helpers/auth.js`)

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces these routes. All of them use `requireAdmin(pool)`, and all errors are shaped `{ error, code?, details? }`.

  | Route | Returns |
  |---|---|
  | `GET /groups` | `[{ id, label, status, counts, localEdits, gitChanges, tokensMissing, lastExport, lastSeed, inGit: header\|null }]` in registry order. A group whose file is bad gets `status: 'bad_file'` and `error`; the request does not 500. |
  | `GET /groups/:id/preview` | `previewSeed` |
  | `POST /groups/:id/export` | `{ runId, rowCount }` |
  | `POST /groups/:id/seed` | body `{ decisions }` → `{ runId, summary }` |
  | `GET /runs?group=&limit=` | `recentRuns` |
  | `GET /restart` | `{ required: boolean }`. True when an `ok` seed run finished after `PROCESS_STARTED_AT`. |
  | `POST /restart` | writes `src/.restart-trigger.json` (`{ at: ISO }`) → `{ ok: true }`. nodemon watches `src/**/*.json` (`backend/nodemon.json`), so the dev backend restarts. *My call:* there is no compose restart policy, and a `process.exit` would leave nodemon waiting. |

  Error mapping:
  - `SyncRefused` → 409 with `code`
  - `SyncFileError` → 422 with `file`
  - unknown group → 404

- [ ] **Step 1: Write the failing tests.**
  - `routes require admin`: a player token gets 403 on every route.
  - `GET /groups lists three groups in order with statuses`
  - `bad file yields status bad_file, not 500`
  - `POST seed with undecided rows -> 409 undecided`
  - `no route response contains auth_token`: call every GET route after inserting a provider with a token, and assert the body text has no `sx-secret`.
  - `restart required after seed`
- [ ] **Step 2: Run them and confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement the router and mount it.**
- [ ] **Step 4: Run them and confirm they pass, then run the full backend suite.** Run `cd backend && DATABASE_URL=$SCRATCH TEST_DATABASE_URL=$SCRATCH npm test; echo "exit=$?"`. Expected: `exit=0` and no `^not ok` lines.
- [ ] **Step 5: Commit.** `feat(seed-sync): admin seed-export API and restart trigger (SOMET-637)`

---

### Task 7: Seed / Export tab

**Files:**
- Create: `frontend/src/games/something2/useSeedExport.js`
- Create: `frontend/src/games/something2/seedExportModel.js` (pure)
- Create: `frontend/src/games/something2/SeedExportAdmin.jsx`
- Create: `frontend/src/games/something2/SeedPreviewModal.jsx`
- Modify: `frontend/src/ui/navSections.js` (add `{ id: 'seed-export', label: 'Seed / Export', path: '/game/seed-export', Icon: HiOutlineArrowsRightLeft }` directly above AI Providers)
- Modify: `frontend/src/App.jsx` (`<Route path="seed-export" element={<SeedExportAdmin />} />` inside `RequireAdmin`)
- Test: `frontend/src/ui/__tests__/seedExportModel.test.js`

**Interfaces:**
- Consumes: Task 6 routes. Call them with `apiFetch` + `authHeaders()`, as `useBulkImageJob.js` does. Without `authHeaders()`, a 401 signs the admin out.
- Produces:
  - Hooks from `useSeedExport.js`:
    - `useSeedGroups()`
    - `useSeedPreview(groupId, enabled)`
    - `useExportGroup()`
    - `useApplySeed()`
    - `useSeedRuns()`
    - `useRestartStatus()`
    - `useRestartBackend()`

    All mutations invalidate `['seed-groups']`, `['seed-runs']` and `['seed-restart']`.
  - Pure functions from `seedExportModel.js`:
    - `statusBadge(group) -> { label, tone: 'ok'|'warn'|'info'|'bad' }`. Copy:
      - `in sync`
      - `${localEdits} edits not exported`
      - `git is newer`
      - `never exported`
      - `${n} token(s) missing`
      - `bad export file`
    - `initialDecisions(rows) -> { [uuid]: decision }`. Only rows with a non-null `defaultDecision`.
    - `bulkSet(decisions, uuids, decision, rows) -> decisions`. Skips a `delete` on rows with a `blockedReason`.
    - `applyGate(rows, decisions) -> { canApply, undecided: n, summary: { updated, created, deleted, kept } }`

- [ ] **Step 1: Write the failing tests.**
  - `statusBadge maps each status to copy and tone`
  - `red rows start undecided and block apply`
  - `bulk take-git resolves red rows`
  - `bulk delete skips blocked rows`
  - `summary counts match decisions`
  - The existing `navRoutes.test.js` must still pass with the new entry.
- [ ] **Step 2: Run them and confirm they fail.** Run `cd frontend && npx vitest run src/ui/__tests__/seedExportModel.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the model, hooks and components.**
  - The page follows layout A of brainstorm mockup `.superpowers/brainstorm/40347-1792311639/content/seed-export-layout.html`, minus the git strip:
    - a table with Group / Last export (this PC) / In git (time · PC) / Last seed (this PC) / Status / actions
    - the history list under it
  - Clicking a badge opens a popup (`status-popup.html`) listing the differing rows from `/preview` with the one resolving action. Export is disabled while the status is `git_newer`, with a tooltip saying "seed (preview) first".
  - The preview modal follows `seed-preview.html`:
    - filter chips by kind
    - a name filter
    - a bulk bar
    - a per-row switch
    - the Apply footer from `applyGate`
  - The restart banner is shown while `useRestartStatus().required` is true. It reads "Seeded data is applied on restart" and has a "Restart backend" button.
  - Use the existing `--s2-*` tokens. The tab must work in light mode.
- [ ] **Step 4: Run them and confirm they pass, then run the full frontend suite.** Run `npx vitest run; echo "exit=$?"`. Expected: `exit=0`.
- [ ] **Step 5: Verify in the browser** (the `run` / `audit-browser` recipes; never the shared dev DB for writes, so use a scratch-DB backend or read-only checks on dev):
  1. Export Quests.
  2. Edit a quest in SQL.
  3. The badge shows "1 edits not exported" and the popup lists it.
  4. Hand-edit the file so a value changes.
  5. Preview shows the row red. Bulk take-git, then Apply. History has the row, and the restart banner appears.
  6. Click "Restart backend". The banner clears after reload.
- [ ] **Step 6: Commit.** `feat(seed-sync): Seed / Export admin tab (SOMET-638)`
