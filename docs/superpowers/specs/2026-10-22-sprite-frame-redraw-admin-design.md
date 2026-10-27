# Sprite frame redraw — something2 admin design

Date: 2026-10-22. Status: approved 2026-10-22.
Depends on: `2026-10-22-gpu-box-sheet-quality-design.md` (box side; the
per-frame folders, `atlas.quality` and the redraw API are **not built on the
box yet**, so every box detail below marked **[ASSUMED]** is a guess at that
contract and must be isolated in `gpuBoxSprites.js`).
Background: `2026-10-21-gpu-box-sprite-sheets-design.md`.

## Why

GPU-box sheets come back with a few bad frames: wrong facing, zoomed-in
close-ups, leftover backdrop or spell glow, distortion in attack/cast/use.
Regenerating a whole sheet (7 actions × 6 frames × 8 directions = 336 cells,
~hours) to fix three frames is wasteful, and the next sheet has its own bad
frames. The user wants to mark the bad frames in the admin panel and have the
box redraw only those (their words, 2026-10-22):

> "need ability then at something2 admin panel mark frames with issues to
> redraw, but they should also see/know about images to left and to right of
> the action/direction row to not fail the context".

The box redraws each marked frame from the concept (template) plus its left
and right neighbours in the same row (context). So the admin view must make
those neighbours visible: when you mark a frame, you see which frames the box
will lean on, and you can tell if a neighbour is itself bad and needs marking
too.

## Goals

1. In the sprite preview popup, a finished GPU-box creature sheet is shown as
   a grid of individual frames, one row per action/direction, and each frame
   can be marked for redraw with a click.
2. While marking, each row shows what the box will use: marked frames, the
   unmarked neighbours that serve as context, and the order adjacent marked
   frames will be redrawn in.
3. Box quality flags (`atlas.quality`), when present, show on the frames they
   concern, and the flagged frames can be marked in one click.
4. Sending the marks queues a redraw that runs through the existing batch
   queue: same progress bar, Stop/Halt, failure display.
5. A redraw never changes what the game shows until the result is approved.
   An approved sprite keeps its current art in game (`entity_types.sprite`, or
   `character_appearances.sprite` for an appearance variant) while a redraw
   is pending, running, failed or awaiting review.
6. After a redraw, the reviewer can compare the redrawn frames with their
   previous versions, in row context, before approving.

## Non-goals

- Box-side work (checks, per-frame folders, redraw API). Separate design.
- Redrawing props (one image, no sheet) or local-backend sheets.
- Editing frames by hand, reordering frames, or changing a row's frame count.
- Animated row playback in the popup (useful later; not needed to mark).
- Mirroring the box's per-frame PNG folders into MinIO (see Claude's calls).
- Changing the game renderer or the w/nw/sw mirroring rule.

## Anti-goals (fails even if it "works")

- A redraw overwrites the sheet an approved entity points at, so unreviewed
  frames reach the game. Today `/jobs/approve` writes the job's own
  `atlas_key`/`manifest_key` into `entity_types.sprite`; overwriting
  `sprites/<creature>/<job>/sheet.png` in place would do exactly this.
- A failed redraw loses the existing good sheet, its approval, or the
  reviewer's marks.
- Frames the user did not mark change silently. If the box changes an
  unmarked cell, the compare view says so.
- The marking UI hides the neighbours, so the user cannot see what the box
  will use as context.
- A whole-sheet "Queue" pressed while a redraw is queued merges with the
  redraw (the in-place update from 8aa6039f) and produces a half-redraw,
  half-new-sheet job.

## Decided by the user

- Mark individual frames in the admin panel and send them to the box for
  redraw.
- The left and right neighbours of each marked frame matter as context and
  must be visible/known when marking.
- (From the box design) the box redraws marked frames with the concept as
  template and the row neighbours as context; adjacent marked frames are
  redrawn in order, each using the other's new version.
- **Redraws only build forward (2026-10-22).** The box keeps one copy of a
  job and fixes frames inside it, so it only ever holds the newest version.
  A redraw always starts from the subject's newest sheet. A finished redraw
  cannot be thrown away to return to an earlier version: a bad redraw is
  fixed by marking frames again on top of it, and the game keeps the last
  approved art until a newer sheet is approved. A clean restart means
  queueing the whole sheet. No box API to restore an older sheet is asked
  for.

