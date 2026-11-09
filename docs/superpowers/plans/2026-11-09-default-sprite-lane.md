# Default Creature Sprite Lane + Predictable ETA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Fits card, fast" with all actions, 96x128 cells and box quality checks OFF the Sprite tab's default (about 49 min per humanoid). Every generation method shows a time estimate built from the box's measured model, and finished rows show "took X (est. Y)".

**Architecture:**
- One pure ETA module (`backend/src/services/spriteEta.js`) implements the box formula. A byte-for-byte ESM mirror in the frontend is held to it by a parity test.
- The backend owns the constants and the per-lane calibrated seconds-per-cell, and sends them in `/api/sprite-admin/action-catalog`.
- `sprite_sets` gains `quality_checks` and `predicted_seconds`. The dispatcher sends `quality_checks` in the box JobSpec.
- The queue-ahead (wait time on the box) is a separate read-only route.

**Tech Stack:** Node/Express (CommonJS, raw `pg`, node-pg-migrate), `node --test`; React + vitest (node env); GPU box FastAPI at the sprite connector's base URL.

**Spec:** `docs/superpowers/specs/2026-11-09-default-sprite-lane-design.md` (approved 2026-11-09).

## Global Constraints

- **Workspace:** work in your own git worktree (`superpowers:using-git-worktrees`). Never `checkout`/`stash`/`branch` in the shared checkout at the repo root; other sessions use it.
- **Database tests** run against a PRIVATE database. `TEST_DATABASE_URL` unset means the SHARED dev DB, so set it to a scratch DB. Never run destructive SQL on the shared dev DB.
- **No GPU traffic to the box** (`/api/jobs` POST, `/sdapi`, `/api/text`) while the box reports a hold or a running spike. Read-only GETs (`/api/jobs`, `/api/model-gateway`) are fine. Only Task 6 sends a job.
- **Migrations:** before creating one, `ls backend/migrations | sort -n | tail -3` on the CURRENT origin/main and take the next free `17144408xx000` number. Re-check right before merge (recurring collision pattern).
- **ETA constants (spec §5, verbatim):**
  - box seconds = `85 + c·D + 0.6·N + c·N + X`. The fixed parts are 15+25+15+25+5 = 85.
  - `c` = 32 s at 4 steps, 60 s at 8 steps, else `7.7·steps + 1.3`; Q6_K presets use their `secondsPerCell` in `spriteSampling.js`.
  - `X` = 0 when QA is off. When QA is on it is a range: low r=0 with 0 rounds; typical r=0.3 with 1 round; high r=1.45 with 3 rounds; 40 s per round.
  - `G` = up to 300 s.
- **Facings:** N counts RENDERED facings only, i.e. requested minus `w`, `nw`, `sw` (the box mirrors them). D counts all REQUESTED facings.
- **Default lane:** sampling NULL (`fits_fast`), sheet_method `2d`, cell `96x128`, `quality_checks:false`, 4 frames, actions `idle, walk, attack, cast, damage, death, use`, intersected with the box catalog. Quadrupeds lose cast/use via the existing `actionsForBody`.
- **Legacy rows:** a NULL `sprite_sets.cell` still means 48x64 and a NULL `quality_checks` still means "box default (on)". Don't change `DEFAULT_SPRITE_CELL` in `spriteBatchOptions.js` or `rowCellSize` in `spriteDispatcher.js`. The new default lives only in what new queues send.
- **HQ rows** (`comfyui-hq` engine) are unchanged: they never send `quality_checks`.
- **Commit message attribution line:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A re-queue in place that changes only QA** (on→off) must detach the old box job. If it doesn't, the admin gets a sheet drawn with the other setting. Test: Task 3.
2. **Legacy NULL `quality_checks` rows**, e.g. the 21 stale queued rows on dev, must send NO `quality_checks` field. Sending `false` would silently change them. Test: Task 4.
3. **A selection mixing humanoids and quadrupeds**, or with west facings ticked: the estimate must use rendered facings and per-body action counts. It must not show the same N for every row. Test: Task 1 (rendered facings) and Task 5 (per-row actions).
4. **Calibration poisoned by atypical rows**: incremental re-runs (`sheet_seconds` NULL), redraw rows, QA-on rows and legacy NULL-QA rows must not feed the calibrated `c`. Test: Task 3.
5. **Box unreachable or returning odd job specs** for the queue-ahead route: it must degrade to "wait unknown" and never 500 the Sprite tab or block queuing. Test: Task 7.

