# GPU-box Sprite Sheets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Sprite Generation page queues every subject (creatures, classes, props) to the GPU box's Qwen sheet builder with box-supplied actions and frames-per-action, stores sheet + concept + a row-describing JSON, and shows them in preview popup "A".

**Architecture:** A new backend client (`gpuBoxSprites.js`) wraps the box's concept + sheet-job API through `safeFetch`. The existing sprite queue/dispatcher gains a box path (concept → sheet job → poll → store), persisting `box_job_id` so a restart resumes instead of duplicating. A pure manifest builder turns the box's atlas into our `sheet.json`. The page reads the action catalog through a backend proxy and renders popup A from `sheet.json`.

**Tech Stack:** Node/Express (CommonJS), raw `pg`, node-pg-migrate, MinIO via `assetStore`, `node --test`; React 19 + styled-components + TanStack Query, vitest (node env, no DOM).

**Spec:** `docs/superpowers/specs/2026-10-21-gpu-box-sprite-sheets-design.md`

## Global Constraints

- Work in ONE worktree: `.worktrees/wt-gpu-sprites`, branch `feat/gpu-box-sprite-sheets`; symlink `frontend/node_modules` and `backend/node_modules` with ABSOLUTE paths to the main checkout's. Never checkout/stash/reset in the shared checkout.
- Box base: origin of the active `modality='sprite'` provider's `base_url` (Task 4b; today the box is `http://192.168.0.218:8001`); auth via `authHeaders(provider)`; every call through `safeFetch`. The token never reaches the browser and is never printed/logged.
- All 8 facings for creatures/classes/appearance variants: `["s","se","e","ne","n","nw","w","sw"]`; props: `["s"]`.
- JobSpec fixed values: `cell: "48x64"`, `colors: 24`, `concept_check: false`, `style_profile: null`, `seed` from `seedFor`.
- Prop default actions: `idle` + `sway`. Concept from `POST /api/generate_core` with `llm_name = provider.model`.
- Estimated time seed: **22 s/cell** until a job has been measured.
- No local sprite-gen fallback from this page; a box failure is `status='failed'` with a readable `last_error`.
- Stop = claim nothing new; the job on the box runs to completion (no DELETE).
- DB tests: `TEST_DATABASE_URL` set to a scratch DB (never the shared dev DB); run the suite with it set. Done = backend `npm test` exit 0 (with `TEST_DATABASE_URL`), frontend `npx vitest run` exit 0, browser verification. Read exit codes, grep `^not ok` / `testTimeoutFailure`.
- Never edit migrations while the shared stack is up and pointed at your files (the worktree is not mounted, so this is safe there — keep it that way).
- Commit subject `type(sprites): summary`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Box goes offline mid-batch (it did on 2026-10-20) → current job fails with "could not reach …", the rest stay queued once the run stops; page still loads with an "unreachable" banner. *(Task 5 test `box unreachable fails the row and keeps draining`; Task 6 test `catalog 503 when box down`.)*
2. Mixed selection of props and creatures → props get `["s"]`, creatures 8 facings, same actions/frames. *(Task 4 test `enqueue gives props one facing`.)*
3. Frames above the smallest `max_frames` of the selected actions, or an unknown action → 400 naming the problem. *(Task 6 tests.)*
4. Box atlas that doesn't fit the sheet PNG, or rows missing a requested action/facing → job fails; never a JSON that disagrees with the image. *(Task 3 tests.)*
5. Backend restart (nodemon) while a box job runs → Rescue/next start resumes polling that `box_job_id`, no second box job. *(Task 5 test `resumes an attached box job instead of resubmitting`.)*

---

### Task 1: Capture the real box contract (spike, writes fixtures)

The spec marks `GET /api/jobs/{id}`, `/sheet`, `/atlas` and the `generate_core` → task-status → concept link as **not yet observed**. Everything downstream parses them, so capture first.