## Claude's calls

Everything in this section is Claude's call, made because the user skipped
the questions. Any of it can be overruled.

### Data model: a redraw is a new `sprite_sets` row

A redraw creates a new `sprite_sets` row copied from the source job
(entity, appearance variant, actions, directions, frames, concept key,
`box_job_id`) with three new columns:

- `redraw_of uuid REFERENCES sprite_sets(id)`: the job whose sheet is being
  repaired.
- `redraw_frames jsonb`: `[{action, direction, frame}, …]`, the marked frames,
  in the box's order.
- `box_task_id text`: the box's id for this redraw, stored as soon as the box
  accepts it so a restart or Rescue resumes polling instead of resubmitting
  (a resubmit would redraw on top of frames the box already changed).

Status starts at `queued`, so `claim()` picks it up like any job and the
batch bar, Stop, Halt, Rescue and the per-row status all work as they do now.
The new row has its own storage prefix, `sprites/<creature>/<new id>/`, so
the storage layout does not change and the source job's files stay untouched.
Approving the redraw row runs the existing approve code unchanged: the entity
switches to the new keys. Until then the entity keeps pointing at the old
sheet, which satisfies goal 5 for free.

Redraws chain (user decision above): redrawing a redraw sets `redraw_of` to that redraw row and
uses the same `box_job_id`. **[ASSUMED]** The box redraws the frames inside
its existing job, so the box job keeps its latest frames. If a box redraw
instead creates a new box job id, the new row stores that id in `box_job_id`.

Why not overwrite in place or keep revisions inside one row: overwriting
breaks anti-goal 1, and revisions inside one row need a new versioning scheme
across approve, the subjects query and the preview. A new row reuses all of
them.

### Dispatcher

`execute(row)` gets a third branch next to sheet and prop: when
`row.redraw_of` is set, it runs `executeRedraw`:

The redraw branch is checked **before** the existing resume logic: today
`execute()` resumes any row whose `box_job_id` reports `done` by fetching
that sheet, which for a redraw row would store the unchanged source sheet as
the result.

1. If `row.box_task_id` is set, resume polling it. Otherwise
   `box.redrawFrames(provider, row.box_job_id, row.redraw_frames)`
   **[ASSUMED]** `POST /api/jobs/{id}/redraw {"frames":[{action,direction,frame}]}`
   returns an id that can be polled like a sheet job (`GET /api/jobs/{id}`,
   same status set). This is the only function that knows the shape.
2. Poll to done with the existing `pollToDone` (deadline = marked frames ×
   cell timeout). Progress label: "Redrawing 3 frames". The task id is saved
   to `box_task_id` first.
3. Fetch `/sheet` and `/atlas` as for a full sheet, build the manifest with
   `buildBoxSheetManifest`, and store `sheet.png` and `sheet.json` under the
   new row's prefix. The source's `concept.png` is copied into the new
   prefix too, so `sheet.json`'s relative `concept: 'concept.png'` resolves
   and every job folder looks the same.
4. `queue.complete(...)` with `sheet_seconds: NULL`, so the row becomes
   `done` (ready for review) and a short redraw never skews the
   seconds-per-cell estimate.

