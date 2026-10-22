# Sprite Frame Redraw (admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin mark bad frames of a finished GPU-box creature sheet in the sprite preview popup, see which neighbours the box will use as context, send them for redraw through the existing batch queue, and review the result before the game sees it.

**Architecture:** A redraw is a new `sprite_sets` row (`redraw_of`, `redraw_frames`, `box_task_id`) copied from the subject's newest sheet. The dispatcher runs it through a new `executeRedraw` branch that calls a (not-yet-built) box redraw API, then stores `sheet.png`/`sheet.json` under the new row's own prefix. Approve is unchanged, so the game keeps the old art until the redraw row is approved. The frontend adds a frame grid (marking + compare) inside `SpritePreviewModal`, with all logic in pure helpers.

**Tech Stack:** Express + `pg` (CommonJS, raw SQL), node-pg-migrate, `node --test` + supertest (backend); React + styled-components + TanStack Query, vitest node-env with `renderToString` (frontend).

**Spec:** `docs/superpowers/specs/2026-10-22-sprite-frame-redraw-admin-design.md` (approved 2026-10-22). Read it before any task.

## Global Constraints

- Every box-facing call lives in `backend/src/services/gpuBoxSprites.js`, goes through `call`/`callJson` (safeFetch, capped reads) and returns `{ ok: true, ... } | { ok: false, error, retryable? }`.
- Box redraw contract is **[ASSUMED]**: `POST /api/jobs/{boxJobId}/redraw` body `{"frames":[{action,direction,frame}]}` → JSON with `task_id` (or `job_id`); the task is polled with `GET /api/jobs/{taskId}` (same status set as a sheet job) and cancelled with `DELETE /api/jobs/{taskId}`; after it is done, `/api/jobs/{boxJobId}/sheet` and `/atlas` return the updated sheet. Keep this knowledge inside `redrawFrames` and the comment above `executeRedraw`.
- Western rows `w`, `nw`, `sw` are never markable: UI disables them, API rejects them with 400.
- A redraw only starts from the subject's **newest row with a sheet** (`atlas_key IS NOT NULL`); a done redraw can never be deleted.
- Redraw rows store `sheet_seconds` NULL.
- DB tests: set **both** `TEST_DATABASE_URL` and `DATABASE_URL` to one scratch database for this branch. Never run DB tests, migrations or experiments against the shared dev DB.
- Migration file name: next free timestamp after the newest in `backend/migrations/` **on origin/main at the time of the task** (today `1714440824000_entity_types_idle_fx.js` → `1714440825000_sprite_sets_redraw.js`). Re-check before committing; timestamps clash across parallel branches.
- Work in your own worktree, never in the shared checkout.
- UI uses `--s2-*` tokens and the existing popup's components (`Modal`, `Muted` from `seedUi.jsx`, checkerboard `CHECKER`).
- Copy strings fixed by the spec (use verbatim):
  - `"Not drawn in game (mirrored from e / ne / se)"`
  - `"×2 in game"`
  - `"The GPU box no longer has this sheet's job. Queue the whole sheet again."`
  - Row summary formats: `"f2, f3 redrawn in order · context: f1, f4"`, `"f0 · context: f1 only (row start)"`, `"f5 · context: f4 only (row end)"`, `"whole row · no neighbour context, drawn fresh from the concept"`.
  - Button `"Redraw N frames"` (singular `"Redraw 1 frame"`), `"Mark flagged (N)"`, `"Compare with previous"`, `"Retry redraw"`, `"Discard redraw"`, warning `"changed, not marked"`.

## Review Focus

