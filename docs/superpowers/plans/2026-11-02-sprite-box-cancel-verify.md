# Sprite Box-Cancel Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every GPU-box sheet job something2 cancels is tracked and verified. The Sprite tab shows whether the box really stopped; if it didn't, it shows "still drawing" with a Retry button. Start batch warns while the box is still busy with a cancelled job.

**Architecture:** One choke point, `boxCancels.request(db, provider, {...})`, replaces every direct `box.cancelSheetJob` call. It sends the DELETE and records a row in a new `sprite_box_cancels` table. `boxCancels.verify(db, provider, now)` polls `GET /api/jobs/{id}` for unconfirmed rows and moves them through the states `stopping` → `stopped` or `still_drawing`. `GET /api/sprite-admin/jobs` runs verify (throttled) and returns the open rows; the tab renders them.

**Tech Stack:** Node/Express CommonJS, raw pg, node-pg-migrate, `node --test`; React + styled-components, vitest (node env, no jsdom).

**Spec:** Plane SOMET-695 acceptance criteria (copied into Global Constraints). Box-side counterpart: SOMET-694.

## Global Constraints

- Settle window: a cancel is `stopped` when the box job's progress (its `updated_at`, or its `progress_msg` if `updated_at` is missing) hasn't changed for `SPRITE_CANCEL_SETTLE_MS` (default 180000) by our clock, or the box answers 404 / `missing`.
- `still_drawing` when we observe the box progress change more than `SPRITE_CANCEL_GRACE_MS` (default 60000) after `requested_at` (our clock; never compare box timestamps to our clock).
- States: `stopping` (just requested), `still_drawing`, `stopped`. `stopped` rows are kept (history) but are not returned as open.
- Copy (verbatim):
  - `Stopping on the GPU box… (<progress>)`
  - `The GPU box is still drawing a cancelled job (<subject>, <progress>) — it ignored the cancel`
  - button `Retry cancel`
  - Start-batch warning `The GPU box is still busy with a cancelled job (<subject>); new work waits behind it.`
- Migration timestamp `1714440860000` (latest on main is 1714440859000); re-check against origin/main before committing.
- DB tests: TEST_DATABASE_URL and DATABASE_URL = postgres://user:password@localhost:15432/game_db_boxcancel (never game_db), `--test-concurrency=1`, run twice.
- Commit subjects end `(SOMET-695)`, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Clear queue today never cancels box jobs** (spriteBatchRoutes.js `/jobs/clear` only DELETEs rows). A cleared row with a live `box_job_id` must now be cancelled through `boxCancels.request`. Test in Task 1.
2. **A box that is down during verify:** a failed GET leaves the row unchanged (not `stopped`), never throws out of GET /jobs. Test in Task 1.
3. **Cancelling the same box job twice** (halt then clear): one open row per box job, and the second request refreshes `requested_at`. Test in Task 1.
4. **A cancelled job that the box never picked up** (status queued, no progress change): becomes `stopped` after the settle window, not `still_drawing`. Test in Task 1.
5. **The UI with no open cancels** renders nothing extra, and Start batch has no warning. Test in Task 2.

---

### Task 1: Backend: track, verify, report, retry