---

### Task 1: ETA module (backend, pure)

**Files:**
- Create: `backend/src/services/spriteEta.js`
- Test: `backend/tests/sprite_eta.test.js`

**Interfaces:**
- Produces:
  - `ETA_MODEL`: frozen `{ fixedSeconds: 85, perCellOverhead: 0.6, roundSeconds: 40, r: { low: 0, typical: 0.3, high: 1.45 }, rounds: { low: 0, typical: 1, high: 3 }, gatewaySwitchMaxSeconds: 300 }`.
  - `secondsPerCellFor({ steps, sampling, engine })` returns a number:
    - a preset (`sampling` non-null) → `SAMPLING_PRESETS[sampling].secondsPerCell` (`hqSecondsPerCell` on `comfyui-hq`);
    - otherwise 4→32, 8→60, else `7.7*steps+1.3`;
    - steps defaults to 4.
  - `renderedFacings(directions: string[]) → number` (excludes w/nw/sw).
  - `boxSeconds({ actions, directions, frames, secondsPerCell, qualityChecks, measuredRedrawSeconds? }) → { low, typical, high }`, in seconds, rounded:
    - QA off: all three are equal.
    - `measuredRedrawSeconds` given: X is fixed to it and all three are equal (used for replay).
  - `cellsOf({ actions, directions, frames }) → number` = actions.length × renderedFacings × frames.
  - `calibrateSecondsPerCell({ sheetSeconds, cells, requestedFacings }) → number` = `(sheetSeconds − 85 − 0.6·cells) / (cells + requestedFacings)`. This inverts the formula with X=0.

- [ ] **Step 1: Write the failing tests**

