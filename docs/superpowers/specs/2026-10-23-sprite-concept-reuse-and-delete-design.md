# Sprite concept reuse, Delete generated, Last update — design

Date: 2026-10-23. Status: approved 2026-10-23 (builder check done; its questions settled as Claude's calls inline).
Page: admin `/game/sprites` (`SpriteConsoleAdmin.jsx`, `SpritePreviewModal.jsx`), backend `spriteBatchRoutes.js`, `spriteDispatcher.js`, `spriteJobQueue.js`, `gpuBoxSprites.js`.

## Why

The user is iterating toward valid GPU-box sprite sheets for the game and re-renders the same creatures many times while testing. Three things get in the way:

1. **Old output piles up.** Each creature accumulates sheets, redraws, queued jobs and approvals. There is no way to wipe a creature's generated sprites and start clean.
2. **Every run draws a new character.** A creature sheet always starts with a new concept from the box (`submit` → `generateConcept` → `createSheetJob({concept_image})`). Two runs of the same creature are therefore not comparable, and a good concept cannot be kept.
3. **The Concept column misleads.** Before a creature's sheet has run, the column shows the hero's appearance art or the entity's current art (`conceptImageOf`). The creature pipeline never uses either.

The user also wants to see when each row last changed.

## What the box offers (checked 2026-10-23 via `/openapi.json`)

- `POST /api/jobs` accepts `concept_image`: "path under images/ to use instead of generating one". `generateConcept` already returns that path (`conceptPath`); we use it once and do not store it.
- The box keeps generated concepts (`GET /api/cores` lists them; `/images/...` is served without auth).
- There is no route to upload an arbitrary image as a concept. `POST /api/references` stores style examples, which is a different thing. So reusing **our** art (appearance or entity image) as the concept is **not** possible without box work. It is out of scope.

## Goals

1. A **Last update** column shows when the row's latest job last changed.
2. Each creature subject (entity, or hero appearance variant) has at most one **kept concept**: our stored copy plus its box path. A new creature sheet reuses the kept concept by default.
3. **New concept** drops the kept concept, so the next run draws a fresh one.
4. The Concept column and the popup show the concept that will actually be used, or say a new one will be drawn.
5. **Delete generated** wipes a subject's sprite jobs and their files, but keeps the concept.

## Non-goals

- Using appearance art or entity art as a concept: needs a box upload route.
- Changing prop generation. Props already reuse the entity's current image (`executeProp`), so their Concept column stays as it is.
- Deleting jobs on the GPU box. Leftover box jobs are harmless there.
- Undo for Delete generated.

## Anti-goals

- Delete generated removing the concept, or touching another subject's files.
- A reused concept that silently is not what the column showed.
- A run failing because the kept concept is gone from the box. It must fall back to drawing a new concept, and the row must say it did.
- The game keeping a known-bad approved creature sheet after Delete generated.

## Decided by the user (2026-10-23)

- Add a Last update column and a Delete generated action to the sprite generation table.
- **Delete generated keeps the concept.**
- Reuse the kept concept by default; New concept draws a fresh one.
- The game drops a deleted creature's approved sheet (Claude's recommendation, given as the plan the user said "proceed" to).

## Claude's calls

### Kept concept: table `sprite_concepts`

One row per subject. Columns:

- `entity_type_id int NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE`
- `appearance_variant smallint NULL`
- `concept_key text NOT NULL`: our MinIO copy, the same object the job stored as `concept.png`
- `box_concept_path text NOT NULL`: e.g. `images/core_abc.png`
- `provider_id int NULL`: the box it lives on
- `box_origin text NOT NULL`: the provider's origin when the concept was drawn. "Same box" means same `provider_id` AND same origin, because a provider's URL can be edited while its id stays.
- `created_at timestamptz NOT NULL DEFAULT now()`
- unique index on `(entity_type_id, COALESCE(appearance_variant, 0))`

It is a separate table so that deleting jobs (Delete generated) cannot take it with them, and so a reuse needs no search through job history.

The migration backfills nothing. Existing rows never stored a box path, so the first run after this ships draws and keeps a new concept. Say so in the release note.

### Dispatcher (`submit`, creature sheets only)

1. Look up the subject's kept concept.
2. If there is one, it is on the same box (see `box_origin`), and `conceptAvailable(provider, box_concept_path)` answers 200: skip `generateConcept`. Copy the kept concept object into this row's `${prefix}concept.png` (the same copy `executeRedraw` does), attach that copy as the row's `concept_key`, and create the sheet job with `concept_image: box_concept_path`. Every job folder stays self-contained, and deleting the row deletes only its copy.
   **If the box rejects that sheet job** (a 4xx answer to `createSheetJob` on a reused concept), fall back once: draw a new concept and continue as in step 3, with the note.