**Files:**
- Create: `backend/scripts/capture-gpu-box-sprite.js` (kept; useful for re-capture)
- Create: `backend/tests/fixtures/gpuBox/` — `action-catalog.json`, `generate-core-response.json`, `task-status-done.json`, `job-running.json`, `job-done.json`, `job-failed.json` (if observed), `atlas.json`, `sheet.png` (small capture), `wolf-sheet.png`, `tree-sheet.png`
- Modify: spec §"Not yet observed" → replace with the observed shapes (abridged) and timings

**Interfaces:** Produces the fixtures Tasks 2, 3, 5 test against.

- [ ] **Step 1:** Script loads the provider with `loadActiveProviderWithSecret(pool, 'image')` (read-only DB access, no writes), and NEVER prints headers/token. It runs: catalog; `generate_core` (form `prompt`, `llm_name`) and record its JSON response (spec says it returns a task id); poll `GET /api/task-status/{task_id}` until terminal, record it, find the concept filename/url in it; `POST /api/jobs` with `{prompt, concept_image:<that path>, actions:["idle"], directions:["s","e"], frames:2, cell:"48x64", colors:24, seed:1, concept_check:false}`; poll `GET /api/jobs/{id}` recording one running and the done body; download `/sheet` and `/atlas`.
- [ ] **Step 2:** Run once for **Wolf** (wide creature, actions `idle`, 2 frames, 8 facings) and once for a **tree** prop (actions `idle,sway`, 2 frames, `["s"]`). Look at both sheets by eye (Read the PNGs).
- [ ] **Step 3: Decision gate.** Record in the spec: (a) does `generate_core`'s task-status name the concept file? If not, find another reliable tie (asset record carrying our prompt + created after submit, matched on BOTH) — if none exists, stop and report; (b) does `concept_check:false` give usable Wolf and tree sheets? If not, do Task 9 before Task 5.
- [ ] **Step 4: Commit** fixtures + script + spec update: `chore(sprites): capture GPU box sheet contract`.

### Task 2: Box client `gpuBoxSprites.js`

**Files:**
- Create: `backend/src/services/gpuBoxSprites.js`
- Test: `backend/tests/gpu_box_sprites.test.js`

**Interfaces:**
- Consumes: `safeFetch, readCapped, readJsonCapped, redactUrl, errorDetail` (`safeFetch.js`); `authHeaders, resolveUrl` (`providerDiscovery.js`); Task 1 fixtures.
- Produces (every fn takes `provider` first and `{ fetchImpl }` last, returns `{ok:true, ...}` | `{ok:false, error, retryable?}` like `remoteAudioProvider.callJson`):
  - `actionCatalog(provider) → {ok, catalog}` — `catalog = {actions:[{id,label,max_frames}], directions:[{id,family}], max_frames, engine:{label}}`
  - `generateConcept(provider, {prompt}) → {ok, conceptPath, png: Buffer}` — submit, poll task-status (POLL_MS, `GPU_BOX_CONCEPT_TIMEOUT_MS` default 15 min), resolve the concept by the tie chosen in Task 1, download it.
  - `createSheetJob(provider, spec) → {ok, boxJobId}`
  - `getSheetJob(provider, boxJobId) → {ok, job:{status:'queued'|'running'|'done'|'failed'|'cancelled'|'missing', progress?:{done,total}, error?}}` — normalize the box's field names here; a 404 → `status:'missing'`.
  - `fetchSheet(provider, boxJobId) → {ok, png: Buffer}`; `fetchAtlas(provider, boxJobId) → {ok, atlas}` (raw box atlas).
  - Module-level `STATUS_TERMINAL = new Set(['done','failed','cancelled','missing'])`.

- [ ] **Step 1: Failing tests** (fake `fetchImpl` returning fixture bodies; assert on URL + method + headers):
  - `actionCatalog returns the box catalog` — 7 actions, `max_frames` 6.
  - `requests carry the provider auth header and hit the base_url origin` — provider `base_url: 'http://box:8001/sdapi/v1/txt2img'` → request to `http://box:8001/api/action-catalog`.
  - `generateConcept resolves the concept from the task, not the newest asset` — fake asset list whose newest item is someone else's; result must be the task's concept.
  - `generateConcept fails when the task fails` → `ok:false`, error contains the box's message.
  - `createSheetJob posts the JobSpec as JSON and returns the id` (202 accepted as success).
  - `getSheetJob maps 404 to missing`.
  - `unreachable box returns a readable retryable error` — fetchImpl throws → `ok:false, retryable:true`, `error` starts `could not reach`.