```js
// backend/tests/sprite_eta.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const eta = require('../src/services/spriteEta.js');
const near = (got, want, pct) => assert.ok(Math.abs(got - want) / want <= pct, `${got} vs ${want}`);

test('replays box job 3990224b (1 action x 8 dirs x 6 frames, 4 steps, QA on, redraw 988 s) within 2% of the 2,322 s actual', () => {
  const dirs = ['s','se','e','ne','n','nw','w','sw'];
  const r = eta.boxSeconds({ actions: ['walk'], directions: dirs, frames: 6, secondsPerCell: 32, qualityChecks: true, measuredRedrawSeconds: 988 });
  near(r.typical, 2322, 0.02);
});
test('replays box job 98045cb9 (7 x 3 dirs x 4 frames, 8 steps, redraw 7,751 s) within 2% of the 13,254 s actual', () => {
  const r = eta.boxSeconds({ actions: ['idle','walk','attack','cast','damage','death','use'], directions: ['s','e','n'], frames: 4, secondsPerCell: 60, qualityChecks: true, measuredRedrawSeconds: 7751 });
  near(r.typical, 13254, 0.02);
});
test('default lane humanoid (7 actions, s/e/n, 4 frames, 4 steps, QA off) is ~49 min and a single number', () => {
  const r = eta.boxSeconds({ actions: Array(7).fill('a'), directions: ['s','e','n'], frames: 4, secondsPerCell: 32, qualityChecks: false });
  assert.equal(r.low, r.high);
  near(r.typical, 2950, 0.03);
});
test('QA on gives a range: low has no redraw, high > typical > low', () => {
  const r = eta.boxSeconds({ actions: Array(7).fill('a'), directions: ['s','e','n'], frames: 4, secondsPerCell: 32, qualityChecks: true });
  assert.ok(r.low < r.typical && r.typical < r.high);
});
test('west facings are mirrored: N ignores w/nw/sw, D does not', () => {
  assert.equal(eta.cellsOf({ actions: ['idle'], directions: ['s','e','n','w'], frames: 4 }), 12);
  assert.ok(eta.boxSeconds({ actions: ['idle'], directions: ['s','e','n','w'], frames: 4, secondsPerCell: 32, qualityChecks: false }).typical
    > eta.boxSeconds({ actions: ['idle'], directions: ['s','e','n'], frames: 4, secondsPerCell: 32, qualityChecks: false }).typical);
});
test('seconds per cell: 4 steps 32, 8 steps 60, 6 steps by the linear rule, presets their own rate', () => {
  assert.equal(eta.secondsPerCellFor({ steps: 4 }), 32);
  assert.equal(eta.secondsPerCellFor({ steps: 8 }), 60);
  near(eta.secondsPerCellFor({ steps: 6 }), 47.5, 0.001);
  assert.equal(eta.secondsPerCellFor({ sampling: 'sharp' }), 145);
  assert.equal(eta.secondsPerCellFor({ sampling: 'sharp', engine: 'comfyui-hq' }), 118);
});
test('calibration inverts a QA-off sheet back to its seconds per cell', () => {
  const t = eta.boxSeconds({ actions: Array(7).fill('a'), directions: ['s','e','n'], frames: 4, secondsPerCell: 30, qualityChecks: false }).typical;
  near(eta.calibrateSecondsPerCell({ sheetSeconds: t, cells: 84, requestedFacings: 3 }), 30, 0.01);
});
```

- [ ] **Step 2: Run and see it fail.** `cd backend && node --test tests/sprite_eta.test.js`. Expected: FAIL with "Cannot find module '../src/services/spriteEta.js'".
- [ ] **Step 3: Implement `spriteEta.js`** with the interfaces above. Require `SAMPLING_PRESETS` from `./spriteSampling.js`. No I/O.
- [ ] **Step 4: Run and see it pass.** Same command. Expected: 7 passing.
- [ ] **Step 5: Commit.** `git add backend/src/services/spriteEta.js backend/tests/sprite_eta.test.js && git commit -m "feat(sprites): box ETA model from the 2026-11-09 measurements"`

---

### Task 2: Frontend ETA mirror + parity

**Files:**
- Create: `frontend/src/games/something2/spriteEta.js`. It is ESM and mirrors only `boxSeconds`, `cellsOf` and `renderedFacings`. The frontend never derives seconds-per-cell itself; it uses the catalog's `eta_seconds_per_cell` from Task 4. `boxSeconds` takes the model constants as an optional `model` argument defaulting to the same values as `ETA_MODEL`, and the catalog's `eta_model` is passed in.
- Test: `backend/tests/sprite_eta_parity.test.js`

**Interfaces:**
- Consumes: Task 1's module.
- Produces, frontend:
  - `boxSeconds`, `cellsOf`, `renderedFacings` with identical signatures;
  - `etaLabel({ low, typical, high }) → string`: `"~49 min"` when equal, else `"~1 h 5 min – 1 h 58 min"`, reusing the `durationLabel` style in `spriteSelection.js`. Move `durationLabel` here and re-export it from `spriteSelection.js`.

- [ ] **Step 1: Write the failing parity test.** It loads the ESM file with `await import(pathToFileURL(...))` and, for a fixture table, asserts both modules return deep-equal `boxSeconds` and `cellsOf`. The table:
  - the three Task 1 specs;
  - one with `['s','e','n','w','nw','sw']`;
  - one with QA on and no measured redraw;
  - frames 1.
