# Creature Body Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every creature gets an explicit body type picked from its concept. Blob and many-legged become new
values. A creature with no body is never sent to the GPU box as a humanoid. The box's four-legged pose fix is
briefed.

**Architecture:**
- The body vocabulary lives in `backend/src/services/creatureBodyPlan.js`. New pure helpers decide which
  actions a body may use from the chosen connector's live catalog (`actions[].body_plans`).
- The queue route gates on them. The dispatcher sends and verifies the body for every non-humanoid body.
- Seed sync carries the body with the creature's art.
- The Sprite tab gets the new values, a Body filter and a bulk set.
- Everything is additive. No existing function, option or value is removed.

**Tech Stack:** Node/Express (CommonJS, raw `pg`, node-pg-migrate), `node:test` + supertest. React,
styled-components, TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-creature-body-types-design.md`

## Global Constraints

- **Additive only (user rule).** Do not delete or rename existing functions, options, values or code paths:
  `other`, `QUADRUPED_EXCLUDED_ACTIONS`, `actionsForBody`, text Detect, and the diffusers-only `body_plan`
  send all stay. Add beside them.
- **Body values:** `humanoid | quadruped | blob | multileg | other`, plus NULL.
- **UI labels:** Two legs, Four legs, Blob (no limbs), Many legs, Other (not drawn). Empty = "Not set".
- **Leave existing data alone.** No existing sheet, sprite, image or queued row is deleted or rewritten.
- **Shared checkout.** Work in a git worktree on branch `feat/creature-body-types`. Never checkout or stash
  in the shared checkout. Merging to main is the user's call.
- **Database.** Never run destructive experiments on the dev DB `game_db`. DB tests need their own
  `TEST_DATABASE_URL`, because unset means the dev DB.
- **Migration number.** Take the next number after the highest in `backend/migrations/` at build time (today
  `1714440899781`). Re-check against origin/main before merging.
- **HQ engine.** `spriteEngineOf(provider) === 'comfyui-hq'` refuses any body other than humanoid or NULL at
  queue time, and still sends no `body_plan`.

## Review Focus

1. **Mixed selection.** Props (`is_creature` false), playable heroes and appearance variants are ticked
   together with creatures. Only non-player creature entities are gated. Props and heroes queue exactly as
   before. *Test in Task 2.*
2. **Legacy humanoid base reuse.** A new `humanoid` row must still reuse an old sheet whose manifest has no
   body echo. Treat a missing echo, NULL and `humanoid` as one body. *Test in Task 4.*
3. **Catalog fetched for the wrong connector.** `provider_id` names connector B while A is active. The body
   check reads B's catalog, and the cache is per connector. *Test in Task 2.*
4. **Bulk set over admin and LLM rows.** A bulk set overwrites LLM guesses and earlier admin choices, sets
   source `admin`, and clearing (null) sets source NULL. Non-creature ids in the list are skipped, not 500.
   *Test in Task 2.*
5. **Old seed file.** Importing an art seed file exported before this change, which has no `body_plan` key,
   keeps the local body. *Test in Task 5.*

---

### Task 1: Body vocabulary and catalog helpers

**Files:**
- Modify: `backend/src/services/creatureBodyPlan.js`
- Create: migration `backend/migrations/<next>_creature_body_plan_blob_multileg.js`
- Test: `backend/tests/creature_body_plan.test.js`

**Interfaces:**
- Produces:
  - `BODY_PLANS = ['humanoid','quadruped','other','blob','multileg']`
  - `NON_HUMANOID = ['quadruped','blob','multileg']`
  - `catalogActionsForBody(actions: string[], bodyPlan: string|null, catalogActions: {id, body_plans?}[]) -> string[]`.
    Keeps the actions whose catalog entry lists the body. A NULL body counts as `humanoid`. An entry without
    `body_plans` counts as `['humanoid']`. Input order is kept.
  - `sameBody(a: string|null|undefined, b: string|null|undefined) -> boolean`. Treats null, undefined and
    `'humanoid'` as equal.
  - The SYSTEM prompt gains `blob` and `multileg` lines. `parseAnswer` accepts them.

- [ ] **Step 1: Write the failing tests**

```js
test('blob and multileg are body values beside the old ones', () => {
  assert.deepEqual(BODY_PLANS, ['humanoid', 'quadruped', 'other', 'blob', 'multileg']);
});
test('catalogActionsForBody keeps actions whose catalog lists the body', () => {
  const cat = [{ id: 'idle', body_plans: ['humanoid', 'quadruped', 'blob'] }, { id: 'walk', body_plans: ['humanoid', 'quadruped'] }, { id: 'use' }];
  assert.deepEqual(catalogActionsForBody(['idle', 'walk', 'use'], 'blob', cat), ['idle']);
  assert.deepEqual(catalogActionsForBody(['idle', 'walk', 'use'], null, cat), ['idle', 'walk', 'use']);
  assert.deepEqual(catalogActionsForBody(['use'], 'quadruped', cat), []);
  assert.deepEqual(catalogActionsForBody(['idle'], 'multileg', cat), []);
});
test('sameBody treats no echo, null and humanoid as one body', () => {
  assert.equal(sameBody(undefined, 'humanoid'), true);
  assert.equal(sameBody(null, undefined), true);
  assert.equal(sameBody('quadruped', 'humanoid'), false);
  assert.equal(sameBody('blob', 'blob'), true);
});
test('parseAnswer reads blob and multileg', () => {
  const out = parseAnswer('1=blob\n2=multileg', [{ id: 1 }, { id: 2 }]);
  assert.equal(out.get(1), 'blob'); assert.equal(out.get(2), 'multileg');
});
test('the prompt names blob and multileg bodies', async () => {
  // capture `system` through classify's injected `complete`
  // assert /blob:.*slime/i and /multileg:.*(spider|crab)/i
  // assert the `other` line no longer lists slime or spider
});
```

- [ ] **Step 2: Run them, expect FAIL.** Run: `cd backend && node --test tests/creature_body_plan.test.js`.
  Expected: the new tests fail; the old ones pass.
- [ ] **Step 3: Implement.** Add the new values and helpers. Rewrite the SYSTEM prompt lines:
  - `blob`: slime, ooze, jelly, a mass of rock/mud/flesh with no legs
  - `multileg`: spider, crab, insect, centipede, scorpion, tentacled body
  - `other`: kept for bodies with no poses yet (serpent, bat, bird, floating spirit, object)

  The migration drops and re-adds the `entity_types.body_plan` CHECK with the five values. Its `down` restores
  the three-value CHECK after setting `blob`/`multileg` to NULL. `sprite_sets.body_plan` has no CHECK; leave it.
- [ ] **Step 4: Run tests, expect PASS** (same command). Also run `cd backend && npx node-pg-migrate up` against
  a private test DB and confirm the CHECK accepts `'blob'`.
- [ ] **Step 5: Commit** `feat(sprites): blob and many-legged body values, catalog body helpers`.

### Task 2: Queue gate, per-connector catalog, bulk body set

**Files:**
- Modify: `backend/src/api/spriteBatchRoutes.js`. Touches: `getCatalog` (~l.118), `queueRequestFrom`
  (~l.507–607), and the `/body-plans` routes (~l.275–330).
- Test: `backend/tests/sprite_batch_api.test.js`

**Interfaces:**
- Consumes: Task 1 `catalogActionsForBody`, `BODY_PLANS`, `NON_HUMANOID`.
- Produces:
  - `getCatalog(providerId?: number|null)` reads that connector, else the active one. The cache key is
    already `${provider.id}|${base_url}`; make it a Map per key. Existing callers keep working with no
    argument.
  - `queueRequestFrom` returns `options.catalogActions` (the chosen connector's `catalog.actions`) for
    enqueue.
  - New route `POST /api/sprite-admin/body-plans`, body `{ entity_ids: int[1..1000], body_plan: string|null }`,
    returns `{ updated: number }`.

Gate rules, in this order, applied only to targets with `variant === null` whose entity has `is_creature` and
not `is_playable`:
1. `body_plan` NULL → 400 `set a body first: <names>`
2. `other` → the existing message, unchanged
3. HQ connector and a body other than humanoid → 400 `the HQ connector draws two-legged bodies only: <names>`
4. `catalogActionsForBody(actions, body, catalog.actions)` empty → 400 `no poses for <body> yet: <names>`

The existing `other` query widens to `SELECT id, name, body_plan, is_creature, is_playable FROM entity_types WHERE id = ANY`.

- [ ] **Step 1: Update the fixtures.** In `enqueuePool`, the Wolf row gets `body_plan: 'humanoid'`, so
  existing tests keep queuing. Add `body_plans` to `CATALOG.actions` as the live box has them: every action
  has humanoid; quadruped on all but cast and use.
- [ ] **Step 2: Write the failing tests.**
  - `a creature with no body is refused by name, and nothing is inserted`: Wolf with `body_plan: null` gives
    400 matching `/set a body first: Wolf/`, and no `INSERT INTO sprite_sets` call.
  - `props and heroes are not gated by body`: an `is_creature:false` row with null body gives 201.
  - `a blob creature is refused while the catalog lists no blob poses`: 400 `/no poses for blob yet: Wolf/`.
    With a catalog whose idle lists `blob`, it gives 201 and the INSERT `body_plan` param is `['blob']`.
  - `the HQ connector refuses a four-legged creature`: `provider_id` set to a connector whose
    `request_template.engine` is `comfyui-hq` gives 400 `/HQ connector draws two-legged bodies only/`.
  - `the body check reads the chosen connector's catalog`: `deps.box.actionCatalog` returns different
    catalogs per `provider.id`, and the chosen one decides.
  - `bulk body set marks admin, clears to null, skips non-creatures`: assert the UPDATE SQL has
    `is_creature AND NOT COALESCE(is_playable, false)`. Params are `[ids, 'blob', 'admin']` and
    `[ids, null, null]`. An unknown value gives 400. 0 or 1001 ids gives 400.
  - The existing `other` test still passes unchanged.
