# High-quality sprite lane (something2 side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin pick, per sprite job, a second "HQ" sprite connector whose box engine is `comfyui-hq`, send that engine to the box, prove it came back, and never mix engines in one sheet.

**Architecture:** A sprite connector (`ai_providers`, modality `sprite`) gains `request_template.engine`. The Sprite tab picks a connector per queue press; the row stores it in `sprite_sets.provider_id` (existing column). The dispatcher draws each row with its own connector, sends `engine` in the sheet spec, checks the box's echo, and reuses a base sheet only from the same engine.

**Tech Stack:** Node/Express (CommonJS, raw `pg`), node:test; React + TanStack Query + styled-components, vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-comfyui-hq-sprite-lane-design.md`

## Global Constraints

- Engine ids: exactly `diffusers` (default; absent = `diffusers`) and `comfyui-hq`.
- `comfyui-hq` is valid only with `sheet_method` `2d` (absent = 2d); `comfyui-hq` + `turnaround3d` is rejected at connector save.
- Props (`generation_kind = 'object'`) ignore the engine and the row connector choice.
- No silent fallback: a row whose stored connector is disabled/deleted/not sprite fails with exactly `the connector chosen for this row is no longer enabled`.
- Rows with `provider_id` NULL keep today's behaviour (active sprite connector).
- Box contract: spec field `engine`; echo in atlas as `atlas.engine = { name, model_file, precision, steps, cfg, loras }`; a missing echo counts as `diffusers`.
- Manifest keys (new): `box_engine` (string id) and `box_engine_info` (the echoed object, when present). The existing manifest key `engine` is the display label (`ENGINE_LABEL`) and stays untouched.
- HQ seed estimate: 70 s per cell until that connector has a measured done row.
- Never mutate the shared dev DB in tests: DB tests run only with `TEST_DATABASE_URL` + `DATABASE_URL` set to a scratch DB.

## Review Focus

1. A queued row whose connector is later disabled → it must fail with the exact message, not run on the active connector (Task 3 test).
2. An old box that silently drops the unknown `engine` field answers with no echo → an HQ row must fail, not store a Q2_K sheet as HQ (Task 4 test).
3. A subject whose only base sheet is standard, queued on HQ → full draw, nothing carried (Task 4 test).
4. Changing only the connector on an already-queued row → detaches its box job (Task 2 test).
5. Props selected together with creatures while the HQ connector is chosen → props keep `provider_id` NULL (Task 2 test).

---

### Task 1: Connector `engine` validation and listing

**Files:**
- Modify: `backend/src/services/aiProviders.js` (validation near `SHEET_METHODS`, export)
- Modify: `backend/src/api/spriteBatchRoutes.js` (new `GET /connectors`)
- Modify: `backend/src/services/spriteJobQueue.js` (`lastSecondsPerCell(db, providerId)`)
- Test: `backend/tests/ai_providers.test.js`, `backend/tests/sprite_batch_api.test.js`, `backend/tests/sprite_job_queue_db.test.js`

**Interfaces:**
- Produces: `SPRITE_ENGINES = ['diffusers','comfyui-hq']` and `spriteEngineOf(provider) -> 'diffusers'|'comfyui-hq'` exported from `aiProviders.js` (reads `provider.request_template.engine`, default `diffusers`).
- Produces: `GET /api/sprite-admin/connectors` → `200 [{ id, name, engine, is_active, seconds_per_cell }]` for enabled sprite connectors, active first. `seconds_per_cell` = `lastSecondsPerCell(pool, id)` ?? (engine `comfyui-hq` ? 70 : `SEED_SECONDS_PER_CELL`).
- Produces: `lastSecondsPerCell(db, providerId = null)`: with an id, only rows with that `provider_id`.

- [ ] **Step 1: Write failing tests**
  - `ai_providers.test.js`: validation rejects `request_template.engine: 'comfy'` with `engine must be one of diffusers, comfyui-hq`; rejects `{ engine: 'comfyui-hq', sheet_method: 'turnaround3d' }` with `the comfyui-hq engine draws 2d sheets only`; accepts `{ engine: 'comfyui-hq' }` and `{}`; `spriteEngineOf({ request_template: {} }) === 'diffusers'`.
  - `sprite_batch_api.test.js`: `GET /connectors` with a fake pool returning two enabled sprite rows → body lists both with `engine` and `seconds_per_cell` (70 for the HQ row with no measured rows).
  - `sprite_job_queue_db.test.js` (skip without DB): two done rows with different `provider_id` and `sheet_seconds` → `lastSecondsPerCell(client, idA)` returns A's value.
- [ ] **Step 2: Run** `cd backend && node --test tests/ai_providers.test.js tests/sprite_batch_api.test.js` → FAIL on the new tests.
- [ ] **Step 3: Implement** the validation (only for modality `sprite`), `spriteEngineOf`, the route (query `ai_providers WHERE enabled AND modality='sprite' ORDER BY is_active DESC, id`; never return secrets), and the `lastSecondsPerCell` filter.
- [ ] **Step 4: Run** the same tests + the DB test on a scratch DB → PASS.
- [ ] **Step 5: Commit** `feat(sprites): sprite connector engine (diffusers | comfyui-hq) + connector list`.

### Task 2: Per-row connector at enqueue

**Files:**
- Modify: `backend/src/api/spriteBatchRoutes.js` (`queueRequestFrom`: optional `provider_id`)
- Modify: `backend/src/services/spriteJobQueue.js` (`enqueue` option `providerId`; UPDATE + INSERT)
- Test: `backend/tests/sprite_batch_api.test.js`, `backend/tests/sprite_job_queue_db.test.js`

**Interfaces:**
- Consumes: Task 1's connector query semantics (enabled + modality sprite).
- Produces: `/jobs` and `/jobs/force` accept `provider_id` (positive integer of an enabled sprite connector; else 400 `provider_id must be an enabled sprite connector`); `enqueue(db, targets, { ..., providerId = null })` stores it on creature rows (props get NULL); a changed `provider_id` on a queued row detaches its box job (same `IS DISTINCT FROM` list as cell/redraw_actions).

- [ ] **Step 1: Failing tests**
  - API: `provider_id: 'x'`, `0`, an id the fake pool reports as not enabled → 400 with the message above; omitted → INSERT param for provider_id is `[null]`; valid id → `[id]`. Update the exact-params assertion in "jobs 201 updates an already-queued target…" for the new array.
  - DB: queued creature row with `box_job_id='box-p'` re-enqueued with a different `providerId` → `box_job_id` NULL and `dropped_box_job_id 'box-p'`; a prop enqueued with `providerId` → `provider_id` NULL (Review Focus 4, 5).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Validate the id in `queueRequestFrom` with one `SELECT id FROM ai_providers WHERE id=$1 AND enabled AND modality='sprite'`.
- [ ] **Step 4: Run** API + DB tests (scratch DB) → PASS.
- [ ] **Step 5: Commit** `feat(sprites): queue stores the chosen sprite connector per row`.

### Task 3: Dispatcher draws with the row's connector

**Files:**
- Modify: `backend/src/services/spriteDispatcher.js` (`execute`, `submit` kept-concept check, `createDispatcher` deps)
- Modify: `backend/src/index.js` (pass `loadProviderById`)
- Modify: `backend/src/services/aiProviders.js` (`loadSpriteProviderById(db, id)`)
- Test: `backend/tests/sprite_dispatcher.test.js`, `backend/tests/sprite_dispatcher_incremental.test.js`

**Interfaces:**
- Produces: `loadSpriteProviderById(db, id) -> row|null` (enabled AND modality `sprite`, with secret). `createDispatcher({ ..., loadProviderById })`; `execute` uses `row.provider_id ? await loadProviderById(row.provider_id) : await loadProvider()`; a NULL result for a set `provider_id` throws `the connector chosen for this row is no longer enabled`.
- Produces: kept concept reused when `kept.box_origin === origin` (provider id no longer compared).

- [ ] **Step 1: Failing tests**
  - Row with `provider_id: 7` and `loadProviderById` returning null → `queue.log.failed[0].message === 'the connector chosen for this row is no longer enabled'`, `box.calls.create.length === 0`, `loadProvider` never called (Review Focus 1).
  - Row with `provider_id: 7` → `createSheetJob` receives the provider object returned for 7 (assert `p.id === 7`).
  - Kept concept with `provider_id: 9`, row drawn by provider 7 on the same origin → `box.calls.concept === 0` (concept reused).
  - Row with `provider_id: null` → uses `loadProvider()` as today.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Redraw rows already copy `provider_id` (`createRedraw`), so they inherit the row's connector through `execute`.
- [ ] **Step 4: Run** `node --test tests/sprite_*.test.js` → PASS.
- [ ] **Step 5: Commit** `feat(sprites): each sprite row is drawn by its own connector, no fallback`.

### Task 4: Engine in the spec, echo check, same-engine reuse

**Files:**
- Modify: `backend/src/services/spriteDispatcher.js` (`sheetSpec`, intake after `buildBoxSheetManifest`, `findBase`, `storeIncremental`)
- Modify: `backend/src/services/spriteSheetManifest.js` (`buildBoxSheetManifest` copies the echo)
- Test: `backend/tests/sprite_dispatcher.test.js`, `backend/tests/sprite_dispatcher_incremental.test.js`, `backend/tests/sprite_sheet_manifest.test.js` (or the existing manifest test file)

**Interfaces:**
- Consumes: `spriteEngineOf(provider)` (Task 1).
- Produces: `sheetSpec` includes `engine: spriteEngineOf(provider)` **only when it is `comfyui-hq`** (diffusers spec stays byte-identical to today). `buildBoxSheetManifest` sets `manifest.box_engine = (atlas.engine && atlas.engine.name) || 'diffusers'` and `manifest.box_engine_info = atlas.engine` when it is an object. `assertEngineMatches(manifest, provider)` throws `the GPU box drew this with <got>, the row asked for <want>`. `findBase` skips a base whose `manifest.box_engine || 'diffusers'` differs from the row's engine. The merged manifest of an incremental run keeps the drawn sheet's `box_engine`/`box_engine_info`.

- [ ] **Step 1: Failing tests**
  - HQ provider (`request_template: { engine: 'comfyui-hq' }`) → `createSheetJob` spec has `engine: 'comfyui-hq'`; standard provider → spec has no `engine` key.
  - HQ provider, fake box atlas with no `engine` → row fails with `the GPU box drew this with diffusers, the row asked for comfyui-hq` and nothing stored (Review Focus 2).
  - HQ provider, atlas `engine: { name: 'comfyui-hq', model_file: 'q8.gguf', precision: 'Q8_0', steps: 30, cfg: 4, loras: ['angles'] }` → stored manifest `box_engine === 'comfyui-hq'` and `box_engine_info.model_file === 'q8.gguf'`.
  - Standard base sheet (no `box_engine`) + HQ row for the same subject/concept/cell → full draw (`create[0].actions` equals all row actions), `reused_from` undefined (Review Focus 3).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `findBase` needs the row's engine: pass the provider into `findBase(row, conceptBytes, provider)`.
- [ ] **Step 4: Run** `node --test tests/sprite_*.test.js` → PASS; DB tests on a scratch DB serially (`--test-concurrency=1`) → PASS.
- [ ] **Step 5: Commit** `feat(sprites): send the box engine, verify its echo, reuse only same-engine sheets`.

### Task 5: Admin UI — connector Engine field and Sprite tab Connector select

**Files:**
- Modify: `frontend/src/games/something2/providerForm.js`, `ProviderKindFields.jsx` (Engine select for sprite connectors)
- Modify: `frontend/src/games/something2/useSpriteConsole.js` (`useSpriteConnectors`, `queueJobsBody` passes `provider_id`)
- Modify: `frontend/src/games/something2/spriteSelection.js` (`queuePayload` option `providerId`), `SpriteConsoleAdmin.jsx` (Connector select; estimate from the chosen connector; Backend column label)
- Test: `frontend/src/games/something2/__tests__/providerFormSprite.test.js`, `__tests__/queueJobsBody.test.js`

**Interfaces:**
- Consumes: `GET /api/sprite-admin/connectors` (Task 1), `/jobs` `provider_id` (Task 2).
- Produces: sprite provider payload `request_template: { sheet_method, engine }` (engine omitted when `diffusers`); Engine select options `Standard (diffusers)` / `High quality (ComfyUI)`; selecting HQ forces Directions to `2d` and disables `turnaround3d`. Sprite tab: `Connector` select shown only when the list has ≥ 2 entries, default = the active connector; `queuePayload(..., { providerId })` adds `provider_id` for creature selections only; the estimate uses the chosen connector's `seconds_per_cell`; the Backend column shows `gpu-box · HQ` when the row's connector engine is `comfyui-hq` (the `/subjects` row gains `provider_engine`, joined from `ai_providers`).

- [ ] **Step 1: Failing tests**
  - `providerFormSprite.test.js`: form with engine `comfyui-hq` → payload `request_template` `{ sheet_method: '2d', engine: 'comfyui-hq' }`; engine `diffusers` → no `engine` key; loading a row with `request_template.engine` sets the form field.
  - `queueJobsBody.test.js`: `queuePayload(catalog, [creatureRow], { actions:['idle'], frames:2, providerId: 5 })` → `provider_id: 5`; props-only selection → no `provider_id` key; omitted → no key.
- [ ] **Step 2: Run** `cd frontend && npx vitest run src/games/something2` → FAIL.
- [ ] **Step 3: Implement** (and add `provider_engine` to the two `/subjects` SELECTs in `spriteBatchRoutes.js` via `LEFT JOIN ai_providers p ON p.id = j.provider_id`, `p.request_template->>'engine' AS provider_engine`, plus `provider_engine` in the mapped row).
- [ ] **Step 4: Run** frontend vitest (all) + `cd backend && node --test tests/sprite_batch_api.test.js` → PASS.
- [ ] **Step 5: Browser check** (muted headless Chrome, `--mute-audio`): create an HQ connector on a **scratch path only if the dev DB must not change** — otherwise create it in AI Providers as the admin would; Sprite tab shows the Connector select; queue Warrior 2 idle with HQ and verify the stored row `provider_id`; delete that row without dispatching unless the box reports the HQ lane ready. Screenshot.
- [ ] **Step 6: Commit** `feat(sprites): Engine on sprite connectors, Connector choice in the Sprite tab`.

## After all tasks

- Final whole-branch review, then merge to main and push (standing authorization), Plane ticket To Review with evidence.
- Live end-to-end (HQ Warrior 2 sheet) waits for the box session to report its HQ lane ready and to confirm the final echo field names; adjust Task 4's names if the box renames them.