- [ ] **Step 2: Run** `cd backend && node --test tests/sprite_eta_parity.test.js`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement the mirror.**
- [ ] **Step 4: Run again.** Expected: PASS. Also run `cd frontend && npx vitest run src/games/something2/__tests__/spriteSelection.test.js`, which must still pass after the `durationLabel` move.
- [ ] **Step 5: Commit.** `git commit -m "feat(sprites): frontend ETA mirror held to the backend by a parity test"`

---

### Task 3: Schema + queue (QA choice, prediction, calibration)

**Files:**
- Create: `backend/migrations/<next>_sprite_sets_qa_eta.js`
- Modify: `backend/src/services/spriteJobQueue.js`, specifically:
  - `DEFAULT_ACTIONS` (line ~20);
  - `enqueue` (UPDATE ~118-140 and the INSERT after it);
  - replace `lastSecondsPerCell` (~510);
  - add `setPredicted`, `calibratedSecondsPerCell`;
  - `module.exports`.
- Test: `backend/tests/sprite_queue_qa_eta_db.test.js` (private DB)

**Interfaces:**
- Migration:
  - `sprite_sets.quality_checks boolean NULL` (NULL = legacy box default);
  - `sprite_sets.predicted_seconds integer NULL CHECK (predicted_seconds IS NULL OR predicted_seconds > 0)`;
  - `down` drops both.
- `enqueue(db, opts, { ..., qualityChecks })`: the new option, a boolean (default `false`). It is stored per creature row. Props (`kind === 'object'`) and rows whose `providerId` is an HQ connector store NULL (the caller passes `hqProviderIds: Set<number>`).
- In the UPDATE's detach CASE, add `OR s.quality_checks IS DISTINCT FROM t.quality_checks`.
- `DEFAULT_ACTIONS.creature = ['idle','walk','attack','cast','damage','death','use']`.
- `setPredicted(db, rows: Array<{ id: number, seconds: number }>) → Promise<void>`: a single UPDATE from `unnest`.
- `calibratedSecondsPerCell(db, { sampling = null, providerId = null }) → Promise<number|null>`:
  - computes the median of `calibrateSecondsPerCell` over the last 10 rows where `status IN ('done','approved')`, `sheet_seconds > 0`, `quality_checks = false`, `redraw_of IS NULL`, the same sampling (`IS NOT DISTINCT FROM`) and the same provider when one is given;
  - returns null with fewer than 3 rows;
  - N uses rendered facings: exclude `'w','nw','sw'` in SQL, or compute in JS from the fetched arrays.
- `lastSecondsPerCell` is removed; all callers move to `calibratedSecondsPerCell` (Task 4).

- [ ] **Step 1: Write the failing DB tests.** Seed through the module's own functions on a private DB:
  - `enqueue with qualityChecks false stores false on creature rows, NULL on props`;
  - `re-queue of a queued row changing only qualityChecks detaches its box_job_id and returns it as dropped_box_job_id`;
  - `re-queue with the same qualityChecks keeps box_job_id`;
  - `calibratedSecondsPerCell ignores QA-on, NULL-QA, redraw and sheet_seconds-NULL rows and returns null under 3 samples`: seed 2 QA-off rows plus one of each excluded kind, expect null; add a 3rd QA-off row, expect its median;
  - `setPredicted writes predicted_seconds by id`;
  - `default creature actions are the seven` (enqueue with no actions, assert the stored `actions`).
- [ ] **Step 2: Run them and see them fail.** `cd backend && TEST_DATABASE_URL=<private> node --test tests/sprite_queue_qa_eta_db.test.js`. Expected: FAIL, no column `quality_checks`.
- [ ] **Step 3: Write the migration, then implement the queue changes.**
- [ ] **Step 4: Run them again.** Expected: PASS. Also run the existing `sprite_reuse_base_db`, `sprite_force_api_db` and `sprite_batch_api` tests against the private DB; they must stay green.
- [ ] **Step 5: Commit.** `git commit -m "feat(sprites): sprite_sets records the QA choice and predicted time; calibrated seconds per cell"`