- [ ] **Step 3: Run, expect FAIL.** Run: `cd backend && node --test tests/sprite_batch_api.test.js`.
- [ ] **Step 4: Implement** the gate, per-connector catalog and bulk route. The bulk route is one
  `UPDATE … WHERE id = ANY($1::int[]) AND is_creature AND NOT COALESCE(is_playable,false)` and returns
  `rowCount`. Register it before `/body-plans/:id` so `:id` does not swallow it. Keep `/body-plans/detect` and
  `/body-plans/:id` unchanged.
- [ ] **Step 5: Run, expect PASS.** Then run the whole sprite set:
  `node --test tests/sprite_*.test.js tests/creature_body_plan.test.js`.
- [ ] **Step 6: Commit** `feat(sprites): no body no queue; body checked against the chosen connector's catalog`.

### Task 3: Enqueue stores every body and trims actions to the catalog

**Files:**
- Modify: `backend/src/services/spriteJobQueue.js` (`enqueue` signature ~l.29, `rowActions` and
  `rowBodyPlan` ~l.142–144)
- Test: `backend/tests/sprite_batch_api.test.js` (through the route), plus `sprite_queue_qa_eta_db.test.js`
  if it pins `rowBodyPlan`

**Interfaces:**
- Consumes: `options.catalogActions` from Task 2; Task 1 `catalogActionsForBody`.
- Produces: `enqueue(db, targets, { …existing, catalogActions = null })`.
  - `rowActions` = `actionsForBody(...)` (unchanged), then `catalogActionsForBody(..., o.bodyPlan,
    catalogActions)` when `catalogActions` is given.
  - `rowBodyPlan` stores `o.bodyPlan` for any non-object row whose body is in `NON_HUMANOID`, and also stores
    `'humanoid'` when set. NULL stays NULL (legacy and props).