Halt: if the box offers cancel for a redraw task, Halt cancels it and requeues
the row. `requeueHalted` today sets `box_job_id = NULL`; for a redraw row it
must keep `box_job_id` (the only link to the box's sheet) and clear only
`box_task_id`. **[ASSUMED]** If it does not, Halt behaves like Stop
for a redraw (waits for it to finish), and the button tooltip says so.

Box job gone (`missing`, e.g. the box was wiped): the redraw row fails with
"The GPU box no longer has this sheet's job. Queue the whole sheet again."

Cell count for the batch progress and estimate: the number of marked frames.
`rowCells`, `queuedCells` and the Queue button's `cellCount` today compute
actions × directions × frames from the row; they must use
`redraw_frames.length` for redraw rows.

Failure: if a redraw fails after the box accepted it, the box may already
have changed some frames. The dispatcher then tries to fetch the box's
current sheet and atlas and stores them on the failed row, so the preview and
any retry show what the box actually holds. If that fetch fails too, the
banner says the box state is unknown and suggests queueing the whole sheet.

### Queue interactions

- "Queue" (full sheet) on a subject whose latest row is a queued redraw
  deletes the queued redraw and queues a fresh full sheet. The in-place
  update path (8aa6039f) never applies to redraw rows.
- A redraw cannot be queued while the subject's latest row is `queued` or
  `running`. The redraw button is disabled with the reason.
- `Clear queue` clears queued redraws too.

### Subject status and failure

The subjects query keeps showing the latest row per subject. A redraw row
shows status `redraw queued` / `redrawing` / `ready for review` / `redraw
failed` (the Status pill text gains a "redraw" prefix when `redraw_of` is
set).

When the latest row is a failed redraw:

- The preview shows the newest sheet in the chain (the failed row's own,
  if the dispatcher stored one, else walk `redraw_of` back) and a danger
  banner with the error. `sheetImageOf` today falls back to the entity's
  approved `sprite.atlas_key`; for a redraw chain it must prefer the chain's
  sheet, because marks are tied to that sheet's manifest.
- The marks from `redraw_frames` are pre-filled, so "Retry redraw" is one
  click. A retry is an ordinary new redraw from the newest sheet in the
  chain (the failed row's stored sheet if it has one, since that is what the
  box now holds).
- "Discard redraw" is offered only when the box never accepted the redraw
  (no `box_task_id`) or the failed row stored no sheet: then the box still
  holds the source's frames, and deleting the row returns the subject to the
  source row's status. A failed row that stored a sheet stays as the newest
  link in the chain.
- The source row's approval and the entity's sprite are untouched
  throughout.

The same fallback (show the newest row that has a sheet) applies while a
redraw is queued or running, so the preview never goes blank.

### Marking UI (preview popup "A")

For a GPU-box creature sheet that is `done` or `approved`, the right column
changes from one ×2 sheet image to a frame grid. Props and local sheets keep
today's view.

- **Action tabs** across the top (idle, attack, cast, …), each with a count
  badge for marked frames and box-flagged frames. One action's 8 direction
  rows are shown at a time (6 frames × 96 px ≈ 600 px wide fits the 900 px
  modal; all 56 rows at once would be ~7000 px tall).
- **Each row** is labelled `attack · e` and shows its frames at ×2, cropped
  from `sheet.png` with CSS `background-position` (no per-frame files
  needed), on the existing checkerboard so backdrops show.
- **Direction order**: `s, se, e, ne, n` first. `e`, `ne` and `se` carry a
  "×2 in game" note, because the game draws them on both sides. `w`, `nw`,
  `sw` sit below in a collapsed group labelled "Not drawn in game (mirrored
  from e / ne / se)". They can be expanded for reference but **not marked**:
  the game never shows them, and the box may rebuild them by mirroring, which
  would overwrite a redrawn western frame. The API rejects western frames.
- **Click a frame** to toggle its mark (red outline + ✕). Keyboard: frames
  are buttons, Space/Enter toggles, arrows move. A row's label has "Mark
  row" / "Clear row".
- **Context shown live**: unmarked neighbours of marked frames get a dashed
  "context" outline. Under each row with marks, one plain line states what
  the box will do, e.g. "f2, f3 redrawn in order · context: f1, f4". Edge
  cases get their own wording: "f0 · context: f1 only (row start)"; and when
  every frame is marked, "whole row · no neighbour context, drawn fresh from
  the concept" (a warning tone, since continuity then rests on the concept
  alone).