---

### Task 4: Dispatcher + routes send QA and estimates

**Files:**
- Modify:
  - `backend/src/services/spriteDispatcher.js`: `sheetSpec` (~483); the run estimate (~939, ~976-980, ~1083-1094) moves from `lastSecondsPerCell` to `calibratedSecondsPerCell` and falls back to `secondsPerCellFor`.
  - `backend/src/api/spriteBatchRoutes.js`: `/action-catalog` (161), `/connectors` (184), `POST /jobs` (507 and its option parsing ~430-470). Remove `SEED_SECONDS_PER_CELL` / `HQ_SEED_SECONDS_PER_CELL`.
- Test:
  - `backend/tests/sprite_dispatcher.test.js` (add cases; the `fakeBox.createSheetJob(provider, spec)` capture at line ~94 is the seam);
  - `backend/tests/gpu_box_sprites.test.js` (one body-capture case);
  - `backend/tests/sprite_batch_api.test.js`.

**Interfaces:**
- Consumes: Task 1 (`secondsPerCellFor`, `boxSeconds`, `ETA_MODEL`) and Task 3 (`calibratedSecondsPerCell`, `setPredicted`, enqueue `qualityChecks`).
- `sheetSpec`: on the diffusers engine, a row with `quality_checks` true or false adds `quality_checks: row.quality_checks`. A NULL row or the HQ engine adds nothing.
- `POST /jobs` body gains optional `quality_checks: boolean`:
  - anything other than a boolean or undefined → 400 `quality_checks must be true or false`;
  - omitted → `false`.
  - After enqueue, it computes each returned creature row's `boxSeconds(...).typical`, using the row's `actions`, `directions`, `frames_per_action` and `quality_checks`, and `c` from `calibratedSecondsPerCell` with a `secondsPerCellFor` fallback. It writes them with `setPredicted`.
- `GET /action-catalog` response:
  - adds `eta_model: ETA_MODEL`;
  - each `generation_methods[i]` gains `eta_seconds_per_cell` (calibrated for that sampling on the active connector, else `secondsPerCellFor`);
  - the top-level `seconds_per_cell` becomes the `fits_fast` value.
- `GET /connectors`: `seconds_per_cell` from `calibratedSecondsPerCell` with a `secondsPerCellFor` fallback.
- `GET /subjects`: each row's sprite payload exposes `sheet_seconds` and `predicted_seconds`. Add them to that route's SELECT.

