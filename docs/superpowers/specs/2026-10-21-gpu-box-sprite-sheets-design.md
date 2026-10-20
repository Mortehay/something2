# GPU-box sprite sheets on the Sprite Generation page — design

Date: 2026-10-21. Status: draft for approval.

## Why

The admin Sprite Generation page (`/game/sprites`,
`frontend/src/games/something2/SpriteConsoleAdmin.jsx`) generates creature
sprites on the local `sprite-gen` container: CPU, sd-turbo, text-only frames,
one implied idle animation, 8 facings. The GPU box (Windows/WSL2, RTX 3060
12 GB, 48 GB RAM, `http://192.168.0.218:8001`) has a much better pipeline:
Qwen-Image-Edit-2511 turns one concept image into a multi-action sheet. The user
says Qwen gives much better results than SDXL, and wants this page to use it.

Today the only record of "which image a sprite came from, which actions it has,
how many frames each" lives on the box. The user wants that information here,
stored with the sprite, and visible.

## Goals

1. The page reads the box's **action catalog** and offers it: multi-select of
   actions, one **frames-per-action** value applied to all selected actions
   (same as the box's own UI). Nothing about actions or frame limits is
   hardcoded on our side.
2. All queued jobs (creatures and props) run **on the GPU box with Qwen**, not on local
   sprite-gen.
3. Every finished job stores, next to the sheet, a **JSON file** naming the
   sheet file and describing each row: which action, which facing, how many
   frames.
4. **Preview popup** (layout "A", chosen by the user from mockups): concept
   image ("used image") on the left with file name and size; generated sheet on
   the right with every row labelled `row N · action · facing · K frames`;
   download links for the sheet PNG and the JSON. Opened by clicking the new
   Concept or Sheet thumbnail in a table row.
5. Existing behaviour that must keep working: pagination (100/page), filters,
   select page / select all matching, queue/start/stop/rescue/clear, approve.
   An approved sheet must not break the game: creatures keep rendering a static
   frame exactly as today.

## Non-goals

- **Playing named creature actions in the game.** The game client only knows
  `DIR/idx` frames and shows creatures as a static `S/0` (`spriteAtlas.js`,
  `RenderSystem.js:3435`). Walk/attack playback is a separate project. (Props'
  wind sway IS in scope — see Decisions.)
- An animated **Play** tab in the popup (mockup "B", not chosen).
- Reference images / style profiles (`/api/references`,
  `/api/style-profiles`) — the JobSpec `style_profile` stays unset.
- SDXL-based sheets.
- Choosing facings: always all 8 (decided below).
- Deleting local `sprite-gen` code (decided below).

## Anti-goals (fails even if it "works")

- The box's API key reaching the browser. All box calls go through the backend,
  using the stored provider secret exactly like the audio/text providers do.
- A JSON whose row labels disagree with the sheet image. The JSON must be built
  from what the box reports for **this** job, never from what we asked for.
- The page hanging or erroring when the box is off (it was off on 2026-10-20).
  The page must load and say the box is unreachable; queueing is disabled.
- Silent fallback to local sprite-gen when the box is down. The user chose the
  box; a job that cannot reach it fails with a clear `last_error`.

## Decisions

Made by the user:
- Use the GPU box with Qwen for this page, replacing local sprite-gen here.
- Actions and frame count come from the box; multiple actions, one frame count
  for all of them.
- Store a JSON per sheet: sheet file name, row → action (+ facing), frames per
  row.
- Preview popup layout A.
- The guesses below were accepted ("for today looks normal").

Accepted guesses (proposed by Claude, user agreed):
- **All 8 facings** every job (s, se, e, ne, n, nw, w, sw), matching our
  existing 8-direction creatures.
- **Concept image comes from the box's `POST /api/generate_core`** (SDXL +
  pixel-art-xl, ~10 s), generated per job from the entity's prompt, then handed
  to `/api/jobs` as `concept_image`. That concept is the "used image" in the
  popup. Uploading or picking a concept by hand is out of scope.
- **Every subject on the page goes to the box** — creatures, playable classes
  (incl. appearance variants) AND props (user, 2026-10-21). Props (trees,
  rocks) use the box's **idle** and **sway** ("Sway (Wind)") actions so they
  look like they move slightly in the wind. The page is box-only; no local
  sprite-gen path remains on it.

Claude's calls (builder may revisit if evidence contradicts):
- Local `sprite-gen` code stays in the repo; this page simply stops routing
  creature jobs to it.
- **Props get one facing, `s`**: a tree has no facing, and 8 would cost 8× for
  nothing. Default action selection for props is idle + sway. (The
  action/frames controls apply to the whole selection; in a mixed selection,
  props still get only `s`.)
- **Props have the same concept-check problem as wide creatures** (the box
  rejected a boulder: "not taller than wide"); the same rule and fallback order
  below apply — props must work, not be skipped.