- [ ] **Step 2:** `cd backend && node --test tests/gpu_box_sprites.test.js` → FAIL (module not found).
- [ ] **Step 3:** Implement, modelled on `remoteAudioProvider.js:17-58` (`call/callJson`); form-encoded body for `generate_core` (as `scripts/generate-entity-textures.js:204-216`); PNG reads via `readCapped` (cap `GPU_BOX_SHEET_MAX_BYTES`, default 32 MB).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(sprites): GPU box sheet client`.

### Task 3: Sheet manifest builder

**Files:**
- Create: `backend/src/services/spriteSheetManifest.js`
- Test: `backend/tests/sprite_sheet_manifest.test.js`

**Interfaces:**
- Consumes: raw box atlas (Task 1 `atlas.json` shape); `pngSize(buffer) → {width,height}` — reuse the PNG-header reader in `services/spriteSheet.js` if exported, else add it there.
- Produces: `buildSheetManifest({ atlas, sheetPng, actions, directions, frames, engine, boxJobId, kind }) → { ok:true, manifest } | { ok:false, error }` where `manifest` is exactly the spec's `sheet.json` (`version:1, sheet:'sheet.png', concept:'concept.png', engine, box_job_id, cell:[w,h], actions, frames_per_action, rows:[{row, action, direction, frames}], frames:{'<action>/<dir>/<i>':[x,y,w,h]}}`). For `kind === 'object'` it ALSO adds bare keys `'0'..'n-1'` = the `sway` row (fallback `idle`, then first row). Also `staticFrameFor(manifest) → 'idle/s/0'` if present else first key of `frames`.

- [ ] **Step 1: Failing tests:**
  - `builds rows and frames from the captured atlas` — fixture → rows count = actions×directions, every row `frames === frames_per_action`, every rect inside the PNG.
  - `rejects a rect outside the sheet` → `ok:false`, error mentions the key.
  - `rejects an atlas missing a requested action or facing` → `ok:false`.
  - `prop manifest loops the sway row on bare keys` — kind object, actions `['idle','sway']` → `frames['0']` deep-equals `frames['sway/s/0']`, and `'1'` = `'sway/s/1'`.
  - `prop without sway loops idle`.
  - `staticFrameFor prefers idle facing south`.
  - `game reads it`: import nothing from frontend; assert `Object.keys(manifest.frames)` parsed by the same rule as `tileFrameKey` (`parseInt` finite) yields only the bare keys.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; row/key naming follows the box atlas as captured (lower-case box direction ids). **Step 4:** PASS. **Step 5: Commit** `feat(sprites): sheet.json builder`.

### Task 4: Migration + queue

**Files:**
- Create: `backend/migrations/<next free ts, > 1714440812000>_sprite_sets_box_sheets.js` — check `ls migrations | tail` at execution time and the migration-collision notes.
- Modify: `backend/src/services/spriteJobQueue.js`, `backend/src/services/spriteBatchOptions.js`
- Test: `backend/tests/sprite_job_queue_db.test.js` (extend), `backend/tests/sprite_batch_options.test.js` (extend)

**Interfaces:**
- Migration adds to `sprite_sets`: `actions text[]`, `directions text[]`, `frames_per_action integer`, `concept_key text`, `box_job_id text`, `sheet_seconds integer` (measured wall time). All nullable; `IF NOT EXISTS`; `down` drops them.
- Produces:
  - `SPRITE_DIRECTIONS = ['s','se','e','ne','n','nw','w','sw']` exported from `spriteBatchOptions.js`; `optionsForEntity`/`optionsForAppearance` gain `directions` (8 or `['s']` for `kind==='object'`). Replace the file's header comment (it says everything goes to local sprite-gen).
  - `enqueue(db, targets, { actions, framesPerAction })` — stores `actions`, `directions`, `frames_per_action`, `frames = framesPerAction`, `backend = 'gpu-box'`.
  - `attachBox(db, id, { boxJobId, conceptKey, providerId })`.
  - `complete(db, id, result)` also stores `result.concept_key`, `result.sheet_seconds`.
  - `requeueStale(db, staleMs)` unchanged in SQL; resume decision lives in the dispatcher (Task 5) because it needs the box.
  - `lastSecondsPerCell(db) → number|null` — newest done row with `sheet_seconds` ÷ (`array_length(actions)×array_length(directions)×frames_per_action`).

- [ ] **Step 1: Failing tests** (DB tests in one rolled-back transaction, existing file pattern):
  - `enqueue stores actions, frames and 8 facings for a creature`.
  - `enqueue gives props one facing` — mixed creature + prop targets in one call.
  - `attachBox records the box job and concept`.
  - `lastSecondsPerCell divides by cells`.
  - options tests: `prop options get ['s']`, `appearance options get 8 facings`.
- [ ] **Step 2:** Run with `TEST_DATABASE_URL` → FAIL. **Step 3:** Implement. **Step 4:** PASS (also existing queue tests). **Step 5: Commit** `feat(sprites): box sheet columns on sprite_sets`.

### Task 4b: `sprite` provider modality (added 2026-10-21, user request)

The user asked for a dedicated sprite connection in AI Providers instead of borrowing the image (txt2img) provider. Same pattern as the `text` modality (`backend/migrations/1714440610000_*.js`).

**Files:**
- Create: `backend/migrations/1714440821000_ai_providers_sprite_modality.js` (widen `ai_providers_modality_check` to `('image','audio','text','sprite')`; `down` deletes sprite rows and restores the 3-value check, as the text migration does)
- Modify: `backend/src/services/aiProviders.js` (validation at ~:106-111 and templateless rule at ~:209 accept `sprite` like `text`), provider Test/Refresh for sprite → `GET /api/action-catalog` reports the action count
- Modify: frontend `providerForm.js`, `SettingsAdmin.jsx` (and whatever lists modalities) — "Sprite" option; image-only fields hidden as for text/audio; base URL hint `http://<box>:8001`
- Test: backend aiProviders tests for sprite create/validate/single-active; frontend `__tests__/aiProvidersModality.test.js` / `providerFormText.test.js` style test for sprite