- [ ] **Step 1: Write the failing tests:**
  - `sheet spec carries quality_checks:false for a QA-off diffusers row` and `...true for a QA-on row`;
  - `sheet spec has no quality_checks key for a legacy NULL row`;
  - `sheet spec has no quality_checks key on comfyui-hq`;
  - `createSheetJob posts quality_checks in the JSON body` (gpu_box_sprites: capture `fetchImpl`'s body string);
  - `POST /jobs rejects quality_checks "no" with 400`;
  - `POST /jobs stores predicted_seconds ≈ 2950 for a default humanoid`;
  - `action-catalog returns eta_model and per-method eta_seconds_per_cell`.
- [ ] **Step 2: Run them and see them fail.** `cd backend && node --test tests/sprite_dispatcher.test.js tests/gpu_box_sprites.test.js tests/sprite_batch_api.test.js`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS. Then run `grep -rn "lastSecondsPerCell\|SEED_SECONDS_PER_CELL" backend/src`. Expected: no matches.
- [ ] **Step 5: Commit.** `git commit -m "feat(sprites): send quality_checks in the box JobSpec and serve calibrated estimates"`

---

### Task 5: Sprite tab defaults, QA toggle and ETA labels

**Files:**
- Modify:
  - `frontend/src/games/something2/spriteSelection.js`:
    - `DEFAULT_CELL` (206) becomes `'96x128'`, i.e. the 96x128 entry's id;
    - `defaultActionsFor` (590);
    - `samplingOptionLabel` / `presetSecondsPerCell` / `estimateLabel` (496-514) go through `spriteEta.js`;
    - `batchProgress` keeps its shape.
  - `frontend/src/games/something2/useSpriteConsole.js`: `queueJobsBody` (99) passes `quality_checks`.
  - `frontend/src/games/something2/SpriteConsoleAdmin.jsx`:
    - a QA checkbox next to the Generation method select, labelled `Auto-fix bad frames (slower, time varies)`, default unchecked;
    - the method option labels;
    - the queue confirmation total;
    - finished rows' "took X (est. Y)".
- Test:
  - `frontend/src/games/something2/__tests__/spriteSelection.test.js`;
  - `frontend/src/games/something2/__tests__/queueJobsBody.test.js`;
  - `frontend/src/games/something2/__tests__/spriteConsoleTable.render.test.js`.

**Interfaces:**
- Consumes:
  - Task 2's `boxSeconds`, `cellsOf`, `etaLabel`;
  - Task 4's catalog `eta_model`, `generation_methods[].eta_seconds_per_cell`, and the subjects' `sheet_seconds` and `predicted_seconds`.
- `defaultActionsFor(catalog, rows) → string[]` returns `['idle','walk','attack','cast','damage','death','use']` filtered to the catalog ids. With only props selected it stays `['idle']`.
- `methodOptionLabel(method, selection, etaModel, qualityChecks) → string`, e.g. `"Fits card, fast — ~49 min"`, summed over the selected rows. Each row uses its own action count: humanoid actions, or the quadruped list without cast/use when `row.body_plan === 'quadruped'`. With QA on the label is a range. It replaces `samplingOptionLabel` for the method select.
- `tookLabel({ sheet_seconds, predicted_seconds }) → string|null`: `"took 52 min (est. 49 min)"`; when only `sheet_seconds` is set, `"took 52 min"`; with no `sheet_seconds`, null.

- [ ] **Step 1: Write the failing tests:**
  - `default actions are the seven creature actions filtered to the catalog`;
  - `props-only selection keeps idle`;
  - `DEFAULT_CELL is 96x128`;
  - `queueJobsBody passes quality_checks`;
  - `method label for one default humanoid is "Fits card, fast — ~49 min"`;
  - `method label for one humanoid + one quadruped sums per-row cells (quadruped 5 actions)`;
  - `QA on shows a range`;
  - `tookLabel formats took/est and omits est when missing`;
  - render test: `a finished row shows "took … (est. …)"`.
- [ ] **Step 2: Run them and see them fail.** `cd frontend && npx vitest run src/games/something2/__tests__/spriteSelection.test.js src/games/something2/__tests__/queueJobsBody.test.js src/games/something2/__tests__/spriteConsoleTable.render.test.js`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS, and `npx vitest run src/games/something2` is fully green.
- [ ] **Step 5: Browser check.** Use muted headless Chrome (`--mute-audio`) on a free CDP port, and check `ss` first.
  - Open `/game/sprites` and select one humanoid. The default ticks 7 actions and cell 96x128, and the method option reads "~49 min".
  - Tick Auto-fix and check that it becomes a range.
  - Press Queue against a private stack, or intercept the request. The POST body has `quality_checks:false`, `cell:"96x128"` and the 7 actions.
  - Save a screenshot to the session scratchpad.
- [ ] **Step 6: Commit.** `git commit -m "feat(sprites): Sprite tab defaults to the fast full sheet and shows box ETAs"`

---

### Task 6: Live acceptance run (spec slice 2)

**Files:** none changed. Record the result in the PR/commit message and in the spec's §11 (one line).

- [ ] **Step 1: Check the box is free.** GET `/api/model-gateway`: no hold or pending entries. Ask the user to confirm that no box spike is running (box session).
- [ ] **Step 2: Queue one default-lane humanoid** (e.g. Warrior) on a PRIVATE DB, using the private live-box-leg harness: real dispatcher, real box, private postgres, in-memory store writes, and provider `{...p, id: null}`.
- [ ] **Step 3: Check it ran with QA off.** The box job's `spec.quality_checks` is `false` (GET `/api/jobs/{id}`) and its progress never entered a redraw stage.
- [ ] **Step 4: Check the timing.** `|sheet_seconds − predicted_seconds| / predicted_seconds ≤ 0.10`. If it misses, report the numbers and don't tune the constants to fit one run.
- [ ] **Step 5: Look at the sheet.** All 7 actions, rows s, e and n, 96x128 cells. In-game, w draws as e mirrored.

---

### Task 7: Queue-ahead and model switch in the estimate (spec slice 3)

**Files:**
- Modify:
  - `backend/src/services/gpuBoxSprites.js`: add `listActiveJobs(provider, { fetchImpl })` and `gatewayStatus(provider, { fetchImpl })`;
  - `backend/src/api/spriteBatchRoutes.js`: add `GET /box-queue`;
  - `frontend/src/games/something2/useSpriteConsole.js` and `SpriteConsoleAdmin.jsx`: show the wait in the queue confirmation.
- Test: `backend/tests/gpu_box_sprites.test.js`, `backend/tests/sprite_batch_api.test.js`, `frontend/src/games/something2/__tests__/spriteSelection.test.js`.

**Interfaces:**
- `listActiveJobs(provider) → { ok, jobs: Array<{ status, progressPct, spec }> }`: GET `/api/jobs`, keeping only `queued` and `running`.
- `gatewayStatus(provider) → { ok, activeModel: string|null, hold: object|null }`: GET `/api/model-gateway`. `hold` appears once the box's project-3 change lands; until then it is null.
- `GET /api/sprite-admin/box-queue → { ahead_seconds: number|null, switch_seconds_max: 0|300, hold: string|null }`:
  - each job's remaining time is `boxSeconds(spec).typical × (1 − progressPct/100)`, using the box spec's `actions`, `directions`, `frames`, `steps` and `quality_checks`; the box default is QA on;
  - `switch_seconds_max` is 300 when the active model is non-null and not `qwen-image-edit`;
  - when the box is unreachable, the answer is `ahead_seconds: null` with status 200;
  - the result is cached for 15 s.
- `waitLabel({ ahead_seconds, switch_seconds_max }) → string`: `"~1 h 10 min waiting on the box"`, plus `" · + up to 5 min model switch"` when it applies. Unknown → `"box queue unknown"`.

- [ ] **Step 1: Write the failing tests:**
  - `listActiveJobs keeps queued/running only`;
  - `box-queue sums remaining time with progress`;
  - `box-queue answers ahead_seconds null when the box is down (no 500)`;
  - `box-queue adds a 300 s switch only when another model is active`;
  - `waitLabel` formats each case.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement**, using a fake `fetchImpl` in the tests, never the real box.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Do one read-only live GET** of `/api/sprite-admin/box-queue` against the dev backend, and check that its number matches what the box Activity tab shows.
- [ ] **Step 6: Commit.** `git commit -m "feat(sprites): queue estimate includes the wait on the box and a model switch"`

---

### Task 8 (conditional): reference size (spec slice 4)

Start only when BOTH are true:
- the box spike report says a reference size wins;
- the box ships a JobSpec field for it, proposed as `ref_size`; check `/openapi.json` `JobSpec`.

Otherwise mark it dropped in the spec's §11 with the box's verdict.

- When it goes ahead:
  - `sheetSpec` sends the winning size for diffusers rows;
  - `secondsPerCellFor` gains `refSize`, with the box-measured per-cell rate (≈18.6 s at 512² 4 steps; use the spike's number);
  - the Task 1 tests gain one case per size;
  - repeat Task 6.