- **An approved prop sways in the game.** Approve writes `render_mode =
  'animated'` and our JSON also carries bare `"0".."n-1"` frame keys pointing at
  the sway row (idle row if no sway), which the client already cycles for
  animated objects (`tileFrameKey` in `spriteAtlas.js`). Named-action playback
  for creatures stays a non-goal.
- Cell size `48x64` and `colors 24` (box defaults) are used as-is; not exposed
  in the UI in this slice.
- Seed: keep `seedFor('sprite', subject, priorCount)` and pass it to
  `/api/jobs`. `generate_core` documents no seed field, so the concept is not
  reproducible; that is acceptable (nice-to-have, not a requirement).
- **`concept_check: false`** for every subject we send. We already know the
  subject is a creature/class; the box's check exists to reject props, and it
  would also reject real creatures that are wider than tall (Wolf, Bat, Slime;
  see `scripts/generate-entity-textures.js:34-37`). The first end-to-end
  capture must include **Wolf**. **Wide creatures must produce a usable sheet —
  failing them is not acceptable (user, 2026-10-21).** If `concept_check: false`
  alone does not give a usable Wolf sheet, the builder must make it work, in
  this order of preference: (1) shape the concept on our side so it passes as a
  character (e.g. pad it onto a taller canvas) — but `concept_image` is a path
  under the box's `images/`, so this needs a box route that stores an uploaded
  image there; find one in the OpenAPI (`/api/references`, `/api/edit`, …) or
  (2) a change on the box itself, raised with the box's owner/session rather
  than edited from here. Report which one was needed.