1. **Full "Queue" pressed while a redraw is queued** → the queued redraw row is deleted and a fresh full-sheet row is inserted; it is never updated in place into a hybrid. Test in Task 1.
2. **Dispatcher restart / Rescue mid-redraw** (`box_task_id` already set) → polling resumes on the same task; `redrawFrames` is not called again. Test in Task 4.
3. **Redraw request against an outdated sheet** (a newer row with a sheet exists, e.g. the admin had the popup open while another redraw finished) → 409, nothing queued. Test in Task 5.
4. **Frame list from a stale manifest** (frame index ≥ `frames_per_action`, action not in the sheet, duplicate entries) → 400 naming the bad entry. Test in Task 5.
5. **Popup closed with unsent marks** → confirmation; cancelling keeps the popup and the marks. Test in Task 7 (pure `shouldConfirmClose`).

---

### Task 1: Schema and queue support for redraw rows

**Files:**
- Create: `backend/migrations/1714440825000_sprite_sets_redraw.js` (timestamp per Global Constraints)
- Modify: `backend/src/services/spriteJobQueue.js` (`enqueue`, `queuedCells`, `requeueHalted`, new `createRedraw`, `attachRedrawTask`, `recordRedrawSheet`, `discardRedraw`)
- Test: `backend/tests/sprite_redraw_migration.test.js`, `backend/tests/sprite_job_queue_db.test.js` (append)

**Interfaces:**
- Produces:
  - columns `sprite_sets.redraw_of uuid NULL REFERENCES sprite_sets(id) ON DELETE SET NULL`, `redraw_frames jsonb NULL`, `box_task_id text NULL`.
  - `createRedraw(db, source: Row, frames: Array<{action,direction,frame}>) -> Promise<Row|null>`: inserts a `queued` row copying `entity_type_id, appearance_variant, creature, generation_kind, base_prompt, backend, seed, frames, actions, directions, frames_per_action, concept_key, box_job_id, provider_id` from `source`, with `redraw_of = source.id`, `redraw_frames = frames`; `ON CONFLICT DO NOTHING`; returns null when the live-job index rejects it.
  - `attachRedrawTask(db, id, taskId) -> Promise<Row|null>`: sets `box_task_id`.
  - `recordRedrawSheet(db, id, { atlas_key, manifest_key }) -> Promise<Row|null>`: sets those keys only (used on a failed redraw).
  - `discardRedraw(db, id) -> Promise<'deleted'|'not_found'|'not_discardable'>`: deletes when `redraw_of IS NOT NULL` and (`status = 'queued'` OR (`status = 'failed'` AND (`box_task_id IS NULL OR atlas_key IS NULL`))).
  - `queuedCells` counts `jsonb_array_length(redraw_frames)` for redraw rows.
  - `requeueHalted` keeps `box_job_id` and clears `box_task_id` for redraw rows (unchanged for others).
  - `enqueue` first deletes `queued` redraw rows of its targets, and its UPDATE adds `AND s.redraw_of IS NULL`.