- [ ] **Step 1: Failing tests.**
  - `a four-legged row drops actions the catalog does not list for it`: catalog walk without quadruped. With
    actions `['idle','walk']`, the INSERT actions param is `['idle']`.
  - `a humanoid creature row records humanoid`: INSERT `body_plan` param is `['humanoid']`.
- [ ] **Step 2: Run, expect FAIL** (Task 2 command).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** Run the full sprite set as in Task 2.
- [ ] **Step 5: Commit** `feat(sprites): queued rows carry every body and only the actions it has poses for`.

### Task 4: Dispatcher sends and verifies every non-humanoid body

**Files:**
- Modify: `backend/src/services/spriteDispatcher.js`
  - `assertBodyPlanMatches` ~l.174
  - `findBase` body compare ~l.335
  - `sheetSpec` ~l.511
- Test: `backend/tests/sprite_dispatcher.test.js`, `backend/tests/sprite_dispatcher_incremental.test.js`

**Interfaces:**
- Consumes: Task 1 `NON_HUMANOID`, `sameBody`.
- Produces: no new exports.
  - `sheetSpec` sends `body_plan: row.body_plan` when the body is in `NON_HUMANOID` and the engine is
    diffusers.
  - `assertBodyPlanMatches` checks every `NON_HUMANOID` body against `box_engine_info.body_plan.value`.
  - The base compare uses `sameBody`.