- **Quality flags** (when `atlas.quality` exists and a frame has
  `passed: false`): a small warning badge in the frame's corner, tooltip
  listing `failed_checks` and `attempts`; frames from a row the box redrew
  whole say so. "Mark flagged (N)" buttons per action tab and for the whole
  sheet. Without `quality` (today's box), nothing is shown and the buttons
  are absent. A flag is a hint only; it never marks a frame by itself.
- **Footer**: "N frames marked · ~M min" (estimate = `seconds_per_cell` ×
  N) and a primary button **"Redraw N frames"**. It queues the redraw and
  starts the batch if none is running (the same as pressing Start batch;
  if a batch is running, the redraw just joins the queue). Closing the popup
  with unsent marks asks for confirmation; marks are not saved.

### Quality data

`buildBoxSheetManifest` copies `atlas.quality` (if present and an array)
into `sheet.json` as `quality`, unchanged. `sheet.json` stays `version: 1`;
the game ignores the field. **[ASSUMED]** shape per the box design:
`[{action, direction, frame, attempts, passed, failed_checks: [...],
row_redrawn}]`. Entries naming a frame not in the manifest are dropped.

### Compare after redraw

When the shown row is a `done` redraw, the popup opens on the first action
with redrawn frames and offers a **"Compare with previous"** toggle. In
compare mode each row with redrawn frames shows two strips: previous (source
sheet) above, new below. Redrawn frames are highlighted and their neighbours
stay visible, so continuity can be judged.

The browser compares the two sheets cell by cell (canvas `getImageData`,
both PNGs are same-origin assets). Any cell that differs but was **not** in
`redraw_frames` gets a "changed, not marked" warning, and the action tab
shows a count. This is display only; it does not block approval.

### Storage: no per-frame mirror

The game reads `sheet.png` + `sheet.json`, and the grid crops cells from
`sheet.png`. Mirroring the box's `<action>_<direction>/<n>.png` folders into
MinIO would add a second copy of every pixel with no reader. Not done. If a
later feature needs individual frame files, they can be cut from `sheet.png`
then.

### API (something2 backend, under `/api/sprite-admin`)

- `POST /jobs/redraw` `{ job_id, frames: [{action, direction, frame}] }`.
  Validates: the source job is a GPU-box creature sheet in `done` or
  `approved` with a `box_job_id` and a manifest, and it is the **newest**
  row with a sheet for its subject (redraws only build forward); 1 ≤ frames ≤ the sheet's
  cell count; every frame exists in the source manifest; no duplicates; no
  queued/running row for the subject. Returns `{ id }`. Sorts the frames
  into manifest order (action, direction, frame).
- `DELETE /jobs/:id/redraw` discards a queued redraw row, or a failed one
  under the conditions above. A done redraw cannot be deleted.
- Retry is a `POST /jobs/redraw` against the newest sheet.
- The subjects payload gains `redraw_of`, `redraw_frames`, and
  `source_atlas_key` / `source_manifest_key` (the newest ancestor with a
  sheet), so the preview needs no extra request.

## Constraints

- `sprite_sets` gets three nullable columns; one migration. Check the
  migration-timestamp ordering against main before naming it (recurring
  clash).
- DB tests run on a scratch database (`TEST_DATABASE_URL` and the DB URL
  both set), never the shared dev DB.
- Everything box-facing goes through `gpuBoxSprites.js` (`safeFetch`, capped
  reads, the `{ ok, error }` return shape).
- Admin UI: styled-components with `--s2-*` tokens, TanStack Query hooks in
  `useSpriteConsole.js`, matching the existing popup.

## Verification

1. Unit tests: the redraw request validation (unknown frame, duplicate,
   prop, local backend, job still running); manifest copies `quality` and
   drops unknown frames; the context-summary text (middle, adjacent pair, row
   start/end, whole row); the cell-diff "changed, not marked" function on
   two small pixel arrays.
2. Dispatcher test with a fake box: a redraw row calls `redrawFrames` with
   the marked frames, stores under its own prefix, leaves the source row's
   keys and status untouched; a `missing` box job fails with the message
   above; Halt with and without box cancel.
3. Approve test: with an approved source and a done redraw, the entity
   points at the source keys until the redraw is approved, then at the
   redraw's keys.
4. In a browser (admin login per `dev-run-browser-verify`): mark 2 adjacent
   frames plus one at a row start, check outlines and the summary lines,
   send, watch progress, open compare, approve, confirm in game the sprite
   changed only after approve. Until the box ships the redraw API this step
   uses a stub box (e.g. a fake that returns the source sheet with the
   marked cells tinted) and says so.

## Left to the builder

- Exact visuals (outline colours, badge icon) within the `--s2-*` tokens.
- Whether the grid is a new component file or grows inside
  `SpritePreviewModal.jsx` (it should probably be its own file).
- How the subjects query finds the newest ancestor with a sheet (recursive
  CTE or a stored `source_job_id`).
- Replacing the **[ASSUMED]** box shapes with the real ones once the box
  session publishes them; if the real API differs in a way that changes
  behaviour here (e.g. no in-place redraw, no task polling), bring it back
  to the user.