- **Concept identity must be verified, not guessed.** The reference code's
  "newest core asset after the one we saw" can pick another session's concept
  on a shared box. The builder must tie the concept to our request (task id
  from `generate_core`'s response / `/api/task-status/{id}`, or matching the
  asset's recorded prompt). If no reliable tie exists, the job fails rather
  than using a possibly-foreign concept — same rule as the JSON anti-goal.
- **Stop** keeps today's meaning: no new job is claimed; the job already on the
  box runs to completion. No abort in this slice.
- **`box_job_id` gets its own column.** After a backend restart (routine —
  nodemon) or Rescue, a row that has a `box_job_id` whose box job is still
  queued/running/done resumes polling that job instead of starting a new one;
  only a row with no box job, or whose box job failed/vanished, is re-run. This
  avoids an orphan occupying the concurrency-1 box with a duplicate behind it.
- **Long jobs are normal.** User measured: all 7 actions × 6 frames × 8 facings
  (336 cells) ≈ 2+ hours, i.e. ~22 s/cell on the 3060 — the old ~393 s/cell
  note is stale. No cap. The controls show the cell count and an estimated time
  (`cells × last measured s/cell`, seeded with ~22 s) before queueing. Poll timeout scales with cell count; a job whose box status
  makes no progress for a long stall window (builder picks, e.g. 20 min) fails
  as "box stalled" — that is how a wedged box is told apart from a long job.

## What the box offers (observed 2026-10-20, box online)

OpenAPI at `GET /openapi.json`. Bearer auth enforced (`GET /api/auth/mode` →
`enforced: true`). Relevant routes:

| Route | Use |
|---|---|
| `GET /api/action-catalog` (no auth) | actions, directions, max frames, engine |
| `POST /api/generate_core` (form: `prompt`, `llm_name`) | concept image |
| `GET /api/assets?source=image&kind=core&limit=1` | find the concept just made |
| `POST /api/jobs` (JobSpec) → 202 + id | enqueue sheet build |
| `GET /api/jobs/{id}`, `GET /api/jobs?ids=` | poll |
| `DELETE /api/jobs/{id}` | cooperative cancel |
| `GET /api/jobs/{id}/sheet`, `/atlas` | results |

Action catalog response (abridged):

```json
{"actions":[{"id":"attack","label":"Attack","max_frames":6},
            {"id":"cast","label":"Cast Spell","max_frames":6},
            {"id":"damage","label":"Receive Damage","max_frames":6},
            {"id":"idle","label":"Idle","max_frames":6},
            {"id":"sway","label":"Sway (Wind)","max_frames":6},
            {"id":"use","label":"Use / Interact","max_frames":6},
            {"id":"walk","label":"Walk","max_frames":6}],
 "directions":[{"id":"s","family":"front"}, … 8 total],
 "max_frames":6, "frames_by_action":{"attack":6, …}, "default_direction":"s",
 "engine":{"label":"Qwen-Image-Edit-2511 (GGUF)","steps":4, …}}
```

JobSpec: `prompt, concept_image (path under the box's images/), actions[],
directions[], frames (default 4), cell ("48x64"), colors (24), seed (0),
style_profile (null), concept_check (true)`.

**Not yet observed:** the body of `GET /api/jobs/{id}`, `/sheet` and `/atlas`
(requires the key). **The builder's first step is to capture one real job
end-to-end through the backend** (one creature, `idle`, 1–2 frames) and record
the real response shapes in this doc before writing the parser. Wall time is
known from the user's test (~22 s/cell); still record the capture's own timing. Memory/notes say the box can wedge (WSL2 `dxgkio` ENOMEM) while
status endpoints stay green — a job that sits in `running` beyond a timeout
must fail, not hang.

## Shape of the work

### Backend

- **Box client** (new service, modelled on `remoteAudioProvider.js`'s
  `call/callJson`): uses `safeFetch` and `authHeaders(provider)`; the origin of
  the provider's `base_url`. Provider = the active `modality='image'` provider
  (`loadActiveProviderWithSecret`). Exposes: `actionCatalog()`,
  `generateCore(prompt, seed)`, `createSheetJob(spec)`, `getJob(id)`,
  `cancelJob(id)`, `fetchSheet(id)`, `fetchAtlas(id)`.
  `generate-entity-textures.js:161-270` (`generateViaCore`) is the working
  reference for the concept step (asset-list polling to find the new id); reuse
  its logic rather than its plain `fetch`.
- **`GET /api/sprite-admin/action-catalog`**: proxies the catalog, short cache
  (e.g. 60 s). Box unreachable → `503` with a readable message; the page shows
  it and disables queueing.
- **Enqueue** (`POST /api/sprite-admin/jobs`): body gains `actions: string[]`
  and `frames: int`. Validated against the live catalog (unknown action,
  frames < 1 or > that action's `max_frames` → 400). Directions: all 8 for
  creatures/classes, `["s"]` for props.
- **Runner** (`spriteDispatcher.js`): for box jobs, per job:
  `generateCore` → store concept PNG in MinIO → `createSheetJob` → poll with a
  timeout → fetch sheet + atlas → store sheet PNG + our JSON in MinIO →
  `queue.complete`. Stop → `DELETE` on the box. One job at a time (the box
  worker is concurrency 1).
- **Storage keys** (same `sprites/<creature>/<job_id>/` prefix sprite-gen uses):
  `concept.png`, `sheet.png` (stored as `atlas_key`), `sheet.json`
  (`manifest_key`).
- **DB** (`sprite_sets`, new migration): `actions text[]`,
  `frames_per_action int`, `concept_key text`, `box_job_id text`, `backend = 'gpu-box'`, `provider_id` filled. Watch the
  migration-ordering gotchas in project notes.
- **Approve**: creature sheet → `entity_types.sprite = {atlas_key:
  <sheet>, manifest_key: <sheet.json>, static_frame: <idle/s/0 if present,
  else first frame>}`, `render_mode='static'` — the game's existing
  `staticFrameKey` keeps working because `frames` contains that key. Prop sheet →
  `render_mode='animated'`, sway loop via bare keys (see Decisions).
- **Subjects list** gains `concept_key`, `actions`, `frames_per_action`,
  `manifest_key` (already) so the table and popup can render.

### Our sheet JSON (`sheet.json`)

Built from the box's atlas for that job. Must stay readable by the current game
(`frames` map of `key → [x,y,w,h]`, `cell`):

```json
{
  "version": 1,
  "sheet": "sheet.png",
  "concept": "concept.png",
  "engine": "Qwen-Image-Edit-2511 (GGUF)",
  "box_job_id": "…",
  "cell": [48, 64],
  "actions": ["idle", "walk", "attack"],
  "frames_per_action": 4,
  "rows": [
    {"row": 0, "action": "idle", "direction": "s", "frames": 4},
    {"row": 1, "action": "idle", "direction": "se", "frames": 4}
  ],
  "frames": {"idle/s/0": [0, 0, 48, 64], "idle/s/1": [48, 0, 48, 64]}
}
```

The exact row order and frame-key naming follow whatever the box's atlas really
is (see "Not yet observed"); the fields above are the contract the page and
approve rely on.

### Frontend (`SpriteConsoleAdmin.jsx`, `useSpriteConsole.js`, `spriteSelection.js`)

- Controls: action checkboxes from the catalog (labels from the box), one
  frames select capped at the minimum `max_frames` of the selected actions, a
  live count of cells for the current selection (8 facings per creature, 1 per
  prop) and the estimated time.
- Box unreachable → banner, queue button disabled; rest of the page works.
- Table: new **Concept** and **Sheet** thumbnail columns; **Actions** column
  (e.g. `idle · walk · attack`) and **Frames** shows `F / action`.
- Popup A as in Goals §4. Sheet rendered with `image-rendering: pixelated`,
  scaled up; the row list comes from `sheet.json`.

## Constraints

- AGENTS.md: work in a worktree, never touch the shared checkout's branch;
  definition of done = backend `npm test` + frontend `npx vitest run` (exit
  codes) + browser verification.
- Never mutate the shared dev DB from tests; set `TEST_DATABASE_URL`.
- nodemon restarts the backend on any `backend/` edit — a running batch dies;
  don't run a real batch while editing.
- The box is shared with other sessions/tools; don't delete its assets or keys.

## Open questions for the user

None. (Q1 resolved: props go to the box with idle + sway.)

## Left to the builder

Box response parsing (after capture), timeouts, cache duration, error wording,
exact migration shape, how the popup loads the JSON (backend-joined vs fetched
from MinIO), test seams.