- [ ] **Step 1: Failing tests.**
  - `a blob row sends body_plan blob`
  - `a blob sheet whose echo says quadruped fails the row`, with the message
    `the GPU box drew this with body quadruped, the row asked for blob`
  - `a humanoid row reuses a legacy base with no body echo`
  - `a humanoid row does not reuse a quadruped base`
  - The existing quadruped tests stay unchanged.
- [ ] **Step 2: Run, expect FAIL.**
  Run: `cd backend && node --test tests/sprite_dispatcher.test.js tests/sprite_dispatcher_incremental.test.js`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(sprites): every non-humanoid body is sent to the box and checked in its echo`.

Redraws already copy `source.body_plan` (`createRedraw`). That gives "a redraw keeps its sheet's body" with
no change, so add no code.

### Task 5: The body travels with the creature's art in seed sync

**Files:**
- Modify: `backend/src/services/seedSync/registry.js`
  - full `entity_types` spec omit, ~l.332–333: `body_plan` / `body_plan_source` change from `'per-PC'` to
    `ART`
  - `entity_types` art slice, ~l.569: add both to `columns`
- Test: `backend/tests/art_seed_policy.test.js` (or the art-slice DB test that already round-trips
  `idle_fx`), plus a new case

**Interfaces:** none new. `applySeed` already leaves columns that are absent from a file alone
(`presentColumns`, applySeed.js ~l.366); the test pins that for `body_plan`.

- [ ] **Step 1: Failing tests.**
  - `the art slice exports body_plan and body_plan_source`
  - `importing an art file without body_plan keeps the local body`: a row with local `body_plan='blob'`,
    and a file row with no `body_plan` key. After apply, it is still `'blob'`.
  - The coverage check still passes, because each ART-omitted column is in exactly one slice.
- [ ] **Step 2: Run, expect FAIL** (`node --test tests/art_seed_*.test.js` with a private
  `TEST_DATABASE_URL` for DB cases).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** Also run `node --test tests/*seed*coverage*.test.js` if present.
- [ ] **Step 5: Commit** `feat(seed): creature body travels with its art`.

### Task 6: Sprite tab — new values, gate, Body filter, bulk set

**Files:**
- Modify: `frontend/src/games/something2/spriteSelection.js`
  - `BODY_PLAN_OPTIONS` ~l.282
  - `queueBlockReason` ~l.251
  - `filterSpriteSubjects` + `NO_COLUMN_FILTERS` ~l.59–76
- Modify: `frontend/src/games/something2/useSpriteConsole.js`: add a `useSetBodyPlans` hook next to
  `useSetBodyPlan` ~l.129
- Modify: `frontend/src/games/something2/SpriteConsoleAdmin.jsx`
  - `ColumnFilterFields` ~l.208: add a Body filter
  - Body select tooltip ~l.335
  - next to the Detect button ~l.866: a "Set body for N ticked" select + button
- Test: `frontend/src/games/something2/__tests__/spriteSelection.test.js`, `queueJobsBody.test.js`

**Interfaces:**
- Consumes: Task 2 route `POST /body-plans {entity_ids, body_plan}`.
- Produces:
  - `BODY_PLAN_OPTIONS` = `''` Not set, humanoid Two legs, quadruped Four legs, blob Blob (no limbs),
    multileg Many legs, other Other (not drawn).
  - `filterSpriteSubjects(…, { body = 'all' })`, where `body` ∈ `'all' | 'none' | <value>`. Only subjects
    with `hasBodyPlan` match a body value; `'none'` = hasBodyPlan and no `body_plan`.
  - `queueBlockReason` returns `Set a body first: <names>` for ticked hasBodyPlan rows with no body. It is
    checked before the existing `other` message, which stays.
  - `useSetBodyPlans()` mutation `({ ids, body_plan })`, chunked by 1000. It invalidates subjects like
    `useSetBodyPlan`.
  - Tooltip text: "The concept picture decides the body. Detect only guesses from the text, so check it
    against the concept."

- [ ] **Step 1: Failing vitest cases.**
  - `filterSpriteSubjects body filter: none, blob, ignores props`
  - `queueBlockReason names creatures with no body`
  - `queueBlockReason still names Other bodies`
  - `BODY_PLAN_OPTIONS lists the five bodies and Not set`
- [ ] **Step 2: Run, expect FAIL.** Run: `cd frontend && npx vitest run src/games/something2/__tests__/spriteSelection.test.js`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** Run: `cd frontend && npx vitest run src/games/something2`.
- [ ] **Step 5: Browser check** (muted headless Chrome; recipe in project memory "Dev-run & browser-verify").
  Use a worktree backend on a private DB and the worktree vite, not the shared dev stack. On `/game/sprites`
  with status filter = Any:
  - Body filter "Not set" lists creatures only.
  - Tick 3, set "Blob (no limbs)": the Body column updates and the tooltip says "Set by an admin".
  - Queue with a NULL-body creature ticked: the button reason shows "Set a body first: …", and no POST is
    sent.
  - Queue a four-legged creature: the captured POST body is accepted (201).
- [ ] **Step 6: Commit** `feat(sprites): Sprite tab body filter, bulk set, blob and many-legged choices`.

### Task 7: Box brief for the four-legged pose fix (Part 2) and acceptance

**Files:** none in this repo (brief only; the user approves and builds it in the box session).

- [ ] **Step 1: Send the brief** with SendMessage to the current box Remote Control session (find it with
  ListAgents). The content is the spec's "Part 2" section verbatim, plus:
  - "edit between builds; the user must approve here"
  - "reply to something2-01 with the commit id and test-body-plan.py result"
- [ ] **Step 2: Wait** for the box to report done. Probe the box catalog and `test-body-plan.py` result as it
  reports. Do not assume.
- [ ] **Step 3: Acceptance run** (after Tasks 1–6 are merged and the box reports done):
  - Set Volcanic Brute (id 110) and Beast Skirmisher (id 25) to Four legs.
  - Queue them on the default lane, s/e/n, every action the catalog allows for quadrupeds.
  - Cut each frame at 2x or more.
  - Show the user a page with the frames side by side. The user judges: no forelegs off the ground in
    idle/sway/walk, no rearing attack, no human silhouette.
  - Do not approve the sets yourself.