**Interfaces:** Produces `loadActiveProviderWithSecret(db, 'sprite')` returning the sprite provider. Tasks 5/6 use THIS (not `'image'`); no active sprite provider → Task 6 catalog route 503 "no sprite provider configured — add one in Settings → AI Providers (modality Sprite)", Task 5 job fails with the same text.

- [ ] Failing tests → implement → pass (scratch DB for DB tests) → commit `feat(sprites): sprite modality for AI providers`.

### Task 5: Dispatcher box path

**Files:**
- Modify: `backend/src/services/spriteDispatcher.js`, `backend/src/index.js:403-411` (inject box client + provider loader + `assetStore`)
- Test: `backend/tests/sprite_dispatcher.test.js` (extend)

**Interfaces:**
- Consumes: Task 2 client, Task 3 builder, Task 4 queue fns.
- `createDispatcher({ db, queue, box, loadProvider, store, pollMs, stallMs = 20*60*1000, cellTimeoutMs = 120000 })` — `box` = Task 2 module, `loadProvider()` → active image provider with secret, `store` = `{ putObject, BUCKET }`. The `spriteGen` dependency is removed from this dispatcher.
- Execute order for a claimed row: if `row.box_job_id` set → `getSheetJob`; status `queued|running|done` → resume polling it; else (failed/missing/none) → `generateConcept` → `putObject('<BUCKET>/<safe creature>/<row.id>/concept.png')` → `createSheetJob` with spec from the row + Global Constraints → `attachBox` → poll. On done: `fetchSheet` + `fetchAtlas` → `buildSheetManifest` → `putObject` `sheet.png` and `sheet.json` (`application/json`) under the same prefix → `complete` with `atlas_key` = sheet key, `manifest_key` = json key, `concept_key`, `sheet_seconds`.
- Poll: fail as `box stalled: no progress for N min` when `progress.done` unchanged for `stallMs`; overall deadline `cells × cellTimeoutMs`.
- Rescue path: `requeueStale` rows keep `box_job_id`, so the next claim resumes them (that is the mechanism).