3. Otherwise: draw a new concept as today. **Upsert** it as the subject's kept concept only after the box has accepted the sheet job, storing `box_concept_path` from `conceptPath`. A concept whose sheet job was never accepted is not kept. A run that later fails still keeps its concept; New concept is the way to drop it.
4. If a kept concept existed but was unusable (gone from the box, or a different provider), the row's progress message, and afterwards its `last_error`-free note field, say "kept concept unavailable on the box; drew a new one". Claude's call: store it in a new nullable `sprite_sets.note text`, shown as a muted line in the popup.

A redraw (`executeRedraw`) is unchanged: it never draws a concept.

### New concept

`POST /api/sprite-admin/concepts/clear` with body `{ targets: [{entity_id, variant?}] }` deletes those subjects' `sprite_concepts` rows. A subject with a **running** job is skipped (`skipped_running`), so a run in progress cannot silently re-create the concept the user just cleared. It does not delete the MinIO object, because a job folder may still show it. Returns `{ cleared }`. Button "New concept" in the bar, acting on the selection.

### Delete generated

`POST /api/sprite-admin/jobs/delete-generated` with body `{ targets: [{entity_id, variant?}] }`. Per subject:

- **A running job:** the subject is skipped and named in `skipped_running`. Use Halt first. A row stuck in `running` after a crash is put back by the existing "Rescue stranded" (`requeue-stale`), after which it can be deleted. The toast says so when anything was skipped.
- **Everything else is deleted:** all `sprite_sets` rows (queued, done, approved, failed, redraws). A queued row that already holds a `box_job_id` (rescued) gets a best-effort box cancel, the same as an options change does today.
- **Files:** every MinIO object under each deleted row's prefix `sprites/<safe creature>/<row id>/` is deleted, **except**:
  - the kept concept's `concept_key`;
  - any key `entity_types.image` points at (a prop's approved image lives there).
- **Creature, game side:** `entity_types.sprite = NULL`, `render_mode = 'static'` (it falls back to its plain image). For an appearance variant, `character_appearances.sprite = NULL` and `render_mode = 'static'`, so it falls back to the class sprite (existing behaviour). This clears a stale `'animated'` value that approve can leave on a variant.
- **Prop:** the entity row is not touched at all. `image` and `idle_fx` stay, and approve already left it `sprite = NULL, render_mode = 'static'`. Generation replaced the original image and there is nothing to restore.
- **Order:** the DB work runs in one transaction; file deletion runs after commit, best effort. A file that fails to delete is logged and listed in `files_failed`; it never rolls back the DB.

Response: `{ deleted_jobs, subjects, skipped_running: [...], files_deleted, files_failed }`.

UI: a "Delete generated" button for the selection, behind a confirm: "Delete all generated sprites for N subjects? Sheets, redraws and queued jobs are removed; concepts are kept. This cannot be undone." A toast summarises the counts and names any skipped running subjects.

### Last update column

Shows `job_updated_at` of the latest row (already in the subjects payload) as local `D Mon HH:MM` with the full ISO timestamp in `title`. Shows "—" when there is no job. Placed after Status.

### Concept column and popup

`conceptImageOf` / `conceptLabelOf`:

- **Creature, latest job has `concept_key`:** show it, labelled "Used concept". This is the image the job really used.
- **Creature, no job concept yet but a kept concept exists:** show the kept concept, labelled "Concept — reused". The subjects payload gains `kept_concept_key`.
- **Creature with neither:** no image, the text "New concept will be drawn".
- **Prop:** unchanged (current image, which `executeProp` really uses).
- The appearance art is no longer shown in the Concept column. It stays visible as hero art elsewhere; this column is only for what generation uses.

## Constraints

- Migrations: next free timestamp after origin/main's newest (today `1714440825000_sprite_sets_redraw.js`). Re-check before committing.
- DB tests on a scratch DB with both `TEST_DATABASE_URL` and `DATABASE_URL` set, never the shared dev DB.
- Box calls only through `gpuBoxSprites.js`. Add `conceptAvailable(provider, path)` next to the existing calls, built on the same authenticated `call` helper as the rest (do not assume `/images` is unauthenticated). It returns true only on 200; 404, other errors and timeouts return false. The body is not read.
- MinIO deletion through the existing store module. Never list or delete outside `sprites/<safe creature>/<row id>/` of rows being deleted.

## Verification

1. Unit and DB tests:
   - kept-concept upsert on a new concept;
   - reuse path skips `generateConcept` and passes `concept_image`;
   - fallback when the box answers 404, with the note set;
   - different provider → new concept;
   - New concept clears;
   - Delete generated:
     - deletes all statuses and skips running;
     - keeps the concept key and the prop image key;
     - nulls the creature's / variant's sprite and leaves the prop image;
     - runs the DB part in one transaction.
2. Browser check on an isolated stack:
   - select a creature with a kept concept;
   - Delete generated, then confirm: the row is "not queued", the Concept column shows "Concept — reused", and Last update shows "—";
   - queue and run it, then confirm the job used the same box concept path (box job record or our row);
   - press New concept and run again: a different concept.

## Left to the builder

Exact column formatting and button placement within the existing bar, the toast wording beyond the counts, and how `conceptAvailable` treats a timeout (treat as unavailable → new concept, with the note).