- [ ] **Step 1: Write the failing migration test** (`sprite_redraw_migration.test.js`, same `fakePgm` style as `sprite_batch_migration.test.js`, or source-text if the migration uses `pgm.sql`): `up` adds the three columns with the reference; `down` drops all three.
- [ ] **Step 2: Write failing DB tests** in `sprite_job_queue_db.test.js` (each in one rolled-back transaction, `{ skip }` like the file's others):
  - `createRedraw copies the source and stores frames` — asserts `redraw_of`, `redraw_frames` deep-equal input, `box_job_id`/`concept_key` copied, `status === 'queued'`, `sheet_seconds === null`.
  - `createRedraw returns null when the subject already has a live job`.
  - `queuedCells counts only marked frames for a redraw row` — a redraw row with 3 frames on a 7×8×6 source adds 3.
  - `requeueHalted keeps box_job_id on a redraw row and clears box_task_id`.
  - `enqueue replaces a queued redraw with a fresh full sheet` — after enqueue, the redraw row is gone and the new row has `redraw_of IS NULL` and the requested actions.
  - `discardRedraw`: queued → `'deleted'`; failed with `box_task_id` and `atlas_key` → `'not_discardable'`; failed with `box_task_id` but no `atlas_key` → `'deleted'`; done → `'not_discardable'`.
- [ ] **Step 3: Run and see them fail.** `cd backend && TEST_DATABASE_URL=… DATABASE_URL=… node --test tests/sprite_redraw_migration.test.js tests/sprite_job_queue_db.test.js` → new tests FAIL (column/function missing). Apply the migration to the scratch DB only.
- [ ] **Step 4: Implement** the migration and the queue changes listed under Produces.
- [ ] **Step 5: Run again** → all PASS, and the file's existing tests still PASS. Run the DB file twice in a row (a fresh-DB-only pass hides leaks).
- [ ] **Step 6: Commit** `feat(sprites): redraw rows in sprite_sets and the queue`.

### Task 2: Manifest carries box quality flags

**Files:**
- Modify: `backend/src/services/spriteSheetManifest.js` (`buildBoxSheetManifest`)
- Test: `backend/tests/sprite_sheet_manifest.test.js` (append)

**Interfaces:**
- Produces: `manifest.quality` = `atlas.quality` entries whose `${action}/${direction}/${frame}` exists in `manifest.frames`, order kept; key absent when `atlas.quality` is missing or not an array. `version` stays 1.

- [ ] **Step 1: Failing tests:** `copies atlas.quality for known frames` (one known entry kept unchanged, one with `frame: 99` dropped); `no quality key without atlas.quality`; `non-array quality is ignored`.
- [ ] **Step 2: Run** `node --test tests/sprite_sheet_manifest.test.js` → FAIL.
- [ ] **Step 3: Implement** in `buildBoxSheetManifest`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sprites): keep the box's per-frame quality in sheet.json`.

### Task 3: Box client `redrawFrames`

**Files:**
- Modify: `backend/src/services/gpuBoxSprites.js`
- Test: `backend/tests/gpu_box_sprites.test.js` (append)

**Interfaces:**
- Produces: `redrawFrames(provider, boxJobId, frames, { fetchImpl }) -> { ok: true, taskId } | { ok: false, error, retryable?, providerFault? }`. POSTs JSON `{ frames }` to `/api/jobs/${encodeURIComponent(boxJobId)}/redraw`; `taskId = json.task_id || json.job_id`; a 2xx with neither → `{ ok: false, error: 'GPU box accepted the redraw but returned no task id', providerFault: true }`; a 404 → `{ ok: false, error: "The GPU box no longer has this sheet's job. Queue the whole sheet again." }`. Exported.

