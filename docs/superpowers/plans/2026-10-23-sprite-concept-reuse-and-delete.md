# Sprite Concept Reuse, Delete Generated, Last Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creature sprite sheets reuse a kept concept by default ("New concept" drops it). Admins can delete a subject's generated sprites while keeping its concept, and the table shows when each row last changed.

**Architecture:** A new table `sprite_concepts` holds at most one concept per subject: our MinIO copy, the box path, and the box identity. The dispatcher's `submit` reuses it when the box still serves it, falls back to a new concept otherwise, and keeps a new concept only once its sheet job is accepted. Two admin routes clear concepts and delete generated jobs. The DB part is transactional; files are removed afterwards, best effort. The frontend adds a column, two buttons and a truthful Concept column.

**Tech Stack:** Express + `pg` (CommonJS, raw SQL), node-pg-migrate, MinIO through `backend/src/services/assetStore.js`, `node --test` + supertest; React + styled-components + TanStack Query, vitest node-env with `renderToString`.

**Spec:** `docs/superpowers/specs/2026-10-23-sprite-concept-reuse-and-delete-design.md` (approved 2026-10-23). Read it before any task.

## Global Constraints

- Box calls only in `backend/src/services/gpuBoxSprites.js`, through its authenticated `call` helper, returning the `{ ok, ... }` shape.
- "Same box" = the same `provider_id` AND the same origin (`new URL(provider.base_url).origin`).
- The sprite file folder of a `sprite_sets` row = the directory part of any of its keys (`atlas_key`, `manifest_key`, `concept_key`, `image_key`), including the trailing `/`. Without keys, use `${store.BUCKET()}/${safeName(creature)}/${row.id}/` (same as the dispatcher's prefix). **Never list or delete with a prefix shorter than a row-id folder.** `sprites/Cultist_1/` would also match `sprites/Cultist_10/`.
- Delete never removes:
  - a key in `sprite_concepts.concept_key`;
  - a key any `entity_types.image` holds;
  - a key any `character_appearances.image` holds.
- Delete and New concept skip subjects whose latest job is `running`, and name them in `skipped_running`.
- Copy, used verbatim:
  - confirm: `"Delete all generated sprites for N subjects? Sheets, redraws and queued jobs are removed; concepts are kept. This cannot be undone."` (singular `"1 subject"`);
  - fallback note: `"kept concept unavailable on the box; drew a new one"`;
  - Concept labels: `"Used concept"`, `"Concept — reused"`, `"New concept will be drawn"`;
  - buttons: `"Delete generated"`, `"New concept"`; column header `"Last update"`.
- Migration name: the next free timestamp after origin/main's newest at task time (today `1714440825000_sprite_sets_redraw.js` → `1714440826000_sprite_concepts.js`).
- DB tests: BOTH `TEST_DATABASE_URL` and `DATABASE_URL` set to this branch's scratch DB; never the shared dev DB. Run DB test files twice.
- Work in a worktree. Never use the shared checkout for implementation.

## Review Focus

1. **Similar names** (`Cultist:1` vs `Cultist:10`): deleting one subject never lists or removes the other's files. Test in Task 4.
2. **A prop whose approved image sits in a deleted row's folder:** the image key survives the delete and the entity still shows it. Test in Task 4.
3. **The kept concept was drawn on a box whose URL has since changed (same provider id):** a new concept is drawn, with the note. Test in Task 3.
4. **The box rejects the reused `concept_image` (4xx on createSheetJob):** one fallback to a new concept. A second failure fails the row with the box's words. Test in Task 3.
5. **Delete generated on a subject with a done redraw of an approved sheet:** every row goes and the entity's sprite is nulled. No `redraw_of` FK error. Test in Task 1.

---

### Task 1: Schema and queue functions

**Files:**
- Create: `backend/migrations/1714440826000_sprite_concepts.js`
- Create: `backend/src/services/spriteConcepts.js` (kept-concept queries)
- Modify: `backend/src/services/spriteJobQueue.js` (`deleteGeneratedRows`, `setNote`)
- Test: `backend/tests/sprite_concepts_migration.test.js`, `backend/tests/sprite_concepts_db.test.js`, `backend/tests/sprite_job_queue_db.test.js` (append)

**Interfaces:**
- Produces:
  - Table `sprite_concepts`, per spec: `id serial PK`, `entity_type_id int NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE`, `appearance_variant smallint NULL`, `concept_key text NOT NULL`, `box_concept_path text NOT NULL`, `provider_id int NULL`, `box_origin text NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`, unique index `sprite_concepts_one_per_subject` on `(entity_type_id, COALESCE(appearance_variant, 0))`. Column `sprite_sets.note text NULL`.
  - `spriteConcepts.getKept(db, { entityTypeId, variant }) -> Row|null`
  - `spriteConcepts.upsertKept(db, { entityTypeId, variant, conceptKey, boxConceptPath, providerId, boxOrigin }) -> Row` (ON CONFLICT on the unique index → update all fields, `created_at = now()`)
  - `spriteConcepts.clearKept(db, targets: [{entityId, variant}]) -> { cleared: number, skipped_running: string[] }` (a subject label is `"<entityId>"` or `"<entityId>:<variant>"`; running = a `sprite_sets` row of that subject with `status = 'running'`)
  - `spriteJobQueue.deleteGeneratedRows(client, targets) -> { rows: Row[], subjects: number, skipped_running: string[], cancel_box_job_ids: string[] }`: in the caller's transaction:
    - deletes every `sprite_sets` row of each non-running target, returning the deleted rows;
    - deletes children before parents, so `redraw_of` never blocks (or relies on the FK's `ON DELETE SET NULL`);
    - creature subjects: `entity_types.sprite = NULL, render_mode = 'static'` when `variant` is null, else `character_appearances.sprite = NULL, render_mode = 'static'`;
    - prop subjects (any deleted row `generation_kind = 'object'` and no `creature` rows): the entity row is not touched;
    - `cancel_box_job_ids` = `box_job_id` of deleted rows that were `queued`.
  - `spriteJobQueue.setNote(db, id, note) -> Row|null`

- [ ] **Step 1: Failing migration test.** `up` creates the table, the unique index and `sprite_sets.note`; `down` drops them. Use the same style as `sprite_redraw_migration.test.js`.
- [ ] **Step 2: Failing DB tests**, each in one rolled-back transaction with `{ skip }`:
  - `upsertKept inserts then replaces the subject's concept`: second upsert → one row, new path.
  - `entity and its appearance variant keep separate concepts`.
  - `clearKept removes and skips a running subject`.
  - `deleteGeneratedRows deletes every status and skips running`: queued, done, approved and failed rows go; a running row's subject is in `skipped_running` and keeps all its rows.
  - `deleteGeneratedRows removes a redraw chain of an approved sheet and nulls the creature sprite` (Review Focus 5).
  - `deleteGeneratedRows on a variant nulls character_appearances.sprite and sets render_mode static`.
  - `deleteGeneratedRows leaves a prop entity row unchanged`.
  - `deleteGeneratedRows returns the box job ids of queued rows to cancel`.
- [ ] **Step 3: Run** both files → FAIL. Apply the migration to the scratch DB only.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run twice** → PASS; also run `tests/sprite_job_queue_db.test.js` in full.
- [ ] **Step 6: Commit** `feat(sprites): kept concepts table and delete-generated queries`.

### Task 2: Box client `conceptAvailable`

**Files:**
- Modify: `backend/src/services/gpuBoxSprites.js`
- Test: `backend/tests/gpu_box_sprites.test.js` (append)

**Interfaces:**
- Produces: `conceptAvailable(provider, path, { fetchImpl }) -> Promise<boolean>`. It sends `GET /<path without leading slashes>` through `call` with auth headers and returns true only on 200. It returns false on 404, other statuses, network errors and timeouts. The body is never read: cancel or drain the stream. It is exported.

- [ ] **Step 1: Failing tests:**
  - 200 → true (asserts the path and the auth header);
  - 404 → false;
  - 500 → false;
  - a rejecting fetch → false.
- [ ] **Step 2: Run** `node --test tests/gpu_box_sprites.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sprites): ask the box whether a kept concept is still there`.

### Task 3: Dispatcher reuses the kept concept

**Files:**
- Modify: `backend/src/services/spriteDispatcher.js` (`submit` and its options; `createDispatcher` gains `concepts = require('./spriteConcepts.js')` as an injectable dep)
- Test: `backend/tests/sprite_dispatcher.test.js` (append; extend fakes: `fakeConcepts`, `box.conceptAvailable`)

**Interfaces:**
- Consumes: Task 1 `getKept`, `upsertKept`, `queue.setNote`; Task 2 `box.conceptAvailable`.
- Produces: the `submit(provider, row, prefix)` behaviour from the spec's "Dispatcher" section:
  1. Get the kept concept for `{entityTypeId: row.entity_type_id, variant: row.appearance_variant}`.
  2. **Reuse** when it exists, `kept.provider_id === provider.id`, `kept.box_origin === origin(provider.base_url)`, and `conceptAvailable` is true:
     - copy the kept object into `${prefix}concept.png`, the same way `executeRedraw` copies;
     - create the sheet job with `concept_image: kept.box_concept_path`;
     - `attachBox` with the copy's key.
  3. **The box rejects a reused concept:** `createSheetJob` returns `{ok:false}` with an HTTP 4xx status in its error. Draw a new concept once (step 4) and set the fallback note.
  4. **Otherwise:** draw a new concept as today. After `createSheetJob` succeeds, call `upsertKept` with `conceptKey = ${prefix}concept.png`, `boxConceptPath = concept.conceptPath`, `providerId = provider.id` and `boxOrigin`.
  5. **Fallback note:** when a kept concept existed but was not reused (step 2 failed, or step 3 happened), call `queue.setNote(db, row.id, "kept concept unavailable on the box; drew a new one")` and show it in `cur.message`.

  Detecting the 4xx: if `createSheetJob`'s failure result does not expose the status, add `status` to `httpFailure`'s return in `gpuBoxSprites.js` (additive) and test it there.

- [ ] **Step 1: Failing tests:**
  - `reuses the kept concept: no generateConcept, concept_image is the kept path, copy stored under the row prefix`;
  - `no kept concept: draws one and keeps it after the sheet job is accepted`;
  - `a new concept whose sheet job is refused is not kept`;
  - `kept concept missing on the box draws a new one and sets the note`;
  - `kept concept from a different origin (same provider id) draws a new one and sets the note` (Review Focus 3);
  - `box rejects the reused concept: falls back once to a new concept; a second refusal fails the row` (Review Focus 4);
  - `redraw rows never consult the kept concept`.
- [ ] **Step 2: Run** `node --test tests/sprite_dispatcher.test.js` → new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** dispatcher + gpu_box tests → PASS.
- [ ] **Step 5: Commit** `feat(sprites): creature sheets reuse the kept concept`.

### Task 4: Routes and subjects payload

**Files:**
- Modify: `backend/src/api/spriteBatchRoutes.js`
- Test: `backend/tests/sprite_delete_generated_api.test.js` (new, `routerApp` + fake pool/store style), `backend/tests/sprite_batch_subjects_db.test.js` (append)

**Interfaces:**
- Consumes: Task 1 functions; `deps.store.listObjectKeys`, `deps.store.removeObject`, `store.BUCKET()`; the existing `targetsFrom`, `cancelBoxJobs`.
- Produces:
  - `POST /api/sprite-admin/jobs/delete-generated` body `{ targets }` → `200 { deleted_jobs, subjects, skipped_running, files_deleted, files_failed }`:
    - 400 on bad targets (`targetsFrom`); 409 `"stop the sprite batch before deleting"` is NOT required: running subjects are skipped instead;
    - the DB part (`deleteGeneratedRows`) runs in one `BEGIN … COMMIT` on a pool client;
    - after commit, for each deleted row's folder (Global Constraints), list keys and remove every key not in the protected set (kept concepts plus `entity_types.image` plus `character_appearances.image`, read after commit);
    - failures go to `files_failed` (key list, capped at 50), and the route never 500s because of them;
    - after commit, cancel the queued rows' box jobs best effort (not awaited).
  - `POST /api/sprite-admin/concepts/clear` body `{ targets }` → `200 { cleared, skipped_running }`.
  - The subjects payload (both branches + the appearance mapping) gains `kept_concept_key` (from `sprite_concepts`) and `note` (the latest row's).

- [ ] **Step 1: Failing API tests:**
  - deletes and reports counts;
  - running subjects skipped;
  - **`Cultist:1` delete lists only its row-id folders, never `sprites/Cultist_1/` alone** (Review Focus 1: assert every `listObjectKeys` prefix ends with `/<row id>/`);
  - **the prop's `entity_types.image` key in a deleted folder is not removed** (Review Focus 2);
  - the kept concept key is not removed;
  - a `removeObject` failure lands in `files_failed` with a 200;
  - a DB failure rolls back (`ROLLBACK` issued, 500, no file calls);
  - concepts/clear returns counts.
- [ ] **Step 2: Failing subjects DB test:** `kept_concept_key` and `note` appear for an entity and for a variant.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** (DB twice) plus `tests/sprite_batch_api.test.js` and `tests/sprite_redraw_api.test.js` → PASS.
- [ ] **Step 6: Commit** `feat(sprites): delete generated sprites and clear kept concepts`.

### Task 5: Admin UI

**Files:**
- Modify: `frontend/src/games/something2/spriteSelection.js` (`conceptImageOf`, `conceptLabelOf`, new `lastUpdateLabel`, new `deleteConfirmText`)
- Modify: `frontend/src/games/something2/useSpriteConsole.js` (`useDeleteGenerated`, `useClearConcepts`)
- Modify: `frontend/src/games/something2/SpriteConsoleAdmin.jsx` (column, buttons), `SpritePreviewModal.jsx` (concept label + note line)
- Test: `__tests__/spriteSelection.test.js` (append), `__tests__/spriteConsoleStatus.render.test.js` or a new `spriteConsoleTable.render.test.js`, `__tests__/spritePreviewModal.render.test.js` (append)

**Interfaces:**
- Consumes: Task 4 routes and payload fields.
- Produces:
  - `conceptImageOf(subject)`:
    - a prop (`generation_kind === 'object'`, or `isBoxProp`) keeps today's order;
    - otherwise `subject.concept_key || subject.kept_concept_key || null`.
  - `conceptLabelOf(subject)`:
    - `concept_key` → `"Used concept"`;
    - else `kept_concept_key` → `"Concept — reused"`;
    - else, for creatures, `"New concept will be drawn"`;
    - props unchanged.
  - `lastUpdateLabel(iso) -> { text, title }`: `text` is local `D Mon HH:MM` (e.g. `23 Oct 01:12`, `en-GB`, 24 h), `title` is the ISO string, `"—"` for none.
  - `deleteConfirmText(n)` returns the exact confirm copy.
  - Hooks:
    - `useDeleteGenerated()`: POSTs `{targets}`; its toast reads `"Deleted N jobs from M subjects"` plus `" · skipped running: <names> (Halt or Rescue stranded first)"` when any were skipped.
    - `useClearConcepts()`: toast `"New concept for N subjects"`.
  - Table: a `Last update` column after Status, and the `Delete generated` + `New concept` buttons acting on the selection (disabled with no selection). Delete uses `window.confirm(deleteConfirmText(n))`. A creature row with no concept shows the text `New concept will be drawn` in the Concept cell instead of a thumbnail.
  - Popup: the left column label comes from `conceptLabelOf`; the `note` shows as a muted line when present.

- [ ] **Step 1: Failing tests:**
  - helper cases: creature with a job concept, creature with only a kept concept, creature with neither, a prop unchanged;
  - `lastUpdateLabel` for a fixed ISO in a fixed TZ (`process.env.TZ = 'UTC'` in the test), and null;
  - the confirm text for 1 and 3;
  - render: the column header, a row's Last update text, the two buttons, and `New concept will be drawn` in the Concept cell;
  - the popup shows the note line.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the touched files, the full frontend suite, and eslint on the touched files → PASS.
- [ ] **Step 5: Commit** `feat(sprites): Last update column, Delete generated and New concept`.

### Task 6: Browser check on an isolated stack

**Files:**
- Modify: `backend/scripts/stub-box-redraw.js`: add `POST /api/generate_core` + `GET /api/task-status/:id` (returns a concept PNG and `result.url = /images/core_<n>.png`), `GET /images/:file`, and `POST /api/jobs` that records the received `concept_image`; plus a switch that makes `/images/<file>` answer 404. This is throwaway dev tooling; keep its header comment saying so.

- [ ] **Step 1:** Start an isolated backend, vite and the stub from the worktree against the scratch DB (recipe: `dev-run-browser-verify` memory; the earlier redraw check's report). Never touch the shared stack or `game_db`.
- [ ] **Step 2:** Generate a creature once; confirm `sprite_concepts` holds its box path.
- [ ] **Step 3:** Select it, press **Delete generated**, confirm. Then check:
  - the row shows `not queued`, Last update `—`, and the Concept cell shows the kept concept labelled `Concept — reused`;
  - the old sheet files are gone in MinIO, and the concept file stays.
- [ ] **Step 4:** Queue and run it again; the stub log shows `concept_image` equal to the kept path and no `generate_core` call.
- [ ] **Step 5:** Turn on the stub's 404 switch and run again: a new concept is drawn, and the popup shows the note.
- [ ] **Step 6:** Press **New concept**, then run: `generate_core` is called.
- [ ] **Step 7:** Screenshot each step; stop every process started; keep the worktree clean except the stub change; commit it as `chore(sprites): stub box serves concepts for reuse checks`.