- [ ] **Step 1: Failing tests** (fakes only, `pollMs: 0`):
  - `box job: concept, sheet, manifest stored under the row prefix` — asserts the three put keys and the `complete` payload.
  - `resumes an attached box job instead of resubmitting` — row with `box_job_id`, fake `getSheetJob` running→done; `generateConcept`/`createSheetJob` call counts are 0.
  - `resubmits when the attached box job is missing`.
  - `box unreachable fails the row and keeps draining` — two rows; first `generateConcept` → `{ok:false, retryable:true, error:'could not reach …'}`; `fail` called with that message; second row still runs.
  - `stalled box job fails as stalled`.
  - `manifest mismatch fails the row and stores nothing as done`.
  - `stop lets the current box job finish and claims nothing more`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; replace the existing local-path tests that no longer apply. **Step 4:** PASS. **Step 5: Commit** `feat(sprites): dispatcher runs sheets on the GPU box`.

### Task 6: Routes

**Files:**
- Modify: `backend/src/api/spriteBatchRoutes.js`, `backend/src/index.js:599` (pass box + loadProvider)
- Test: `backend/tests/sprite_batch_api.test.js`, `backend/tests/sprite_batch_approve_api.test.js`, `backend/tests/sprite_batch_subjects_db.test.js` (extend)

**Interfaces:**
- `GET /api/sprite-admin/action-catalog` → `200 {actions, directions, max_frames, engine, seconds_per_cell}` (`seconds_per_cell` = `lastSecondsPerCell` ?? 22). Cached 60 s in-process. Box down / no active image provider → `503 {error}` with a readable message.
- `POST /jobs` body `{targets, actions: string[], frames: int}` → 400 if `actions` empty, any id not in the live catalog, or `frames` not an integer in `1..min(max_frames of selected actions)`; message names the bad action or the cap. Catalog unreachable → 503.
- Approve: creature/appearance → `sprite = {atlas_key, manifest_key, static_frame: staticFrameFor(manifest)}`, `render_mode='static'`; object → `sprite = {atlas_key, manifest_key, frames: frames_per_action}`, `render_mode='animated'` (static frame read from the stored `sheet.json` via `assetStore`). Remove the old `object && frames===1 → image` branch for `backend='gpu-box'` rows only; older local rows keep current behaviour.
- `GET /subjects` adds `concept_key, actions, directions, frames_per_action, manifest_key, box_job_id` from the newest job.

- [ ] **Step 1: Failing tests:** `catalog proxies the box with seconds_per_cell`, `catalog 503 when box down`, `jobs 400 on unknown action`, `jobs 400 when frames exceed the selected actions' cap`, `jobs 201 queues with actions and frames`, `approve prop sheet sets animated sway`, `approve creature sheet sets static_frame idle/s/0`, `subjects carry concept_key and actions`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5: Commit** `feat(sprites): catalog route, action-aware enqueue and approve`.

### Task 7: Page controls (frontend)

**Files:**
- Modify: `frontend/src/games/something2/useSpriteConsole.js`, `frontend/src/games/something2/spriteSelection.js`, `frontend/src/games/something2/SpriteConsoleAdmin.jsx`
- Test: `frontend/src/games/something2/__tests__/spriteSelection.test.js` (extend)

**Interfaces:**
- `useActionCatalog() → { catalog, isLoading, error }` (queryKey `['spriteAdmin','actionCatalog']`, `staleTime` 60 s, `retry: false`).
- `useQueueSprites` mutate arg becomes `{ targets, actions, frames }`.
- Pure helpers in `spriteSelection.js`:
  - `framesCap(catalog, actions) → number` (min `max_frames` of selected; catalog `max_frames` when none).
  - `cellCount(rows, actions, frames) → number` (8 per directional row, 1 per flat row — via existing `spriteShape`).
  - `estimateLabel(cells, secondsPerCell) → string` e.g. `"336 cells · ~2 h 3 min"` (`< 1 min` floor).
  - `defaultActions(catalog) → ['idle','sway']` filtered to ids present.