- [ ] **Step 1: Failing tests** with a fake `fetchImpl`: posts to the right path with the frames body and auth header; returns `task_id`; falls back to `job_id`; no id → providerFault error; 404 → the spec's message; 500 → `ok: false`.
- [ ] **Step 2: Run** `node --test tests/gpu_box_sprites.test.js` → FAIL.
- [ ] **Step 3: Implement** next to `createSheetJob`, with a comment that the shape is **[ASSUMED]** per the spec.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sprites): box client for redrawing chosen frames`.

### Task 4: Dispatcher `executeRedraw`

**Files:**
- Modify: `backend/src/services/spriteDispatcher.js` (`rowCells`, `execute`, new `executeRedraw`)
- Test: `backend/tests/sprite_dispatcher.test.js` (append; extend `fakeQueue` with `attachRedrawTask`, `recordRedrawSheet`; extend `fakeBox` with `redrawFrames`)

**Interfaces:**
- Consumes: Task 1 `attachRedrawTask`, `recordRedrawSheet`; Task 3 `box.redrawFrames`; existing `pollToDone`, `box.fetchSheet`, `box.fetchAtlas`, `buildBoxSheetManifest`, `queue.complete`.
- Produces: in `execute`, `if (row.redraw_of) return executeRedraw(provider, row, prefix, cur)` placed **before** the `row.box_job_id` resume block. `rowCells(row)` returns `row.redraw_frames.length` for redraw rows.

`executeRedraw` order: (1) no `box_job_id` → throw the spec's "no longer has this sheet's job" message; (2) `taskId = row.box_task_id` or `must(await box.redrawFrames(...)).taskId` then `queue.attachRedrawTask`; (3) `pollToDone(provider, taskId, redraw_frames.length * cellTimeoutMs, { measure: false, onPoll })` with `cur.message` defaulting to `Redrawing N frames`; a `missing` status maps to the spec's message; (4) fetch sheet+atlas of `row.box_job_id`, build manifest, copy the concept object from `row.concept_key` to `${prefix}concept.png`, put `sheet.png`, `sheet.json`; (5) `queue.complete` with `concept_key: ${prefix}concept.png`, `sheet_seconds: null`. On any non-halt error after step 2: best-effort fetch + build + store the box's current sheet under the prefix and `queue.recordRedrawSheet`, log a failure of that capture, then rethrow the original error.

- [ ] **Step 1: Failing tests:**
  - `redraw row calls redrawFrames with the marked frames and stores under its own prefix` — asserts `redrawFrames` args, `attachRedrawTask` logged with the task id, puts at `sprites/<creature>/<row id>/{concept.png,sheet.png,sheet.json}`, complete with `sheet_seconds: null`, `createSheetJob`/`generateConcept` never called.
  - `redraw row never takes the resume-a-done-sheet path` — `getSheetJob` for `box_job_id` says `done`; still `redrawFrames` is called.
  - `redraw row with box_task_id resumes polling and does not resubmit` (Review Focus 2).
  - `redraw with no box_job_id fails with the queue-again message`; `redraw task missing on the box fails with the same message`.
  - `failed redraw stores the box's current sheet and rethrows` — `recordRedrawSheet` logged with the keys, row failed with the box's error words.
  - `halt mid-redraw cancels the task id and requeues the row`.
  - `progress counts a redraw row as its marked frames`.
- [ ] **Step 2: Run** `node --test tests/sprite_dispatcher.test.js` → new tests FAIL, old PASS.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → all PASS.
- [ ] **Step 5: Commit** `feat(sprites): dispatcher runs frame redraws on the GPU box`.

### Task 5: Redraw API and subjects payload

**Files:**
- Modify: `backend/src/api/spriteBatchRoutes.js` (new `POST /jobs/redraw`, `DELETE /jobs/:id/redraw`; subjects queries)
- Test: `backend/tests/sprite_redraw_api.test.js` (new, `routerApp` + fake pool style of `sprite_batch_api.test.js`), `backend/tests/sprite_batch_approve_api.test.js` (append), `backend/tests/sprite_batch_subjects_db.test.js` (append)

**Interfaces:**
- Consumes: Task 1 `createRedraw`, `discardRedraw`; `deps.store.getObjectStream` + `readJson` for the source manifest; `dispatcher.status()/start()`.
- Produces:
  - `POST /api/sprite-admin/jobs/redraw` body `{ job_id: uuid, frames: [{action, direction, frame}] }` → `201 { id, started: boolean }`. Errors: `400` malformed body / western direction / unknown frame / duplicate / empty / more than the sheet's cells (message names the first bad entry as `action/direction/frame`); `404` unknown job; `409` source not a GPU-box creature sheet in `done`/`approved` (or a `failed` redraw with `atlas_key`), not the newest row with a sheet for its subject, or a live job exists. Frames are sorted into manifest order (manifest `rows` order, then frame) before `createRedraw`. After insert, if `!dispatcher.status()?.running`, `dispatcher.start()` (catch + log) and `started: true`.
  - `DELETE /api/sprite-admin/jobs/:id/redraw` → `200 { deleted: true }` / `404` / `409 { error: 'a redraw the box already worked on cannot be discarded' }`.
  - Each subject (both entity and appearance branches) gains `redraw_of`, `redraw_frames`, `box_task_id`, and `sheet_job_id`, `sheet_atlas_key`, `sheet_manifest_key`, `sheet_updated_at` from a second LATERAL: newest `sprite_sets` row for the same subject with `atlas_key IS NOT NULL`.

