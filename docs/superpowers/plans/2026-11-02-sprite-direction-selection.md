# Sprite Direction Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin choose, per batch, which of the 8 directions a sprite sheet is drawn in (checkboxes plus 2/4/8-way presets), and have the game draw chosen west and diagonal rows for real instead of mirroring them.

**Architecture:** The direction set travels from the tab → `POST /api/sprite-admin/jobs` → `sprite_sets.directions` (an existing column) → the box JobSpec (already sent). A new `sprite_sets.real_western` flag marks rows whose directions an admin chose explicitly. At sheet intake, `buildBoxSheetManifest` writes those western rows into `manifest.unmirrored[action]`. Creature and hero rendering both go through `RenderSystem.resolveSprite` → `sheetActions.pickRow`, which already draws `unmirrored` rows as they are. So there are no renderer changes, only tests that pin it.

**Tech Stack:** Node/Express (CommonJS), raw `pg`, node-pg-migrate, `node --test`; React + styled-components, vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-sprite-tab-directions-actions-force-design.md` (slice C; user's order: directions first).

## Global Constraints

- Direction ids, in compass order: `s, se, e, ne, n, nw, w, sw`. Western = `w, nw, sw`.
- Presets (user's decision): 2-way = `s, e`; 4-way = `s, e, n, w`; 8-way = all eight. Default stays `s, e, n`, shown as "custom (3)".
- Props (`kind 'object'`) always stay `['s']` and `real_western = false`, whatever was sent.
- Omitting `directions` from `POST /jobs` keeps today's behavior exactly: `s, e, n`, `real_western = false`.
- Manifests without `unmirrored` must render exactly as today.
- Migration timestamp: `1714440859000` (latest on main is `1714440858000_achievements.js`). Re-check `ls backend/migrations | sort | tail -2` against origin/main before committing; bump it if taken.
- DB tests need `TEST_DATABASE_URL` and `DATABASE_URL` set to a scratch DB. Never the shared `game_db`.
- Commit subject: `feat(sprites): … (SOMET-686)`, ending with the Co-Authored-By trailer.

## Review Focus

1. **Re-queue of a still-queued row with a different direction set**: the row takes the new directions, its stale box job is detached and cancelled, and `real_western` follows the new request. Test in Task 1.
2. **A mixed selection of props + creatures with 8-way chosen**: props stay `['s']` / `real_western=false`. Test in Task 1.
3. **Redraw of an old pre-SOMET-669 sheet whose `directions` list w/nw/sw** (`real_western = false`): the rebuilt manifest gets no `unmirrored` from directions, so the known-bad western rows stay mirrored. Test in Task 2.
4. **Directions sent unordered, duplicated, upper-case or unknown**: normalized to compass order without duplicates (case-insensitive), or 400 for unknown ids and an empty list. Test in Task 1.
5. **Empty direction selection in the tab**: the Queue button is disabled with a reason, never posts. Test in Task 3.

---

### Task 1: Backend: accept, validate and store directions

**Files:**
- Create: `backend/migrations/1714440859000_sprite_sets_real_western.js`
- Modify: `backend/src/services/spriteBatchOptions.js`
- Modify: `backend/src/services/spriteJobQueue.js` (`enqueue` options + INSERT/UPDATE; `createRedraw` copies `real_western`)
- Modify: `backend/src/api/spriteBatchRoutes.js` (`POST /jobs` body; `/subjects` SELECTs add `j.real_western`)
- Test: `backend/tests/sprite_batch_options.test.js`, `backend/tests/sprite_job_queue_db.test.js`, `backend/tests/sprite_batch_api.test.js`

**Interfaces:**
- Produces:
  - `SPRITE_ALL_DIRECTIONS` (frozen `['s','se','e','ne','n','nw','w','sw']`) and `WESTERN_DIRECTIONS` (frozen `['w','nw','sw']`), exported from `spriteBatchOptions.js`.
  - `normalizeDirections(list: unknown) -> string[] | null`: lower-cases, de-duplicates, returns compass order. Returns null for a non-array, an empty array, or any unknown id.
  - `enqueue(db, targets, { actions, framesPerAction, propFx, directions })`: `directions` is optional (already normalized). When given, directional subjects use it and `real_western = directions` includes a western id. Props always `['s']`/false.
  - Column `sprite_sets.real_western boolean NOT NULL DEFAULT false`, returned by `/subjects` as `real_western`.

- [ ] **Step 1: Write the migration.** `up`: `pgm.addColumn('sprite_sets', { real_western: { type: 'boolean', notNull: true, default: false } })`; `down`: drop it. The header comment says why: only explicitly chosen western rows are real. Pre-SOMET-669 rows also list w/nw/sw, but those rows are broken (SOMET-659).
- [ ] **Step 2: Write failing tests** in `sprite_batch_options.test.js`:
  - `normalizeDirections(['n','S','e','s'])` deep-equals `['s','e','n']`;
  - `normalizeDirections(['sw','w','nw','ne','se'])` deep-equals `['se','ne','nw','w','sw']`;
  - `normalizeDirections([])`, `normalizeDirections(['up'])`, `normalizeDirections('s')` each `=== null`;
  - `optionsForEntity({is_creature:true,…}).directions` still deep-equals `['s','e','n']`.
- [ ] **Step 3: Write failing DB tests** in `sprite_job_queue_db.test.js`, following that file's scratch-DB fixture style:
  - enqueue a creature with `directions: ['s','se','e','ne','n','nw','w','sw']` → row `directions` is all 8 and `real_western === true`;
  - enqueue a creature with `directions: ['s','e']` → `real_western === false`;
  - enqueue a prop and a creature together with all 8 → the prop row is `['s']` / false (Review Focus 2);
  - enqueue without `directions` → `['s','e','n']` / false;
  - enqueue a creature, then enqueue again with `['s','w']` while it is still `queued` → the same row id, `directions` `['s','w']`, `real_western` true, and `updated[0].dropped_box_job_id` equals the box job id set beforehand via `UPDATE … SET box_job_id='bj-1'` (Review Focus 1);
  - `createRedraw` from a source with `real_western = true` → the redraw row has `real_western === true`.
- [ ] **Step 4: Run and see them fail.** `cd backend && TEST_DATABASE_URL=$S DATABASE_URL=$S node --test tests/sprite_batch_options.test.js tests/sprite_job_queue_db.test.js` (S = scratch DB URL, migrated). Expected: FAIL on `normalizeDirections is not a function` / missing column.
- [ ] **Step 5: Implement.**
  - Add the three exports to `spriteBatchOptions.js`.
  - `enqueue`: `const rowDirections = (o) => (o.kind === 'object' || !directions ? o.directions : directions)`, and `real_western` per row = `rowDirections(o).some(d => WESTERN_DIRECTIONS.includes(d)) && Boolean(directions) && o.kind !== 'object'`.
  - Add `real_western` to the UPDATE SET (and to its unnest as `$7::boolean[]`) and to the INSERT column list and unnest.
  - The UPDATE's box-job detach condition already compares `directions`; keep it.
  - `createRedraw` adds `real_western` from `source.real_western`.
- [ ] **Step 6: Route.** In `POST /jobs`:
  - read `req.body.directions` when present;
  - run it through `normalizeDirections`, and on null return 400 `{ error: 'directions must be a non-empty list of: s, se, e, ne, n, nw, w, sw' }`;
  - pass it to `enqueue`, omitted → `undefined`.
  - Add `j.real_western` next to `j.directions` in both `/subjects` SELECTs.
- [ ] **Step 7: Write a failing API test** in `sprite_batch_api.test.js` (that file's stubbed-catalog harness):
  - `directions: ['up']` → 400 with that message;
  - `directions: []` → 400;
  - `directions: ['E','s','e']` → 201 with the stored row `['s','e']` (Review Focus 4);
  - no `directions` → 201 with `['s','e','n']`.
- [ ] **Step 8: Run Task 1's three test files and see them pass.** Run twice (memory: fail-then-pass on a fresh DB). Expected: exit 0 both times.
- [ ] **Step 9: Commit.** `feat(sprites): choose sprite sheet directions per batch (SOMET-686)`.

### Task 2: Real western rows: manifest stamp + redraw

**Files:**
- Modify: `backend/src/services/spriteSheetManifest.js` (`buildBoxSheetManifest`)
- Modify: `backend/src/services/spriteDispatcher.js:387,567` (pass `realWestern: row.real_western === true`)
- Modify: `backend/src/api/spriteBatchRoutes.js` (`/jobs/redraw` western block)
- Test: `backend/tests/sprite_manifest.test.js`, `backend/tests/sprite_redraw_api.test.js`, `frontend/src/games/something2/src/js/systems/__tests__/sheetActions.test.js`

**Interfaces:**
- Consumes: `WESTERN_DIRECTIONS` and the `real_western` column (Task 1).
- Produces: `buildBoxSheetManifest({ …, realWestern?: boolean })`. When `realWestern` is true and `directions` has western ids, the manifest gets `unmirrored: { [action]: <those western ids in compass order> }` for every action. Otherwise there's no `unmirrored` key (unchanged).

- [ ] **Step 1: Write failing tests** in `sprite_manifest.test.js`, reusing that file's atlas/PNG fixture builder:
  - all 8 directions, actions `['idle','walk']`, `realWestern: true` → `manifest.unmirrored` deep-equals `{ idle: ['nw','w','sw'], walk: ['nw','w','sw'] }`;
  - the same input with `realWestern: false` → `'unmirrored' in manifest === false` (Review Focus 3);
  - `['s','e']` with `realWestern: true` → no `unmirrored` key.
- [ ] **Step 2: Write a failing redraw test** in `sprite_redraw_api.test.js`:
  - a source row with `real_western = true` and `directions` including `'w'` accepts frame `idle/w/0` (201);
  - the same frame on a source with `real_western = false` still answers 400 `…western directions are mirrored in game and cannot be redrawn`.
- [ ] **Step 3: Write a pinning test** in `sheetActions.test.js`. A box manifest with rows for all 8 directions under `idle`, plus `unmirrored: { idle: ['nw','w','sw'] }`: `rowFor(m,'idle','w',out)` returns `'w'` with `out.flipX === false`, the same for `'nw'` and `'sw'`, and `'se'` returns `'se'` unflipped. Without `unmirrored`, `'w'` returns `'e'` with `flipX === true`. This should already pass; it pins the renderer contract that creatures and heroes (`RenderSystem.resolveSprite`, lines 3779 and 4014) rely on.
- [ ] **Step 4: Run and confirm** the backend tests FAIL and the frontend pin PASSES. Commands: `cd backend && node --test tests/sprite_manifest.test.js` (no DB); the redraw test with the scratch-DB env; `cd frontend && npx vitest run src/games/something2/src/js/systems/__tests__/sheetActions.test.js`.
- [ ] **Step 5: Implement.**
  - Add `realWestern` to `buildBoxSheetManifest` per Produces. Spread so an existing `unmirrored` (turnaround) is kept, merged per action.
  - Pass `realWestern` at both dispatcher call sites.
  - In `/jobs/redraw`, move the western check after the source row is loaded and allow a western frame when `source.real_western && source.directions.includes(f.direction)`.
- [ ] **Step 6: Run Task 2's tests, plus `sprite_dispatcher.test.js` and `sprite_turnaround*` if present.** Expected: exit 0.
- [ ] **Step 7: Commit.** `feat(sprites): draw admin-chosen western rows for real (SOMET-686)`.

### Task 3: The tab: presets, checkboxes, estimate, Directions column

**Files:**
- Modify: `frontend/src/games/something2/spriteSelection.js`
- Modify: `frontend/src/games/something2/SpriteConsoleAdmin.jsx`
- Test: `frontend/src/games/something2/__tests__/spriteSelection.test.js`, `__tests__/spriteConsoleTable.render.test.js`, `__tests__/SpriteConsoleAdmin.smoke.test.js`

**Interfaces:**
- Consumes: `POST /jobs` `directions` and `/subjects` `real_western` (Task 1).
- Produces, in `spriteSelection.js`:
  - `SPRITE_DIRECTIONS` (the 8 ids), `DIRECTION_PRESETS = { 2: ['s','e'], 4: ['s','e','n','w'], 8: [all 8] }`, `DEFAULT_DIRECTIONS = ['s','e','n']`;
  - `toggleDirection(dirs: string[], id: string) -> string[]` (compass order);
  - `presetOf(dirs) -> 2|4|8|null`;
  - `hasWestern(dirs) -> boolean`;
  - `cellCount(rows, actions, frames, directions = DEFAULT_DIRECTIONS)`;
  - `queuePayload(catalog, rows, { actions, frames, propFx, directions })`, which adds `directions` unless the selection is props-only;
  - `directionsLabel(subject) -> string`.

- [ ] **Step 1: Write failing unit tests** in `spriteSelection.test.js`:
  - `toggleDirection(['s','e','n'],'w')` deep-equals `['s','e','n','w']`, and `toggleDirection(['s','e'],'s')` deep-equals `['e']`;
  - `presetOf(['s','e'])===2`, `presetOf(['s','e','n','w'])===4`, `presetOf(SPRITE_DIRECTIONS)===8`, `presetOf(['s','e','n'])===null`;
  - one creature row, 2 actions, 3 frames, `DIRECTION_PRESETS[8]` → `cellCount === 48`; with no directions argument → 18 (unchanged);
  - `queuePayload` with a creature and `directions:['s','e']` → body `.directions` deep-equals `['s','e']`; a props-only selection has no `directions` key;
  - `directionsLabel({directions:['s','e','n','w'], real_western:true})` is `'s · e · n · w (real west)'`, and `directionsLabel({})` is `'—'`.
- [ ] **Step 2: Run them and see them fail.** `cd frontend && npx vitest run src/games/something2/__tests__/spriteSelection.test.js`.
- [ ] **Step 3: Implement the helpers** in `spriteSelection.js`. Remove `FACINGS`; `cellCount` uses `directions.length` for non-flat rows.
- [ ] **Step 4: Write failing render tests.**
  - `spriteConsoleTable.render.test.js`: the header has a `Directions` cell between `Actions` and `Frames`, and a row with `directions:['s','e']` shows `s · e`.
  - `SpriteConsoleAdmin.smoke.test.js` (its existing mocked catalog/queue):
    - clicking the `8-way` button, then Queue, posts `directions` with 8 ids;
    - unticking every direction disables Queue and shows `Pick at least one direction` (Review Focus 5);
    - ticking `w` shows the warning text `West-facing rows from the box have looked wrong before — check them in the preview.`
- [ ] **Step 5: Implement the UI** in `SpriteConsoleAdmin.jsx`:
  - `const [directions, setDirections] = useState(DEFAULT_DIRECTIONS)`;
  - in the creature options bar, a `Directions (n of 8)` field with three preset buttons labelled `2-way`, `4-way`, `8-way` (the active one marked via `presetOf`, otherwise "custom (n)"), and 8 checkboxes using the existing `Check` styling;
  - the warning `Hint` when `hasWestern(directions)`;
  - replace the Actions copy "· each drawn front, side and back (the game mirrors the other side)" with nothing (the Directions field now says it);
  - pass `directions` to `cellCount` and `queuePayload`;
  - disable Queue with the reason when `directions.length === 0` and a creature is selected;
  - add the table column via `directionsLabel`.
- [ ] **Step 6: Run the three test files plus the rest of `__tests__/sprite*`.** Expected: all pass.
- [ ] **Step 7: Commit.** `feat(sprites): direction presets and checkboxes in the sprite tab (SOMET-686)`.

### Task 4: Live check on the box

**Files:** none (verification). Evidence goes in the ticket comment.

- [ ] **Step 1:** With the branch on the dev stack (after merge, per the user's landing choice), queue **one** Warrior appearance with actions `idle`, frames `2`, preset `8-way` from the tab in a real browser (Chrome DevTools MCP, `--mute-audio`, per memory). Press Start batch.
- [ ] **Step 2:** When it's done, read its `sheet.json` via `/api/assets/<manifest_key>`. Expect 8 rows for `idle` and `unmirrored.idle` deep-equal to `['nw','w','sw']`. If the box rejects 8 directions or drops rows, record its exact answer: that's the box's answer to question (a), and it goes back to the design.
- [ ] **Step 3:** Open the preview modal, then in-game walk or face the hero west. Take a screenshot: the west row is drawn, not the mirrored east row. Compare against an old s/e/n hero, which still mirrors.