- [ ] **Step 1: Failing tests:** `framesCap uses the smallest selected max`, `cellCount gives props one facing`, `estimateLabel formats 336 cells at 22 s` → `"336 cells · ~2 h 3 min"`, `defaultActions keeps only catalog ids`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement helpers; in the component add action checkboxes (catalog labels), one frames `<select>` `1..framesCap`, the estimate line next to Queue, and a danger banner + disabled Queue when the catalog query errors. Remove the hint text that says jobs run on the local sprite service. **Step 4:** `npx vitest run` → PASS. **Step 5: Commit** `feat(sprites): action and frame controls from the box catalog`.

### Task 8: Preview popup A + table columns

**Files:**
- Create: `frontend/src/games/something2/SpritePreviewModal.jsx`
- Modify: `SpriteConsoleAdmin.jsx`, `spriteSelection.js`
- Test: `__tests__/spriteSelection.test.js` (extend), `__tests__/SpriteConsoleAdmin.smoke.test.js` (import the modal too)

**Interfaces:**
- `SpritePreviewModal({ subject, onClose })` — uses `Modal` from `seedUi.jsx` (`$w="900px"`, `label`). Left: concept `<img>` (`assetUrlVersioned(subject.concept_key, …)`) + file name + natural size. Right: sheet `<img>` scaled ×2, `image-rendering: pixelated`; row list from `sheet.json` fetched with TanStack Query from `assetUrl(subject.manifest_key)`; download links for sheet and JSON. Header: `subject.name · <box_job_id> · <engine>`.
- `rowLabels(manifest) → string[]` e.g. `"row 0 · idle · s · 4 frames"`.
- Table: new **Concept** and **Sheet** thumbnail columns (click → modal), **Actions** column (`idle · walk · attack`), **Frames** shows `"<n> / action"` for box rows.

- [ ] **Step 1: Failing test:** `rowLabels formats each row` (and `[]` for a manifest without `rows` — legacy local atlases).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + smoke test. **Step 5: Commit** `feat(sprites): concept and sheet preview popup`.

### Task 9 (only if Task 1's gate says so): make wide creatures and props pass

**Files:** `backend/src/services/gpuBoxSprites.js` (+ test), spec.

- [ ] Find a box route that stores an uploaded image where `/api/jobs` can read it as `concept_image` (check OpenAPI: `/api/references`, `/api/references/from-asset`, `/api/edit`). If one exists: `padConceptPortrait(png) → png` (transparent/flat-key padding to height ≥ 1.25 × width) before upload; tests: `pads a wide concept taller than wide`, `leaves a tall concept unchanged`. Re-run Task 1's Wolf + tree capture and look at them.
- [ ] If none exists: STOP and report to the user — the fix needs the box owner (spec, Decisions). Do not ship a path that skips or silently fails these subjects.

### Task 10: End-to-end verification

- [ ] **Step 1:** Full suites: `cd backend && TEST_DATABASE_URL=<scratch> npm test; echo $?` → 0 (grep `^not ok`, `testTimeoutFailure` empty); `cd frontend && npx vitest run; echo $?` → 0.
- [ ] **Step 2:** Run the worktree backend + vite on own ports against a scratch DB (dev-run notes), real box: queue **Wolf** (idle+walk, 2 frames) and a **tree** (idle+sway, 2 frames); confirm `sheet.json` rows match the sheet by eye; open popup A for both; approve both; load the game and see the tree sway and Wolf render its static frame.
- [ ] **Step 3:** Box-down check: stop reaching the box (point the scratch provider at an unused port) → page loads with the banner; a queued job fails with a readable error.
- [ ] **Step 4:** Record timings in the spec; commit `docs(sprites): verification notes`.