- [ ] **Step 1: Failing API tests** (`sprite_redraw_api.test.js`): happy path inserts sorted frames and starts the dispatcher; does not start when running; 400 for `w` / `nw` / `sw`; 400 for `frame: 6` on a 6-frame sheet, for an action not in the manifest, for a duplicate; 404 unknown id; 409 for a prop, a local-backend row, a `running` row; 409 when a newer row with a sheet exists (Review Focus 3); 409 when `createRedraw` returns null; DELETE maps the three `discardRedraw` results.
- [ ] **Step 2: Failing approve test:** `approving a done redraw row points the entity at the redraw's keys` (fake pool, generic gpu-box creature branch).
- [ ] **Step 3: Failing subjects DB test:** a subject whose latest row is a queued redraw returns `job_state 'queued'`, `redraw_of` set, and `sheet_*` from the source row.
- [ ] **Step 4: Run** the three files → FAIL.
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Run** → PASS; also run `tests/sprite_batch_api.test.js` (subjects fake pools may need the new columns).
- [ ] **Step 7: Commit** `feat(sprites): API to queue and discard frame redraws`.

### Task 6: Frontend pure helpers

**Files:**
- Create: `frontend/src/games/something2/frameRedraw.js`
- Modify: `frontend/src/games/something2/spriteSelection.js` (`sheetImageOf`, new `sheetManifestOf`, new `jobStateLabel`)
- Test: `frontend/src/games/something2/__tests__/frameRedraw.test.js`, `__tests__/spriteSelection.test.js` (append)

**Interfaces:**
- Produces (all pure):
  - `DIRECTION_ORDER = ['s','se','e','ne','n']`, `WESTERN = ['w','nw','sw']`, `DOUBLED = ['e','ne','se']`.
  - `frameKey(action, direction, frame) -> 'action/direction/frame'`; `parseFrameKey(key) -> {action, direction, frame}`.
  - `isMarkable(direction) -> boolean`.
  - `toggleMark(marks: Set<string>, key) -> Set<string>` (new set); `markRow(marks, action, direction, frames, on) -> Set<string>`.
  - `contextFrames(frames: number, marked: number[]) -> number[]` — unmarked neighbours of marked frames, sorted.
  - `rowSummary(frames: number, marked: number[]) -> { text, tone: 'normal'|'warning' } | null` — the exact spec formats from Global Constraints; adjacent marked runs and multiple runs join with `, `; edge-only cases use the `row start`/`row end` forms; all marked → warning text.
  - `redrawPayload(marks: Set<string>, manifest) -> Array<{action,direction,frame}>` in manifest row order.
  - `qualityByFrame(manifest) -> Map<key, entry>` for `passed === false` entries only.
  - `changedUnmarked(prev: {data,width}, next: {data,width}, manifest, redrawFrames) -> string[]` — keys of cells whose RGBA bytes differ and that are not in `redrawFrames`.
  - `shouldConfirmClose(marks: Set<string>) -> boolean`.
  - `sheetImageOf(subject)` = `subject.atlas_key || subject.sheet_atlas_key || subject.image_key || subject.sprite?.atlas_key || null`; `sheetManifestOf(subject)` = `subject.manifest_key || subject.sheet_manifest_key || null`.
  - `jobStateLabel(subject) -> string`: for `redraw_of` rows, `queued → 'redraw queued'`, `running → 'redrawing'`, `done → 'ready for review'`, `failed → 'redraw failed'`; otherwise `job_state || 'not queued'`.