**Files:**
- Create: `backend/migrations/1714440860000_sprite_box_cancels.js`
- Create: `backend/src/services/spriteBoxCancels.js`
- Modify: `backend/src/services/gpuBoxSprites.js` (`getSheetJob` also returns `job.updatedAt` from the box's `updated_at`)
- Modify: `backend/src/api/spriteBatchRoutes.js` (`cancelBoxJobs` → `boxCancels.request`; `/jobs/clear` cancels the cleared rows' box jobs; `GET /jobs` adds `box_cancels`; new `POST /jobs/box-cancels/:id/retry`; `/jobs/dispatch` response adds `box_cancels`)
- Modify: `backend/src/services/spriteDispatcher.js` (the four `box.cancelSheetJob` call sites at ~186, 245, 442, 498 go through `boxCancels.request`, keeping their current return handling)
- Test: `backend/tests/sprite_box_cancels_db.test.js` (new), plus `sprite_batch_api.test.js` / `sprite_dispatcher.test.js` updates where those stub `cancelSheetJob`.

**Interfaces (produces):**
- Table `sprite_box_cancels(id bigserial pk, box_job_id text not null, sprite_set_id uuid null, subject text null, source text not null, state text not null default 'stopping' check in ('stopping','still_drawing','stopped'), requested_at timestamptz not null default now(), last_progress text null, last_box_updated_at text null, last_change_at timestamptz null, checked_at timestamptz null, stopped_at timestamptz null)`, plus a partial unique index on `box_job_id` WHERE state <> 'stopped'.
- `request(db, provider, { boxJobId, spriteSetId, subject, source }, { box = gpuBoxSprites, now = Date.now } = {}) -> { ok, error? }`: calls `box.cancelSheetJob(provider, boxJobId)` and upserts the open row (resetting `requested_at`, state `stopping`). It records the row even when the DELETE fails, with `last_progress` set to the error. `source` is one of `halt|clear|delete-generated|options-changed|turnaround|redraw|retry`.
- `verify(db, provider, { box, now, settleMs, graceMs }) -> rows[]`: for each open row it calls `box.getSheetJob`. On `missing` → `stopped`. If the progress signature (`updatedAt || progress.message`) changed: set `last_change_at = now`, and `still_drawing` if `now - requested_at > graceMs`. If unchanged since `last_change_at` (or since `requested_at` when null) for at least `settleMs` → `stopped`. A failed GET → row untouched. Returns the open rows.
- `open(db) -> rows[]` (state <> 'stopped', newest first).
- `GET /jobs` adds `box_cancels: [{id, box_job_id, subject, source, state, requested_at, last_progress}]`. verify runs at most every `SPRITE_CANCEL_VERIFY_MS` (default 15000) per process.
- `POST /jobs/box-cancels/:id/retry` → `request(..., source 'retry')` → 200 `{ box_cancel }`; 404 for an unknown or stopped id.

- [ ] **Step 1: Write failing DB tests** in `sprite_box_cancels_db.test.js` with a stub box (an object with `cancelSheetJob` and `getSheetJob` returning scripted answers) and an injected `now`:
  - request inserts `stopping`, and a second request for the same box job keeps one open row with a newer `requested_at` (Review Focus 3);
  - a box job whose progress keeps changing 61 s after the request → `still_drawing`;
  - progress unchanged for 180 s → `stopped`, and `open()` no longer returns it;
  - a never-started job (`queued`, same message every poll) → `stopped` after 180 s, never `still_drawing` (Review Focus 4);
  - `missing` → `stopped`;
  - a failing GET leaves the row unchanged (Review Focus 2);
  - a failing DELETE still records the row, with the error in `last_progress`.
- [ ] **Step 2: Write failing route tests** (that file's style):
  - `/jobs/clear` with a cleared row carrying `box_job_id 'bj-9'` calls the box cancel for `bj-9` (Review Focus 1);
  - `GET /jobs` includes `box_cancels`;
  - retry → 200, unknown id → 404.
- [ ] **Step 3: Run both and see them fail;** then implement the migration, service, `getSheetJob` updatedAt, routes and dispatcher call sites.
- [ ] **Step 4: Run the new tests plus every `sprite*` / `gpu_box*` backend test twice.** Exit 0 both times.
- [ ] **Step 5: Commit** `feat(sprites): track and verify GPU-box cancels (SOMET-695)`.

### Task 2: The batch card: stopping / still drawing / retry / start warning

**Files:**
- Modify: `frontend/src/games/something2/spriteSelection.js` (pure helpers)
- Modify: `frontend/src/games/something2/useSpriteConsole.js` (`useRetryBoxCancel` mutation → `POST /jobs/box-cancels/:id/retry`)
- Modify: `frontend/src/games/something2/SpriteConsoleAdmin.jsx` (render in the batch card; Start batch warning)
- Test: `frontend/src/games/something2/__tests__/spriteSelection.test.js`, a render-to-string test for the new block.

**Interfaces (consumes Task 1):** the `box_cancels` array on the `/jobs` response.

- [ ] **Step 1: Write failing unit tests:**
  - `boxCancelLines(boxCancels)` → `[{ id, text, retry }]`, where a `stopping` row gives `Stopping on the GPU box… (cell 171/205)` with `retry: false`, and a `still_drawing` row gives `The GPU box is still drawing a cancelled job (Warrior:2, cell 176/205) — it ignored the cancel` with `retry: true`; a null `last_progress` falls back to `no progress reported`;
  - `startBatchWarning(boxCancels)` → the verbatim warning for the first open row, or `null` for none (Review Focus 5).
- [ ] **Step 2: Implement the helpers, the mutation, and the render.** In the batch card, one line per row, with a `Retry cancel` button on `retry: true` lines calling the mutation. Show the Start-batch warning as a Hint next to the Start batch button whenever it isn't null. A render-to-string test asserts the two lines and the button text for a mixed array, and asserts no extra block for an empty array.
- [ ] **Step 3: Run `cd frontend && npx vitest run src/games/something2`.** All pass.
- [ ] **Step 4: Commit** `feat(sprites): show whether the GPU box really stopped a cancelled job (SOMET-695)`.