- [ ] **Step 1: Failing tests:** `rowSummary(6,[2,3])` → `"f2, f3 redrawn in order · context: f1, f4"`; `rowSummary(6,[0])` → `"f0 · context: f1 only (row start)"`; `rowSummary(6,[5])` → `"f5 · context: f4 only (row end)"`; `rowSummary(6,[0,1,2,3,4,5])` → warning `"whole row · no neighbour context, drawn fresh from the concept"`; `rowSummary(6,[])` → null; `rowSummary(6,[1,4])` → `"f1, f4 redrawn in order · context: f0, f2, f3, f5"`; `contextFrames(6,[2,3])` → `[1,4]`; `isMarkable('nw')` false; `redrawPayload` orders by manifest rows; `qualityByFrame` drops passed entries; `changedUnmarked` on two 2-cell RGBA buffers returns only the unmarked changed key; `jobStateLabel` four redraw states + a plain row; `sheetImageOf` prefers `atlas_key`, then `sheet_atlas_key`.
- [ ] **Step 2: Run** `cd frontend && npx vitest run src/games/something2/__tests__/frameRedraw.test.js src/games/something2/__tests__/spriteSelection.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sprites): pure helpers for marking frames to redraw`.

### Task 7: Frame grid marking UI

**Files:**
- Create: `frontend/src/games/something2/SpriteFrameGrid.jsx`
- Modify: `frontend/src/games/something2/SpritePreviewModal.jsx`, `useSpriteConsole.js` (`useRedrawFrames`, `useDiscardRedraw`), `SpriteConsoleAdmin.jsx` (status pill uses `jobStateLabel`)
- Test: `frontend/src/games/something2/__tests__/spriteFrameGrid.render.test.js`, `__tests__/spritePreviewModal.render.test.js` (append)

**Interfaces:**
- Consumes: Task 6 helpers; Task 5 endpoints; `estimateLabel`, `useActionCatalog().catalog.seconds_per_cell`.
- Produces:
  - `useRedrawFrames()` mutation: `({ jobId, frames }) → POST /jobs/redraw` body `{ job_id, frames }`; toast `"N frames queued for redraw"`; invalidates like the other mutations.
  - `useDiscardRedraw()` mutation: `(id) → DELETE /jobs/:id/redraw`. (Add a `method` option to the file's `mutation` factory or write it inline; do not duplicate `jsonRequest`.)
  - `<SpriteFrameGrid sheetUrl manifest initialMarks?: Set<string> onSend(frames) onMarksChange?(marks) secondsPerCell sending />` — action tabs with marked/flagged counts; rows in `DIRECTION_ORDER` with `×2 in game` on `DOUBLED`; collapsed western group, frames there are rendered disabled; each frame is a `<button aria-pressed>` with a CSS-cropped ×2 background (`background-size` = sheet size ×2, `background-position` = −rect×2) on the checkerboard; marked = danger outline, context = dashed outline; `Mark row` / `Clear row`; `rowSummary` line per row; flag badge with `title` listing `failed_checks` and `attempts` (plus "row redrawn" when `row_redrawn`); `Mark flagged (N)` per tab and for the sheet, hidden when there is no quality; footer `N frames marked · <estimate>` and `Redraw N frames` button.
  - Modal: for `backend === 'gpu-box' && generation_kind === 'creature'` with `sheetManifestOf(subject)` and state `done`, `approved`, or a failed redraw, render the grid instead of the single sheet image; failed redraw shows a danger banner with `last_error`, pre-fills marks from `redraw_frames`, and offers `Retry redraw` (sends to `sheet_job_id`) and, when discardable (`!box_task_id || !atlas_key`), `Discard redraw`. Queued/running redraw shows the newest sheet read-only with a status line. Closing with `shouldConfirmClose(marks)` asks `window.confirm('Discard N unsent frame marks?')`.

- [ ] **Step 1: Failing render tests:** given a 2-action manifest and `initialMarks` `{attack/e/2, attack/e/3}`: the attack tab shows count 2; the `attack · e` row contains `"f2, f3 redrawn in order · context: f1, f4"`; two `aria-pressed="true"` buttons; the western group heading text is present and its buttons are `disabled`; `×2 in game` appears on `e`; button reads `Redraw 2 frames`; no `Mark flagged` without quality, present with one failed quality entry. Modal: a failed redraw subject renders the banner, `Retry redraw`, and `Discard redraw` only when discardable; a prop still renders the old prop view.
- [ ] **Step 2: Run** the two render test files → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS, plus the whole `frontend` vitest suite.
- [ ] **Step 5: Commit** `feat(sprites): mark frames for redraw in the sprite preview`.

### Task 8: Compare with previous

**Files:**
- Modify: `frontend/src/games/something2/SpriteFrameGrid.jsx` (compare mode), `SpritePreviewModal.jsx`
- Modify: `backend/src/api/spriteBatchRoutes.js` subjects: add `redraw_source_atlas_key` (the `atlas_key` of the `redraw_of` row) for redraw rows
- Test: `__tests__/spriteFrameGrid.render.test.js` (append), `backend/tests/sprite_batch_subjects_db.test.js` (append)

**Interfaces:**
- Consumes: Task 6 `changedUnmarked`; Task 5 subjects.
- Produces: `<SpriteFrameGrid … compare={{ previousUrl, redrawFrames, changedUnmarked: string[] }} />`. With compare on, rows that contain redrawn frames show the previous strip above the new one, redrawn frames highlighted, neighbours visible; cells in `changedUnmarked` carry a `"changed, not marked"` badge and the tab counts them. The modal, for a `done` redraw row, shows the `Compare with previous` toggle, opens on the first action with redrawn frames, loads both PNGs into off-screen canvases (`getImageData`) once compare is on and passes `changedUnmarked`. A load failure shows a muted line and leaves the warning out.

- [ ] **Step 1: Failing tests:** render with compare props shows both strips for `attack · e` only, and one `changed, not marked` badge for the listed key; subjects DB test returns `redraw_source_atlas_key`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sprites): compare redrawn frames with the previous sheet`.

### Task 9: End-to-end check in a browser with a stub box

**Files:**
- Create: `backend/scripts/stub-box-redraw.js` (throwaway dev stub, documented at the top as such; not wired into production code)

**Interfaces:**
- Consumes: everything above.
- Produces: a stub HTTP server that answers `/api/jobs/:id`, `/sheet`, `/atlas` from a stored real sheet + atlas (download them once from the real box for a done job, or use `backend/tests/fixtures/gpuBox/wolf-sheet.png` + `atlas-wolf.json`), and implements the **[ASSUMED]** redraw API by tinting the marked cells red and returning a `task_id` that goes `running` → `done` over ~5 s.

- [ ] **Step 1:** Run the stack per memory `dev-run-browser-verify` (admin login via `.env` `ADMIN_USERNAME`/`ADMIN_PASSWORD`), with the sprite provider pointed at the stub **in a scratch DB**, not the shared one.
- [ ] **Step 2:** Mark `attack · e` f2+f3 and `idle · s` f0; confirm the outlines and the three summary lines; confirm western frames are disabled.
- [ ] **Step 3:** Send; watch the batch bar count 3 cells; when done, open compare and confirm only those three cells are red and no `changed, not marked` badge appears.
- [ ] **Step 4:** Confirm the entity's sprite in game is unchanged before approve and tinted after approve.
- [ ] **Step 5:** Make the stub fail a redraw after accepting it; confirm the banner, the pre-filled marks, `Retry redraw`, and that `Discard redraw` is hidden.
- [ ] **Step 6:** Record screenshots and the result in the branch's final report; state plainly that the real box API was not exercised.
- [ ] **Step 7: Commit** the stub script `chore(sprites): stub box for redraw browser checks`.
