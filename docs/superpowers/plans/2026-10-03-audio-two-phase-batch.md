# Audio batch in phases: prompts, model switch, audio

Date: 2026-10-03. Branch `feat/audio-two-phase` (worktree `../something2-wt-audio-two-phase`), based on main `89d6b449`.
Decisions come from the 2026-10-03 grill session. This file restates them; it does not reopen them.

## Problem

`generateForSlot` (backend/src/services/audioGeneration.js) handles one music or ambience job in two steps:

1. If the slot has no stored prompt, it calls the box's `/api/audio/propose`. That runs on the box LLM
   (`brain:qwen3.6-35b-a3b`).
2. It then calls `generateTrack`, which needs `audio:ace-step`.

The GPU worker holds one model at a time, and the brain keeps the card for 300s after its last use. So step 2 is
refused with "requested audio:ace-step, but brain:... holds the card". A busy retry runs step 1 again, which takes
the card back for the brain. The two models keep evicting each other.

## Decisions (confirmed)

1. **The drain runs in phases across the whole queue.** A cycle has three steps:
   - switch the box to the text model, then write every pending prompt;
   - switch the box to the audio model needed by each drain group;
   - generate every job that is ready for audio.

   New work that arrives during the audio phase is picked up in the next cycle.
2. **The audio phase never calls an LLM.** `propose` is removed from `generateForSlot`.
   - Music or ambience that reaches the audio phase with no prompt fails with "no prompt".
   - SFX keeps its deterministic `entityPhrase` fallback, which is not an LLM.
3. **"Force regenerate prompt"** writes a new prompt even when one exists, hand-written prompts included. The old
   version stays in `audio_prompts` history.
4. **Prompts come from the box's `/api/text` only** (`boxOnly: true`). There is no silent fallback to CPU Ollama.
   A `text` provider row must exist; it uses the same URL and token as `gpu-box-audio`.
5. **A single "Generate" click** goes through the queue as a batch of one, so it runs the same three phases.
   **A "Write with model" click** also goes through the queue, as a prompt-only job.
6. **Clicks wait their turn.** A busy box, a refused switch (409) or a model pinned in the box UI **pauses** the
   drain with a visible "waiting for box: <reason>" status, and the drain retries. These never mark a slot failed.
7. **The slot card gets a collapsed "Prompt history (N)" list** with Restore. Restore saves the old text as a new
   active version; history is never edited or deleted.

## Facts this plan relies on (checked 2026-10-03)

- **The box's OpenAPI:**
  - `POST /api/model-gateway/switch` with body `{model, force=false}`. It makes `model` the active, *pinned*
    model. Normal mode returns 409 while any job is queued, running or deferred.
  - `GET /api/model-gateway` returns the status and needs the bearer token.
  - `/api/text` and `/api/text/models` both exist.
- **Model IDs.** From the box error: `audio:ace-step` (music) and `brain:qwen3.6-35b-a3b` (text).
  - The IDs for **ambience, `sfx_realistic` and `sfx_retro` are UNKNOWN**. Task 0 finds them.
- **The switch pins the model.** After an audio phase the box holds `ace-step`, so the next prompt phase has to
  switch back to the brain. There is a switch at both phase boundaries, not just one.
- **The DB.** `audio_jobs` has a unique index on live jobs per slot, `audio_jobs_one_live_per_slot`.
  - `claimBatch` orders work by `DRAIN_ORDER`, then by id.
  - `ai_providers` has no `text` row on the dev DB.
- **The existing writer.** `writeSlotPrompt(db, {kind,key,slot,hint}, {boxOnly, expectActiveId, ...})` already
  stores a new version.
  - It returns `{conflict}` when a hand edit races it.
  - It returns `{busy}` when the box refuses.

## Scope

Included: everything in the decisions above, plus a live test with about 20 slots.

Excluded:
- the non-audio test failures already on main;
- pushing main;
- the tile-transition merge (its migration must be renumbered above 1714440610000 first);
- a diff view, a history view across all slots, and deleting history rows;
- removing the `/admin/propose` route and its "Propose" button. They stay, so a click there can still load the
  brain mid-batch. This is a known risk, listed below.

## Tasks

Every DB test needs both variables set, on **separate** `export` lines, pointing at a fresh scratch DB that is fully
seeded: `seed-catalogs`, both map specs with vale-region LAST, and `FORCE=1 seed-passive-tree`.
Never run destructive experiments on `game_db`.

### Task 0: Find the gateway model IDs (blocks Task 2)

- Write a one-off read-only script. It loads the `gpu-box-audio` provider with its secret and prints
  `GET /api/model-gateway` and `GET /api/text/models`. Do not print the token.
- Record the model ID for each drain group (`music`, `ambience`, `sfx_realistic`, `sfx_retro`) and the brain ID.
- If one model serves two groups, record that too.
- Output: a `GATEWAY_MODEL_FOR_GROUP` map in `remoteAudioProvider.js`, with a comment saying where it came from.
  The text model ID is taken from the `text` provider's model setting, written as `brain:<model>`. Confirm that
  format against the gateway status.

### Task 1: The audio step stops calling the LLM

- `generateForSlot` uses one order: the job's explicit prompt or style, then the stored active prompt, then fail.
  - The failure is `{ok:false, error:'no prompt', retryable:false}` for music and ambience.
  - SFX keeps the `entityPhrase` fallback.
- Test, first and RED: a fake `rap` whose `propose` throws. Generating music for a slot with no prompt fails with
  "no prompt" and `propose` is never called. Generating with a stored prompt sends that prompt.
- Watch for a stored prompt equal to `''`, which means "cleared". It now means "no prompt". Do not let it fall
  through to propose.

### Task 2: The job model and the phased drain (the core)

- Migration `1714440620000_audio_jobs_phases.js` adds to `audio_jobs`:
  - `needs_prompt boolean NOT NULL DEFAULT false`
  - `force_prompt boolean NOT NULL DEFAULT false`
  - `prompt_only boolean NOT NULL DEFAULT false`

  These are columns, not a new state. The existing `state` and its `CHECK` stay as they are.
- `enqueue`:
  - `needs_prompt = force || (no explicit item prompt AND no non-empty active audio_prompts row)`.
  - `prompt_only` comes from the item.
  - Compute it in one SQL statement with a LEFT JOIN on `audio_prompts WHERE active`, not one query per item.
- The claim queries take a phase: `claimBatch(db, n, {phase:'prompt'|'audio'})`.
  - Prompt phase: `needs_prompt = true`, one job per claim.
  - Audio phase: `needs_prompt = false AND prompt_only = false`, claimed by drain group as today.
  - `nextClaimableAt` follows the same filter.
- Settling a prompt job:
  - Success: set `needs_prompt = false`. A `prompt_only` job becomes `done`; any other job goes back to `queued`
    with the attempt refunded.
  - `conflict`: someone edited the prompt meanwhile. Keep their edit, set `needs_prompt = false`, and continue.
  - `busy`: pause, as today's `isBusy` path does.
  - Anything else: `failed` with the writer's error.
- The drain loop in `audioDispatcher.startDrain` runs cycles until both phases come up empty:
  1. If any prompt job can be claimed: `ensureModel(textModel)`, then drain all prompt jobs.
  2. For each drain group with audio-ready jobs, in `DRAIN_ORDER`: `ensureModel(GATEWAY_MODEL_FOR_GROUP[group])`,
     then drain that group.
  3. Repeat.
- `ensureModel(model)`:
  - Calls `rap.switchModel(provider, model)` in normal mode.
  - On 409 it sleeps with backoff and tries again, indefinitely, and sets
    `run.waiting = {model, reason, since}`.
  - Stop still works while it waits.
  - It never uses force mode.
  - It is skipped when the drain's last successful switch was to the same model and no job has been refused since.
- `runStatus()` gains `phase: 'prompt'|'audio'|null` and `waiting`.
- The text provider: if no `text` provider is active, prompt jobs fail with
  "no text provider — add one under AI Providers". That failure is a `failed` slot, not a pause, because waiting
  cannot fix configuration.
- Tests, written RED first against the scratch DB, with a fake `rap` and a fake text provider recording every
  call in order:
  - (a) With 3 music jobs that have no prompt and 2 with a stored prompt, the call sequence is
    `switch(brain)`, `text`×3, `switch(ace-step)`, `generate`×5. No `propose`, and the calls never interleave.
  - (b) A switch that returns 409 twice and then 200 ends with 0 failed jobs, and `waiting` was set while it waited.
  - (c) A `force_prompt` job with an existing hand-written prompt ends with a new active row and the old row inactive.
  - (d) A `prompt_only` job ends `done` with no generate call.
  - (e) A job enqueued during the audio phase gets its prompt in the next cycle, not mid-phase.
  - (f) With no text provider, the prompt job fails with that message.
  - (g) Stop during a 409 wait ends the drain with `stoppedReason = 'stopped'`.
- Keep the existing dispatcher tests green. The breaker, sfx packs, orphan requeue and the busy refund must all
  survive.

### Task 3: The API and UI for force, single Generate and Write with model

- `POST /admin/jobs` accepts `force_prompt` and `prompt_only` on each item and validates both as booleans.
- `AudioBatchPanel` gets a "Force regenerate prompt" checkbox, off by default. When ticked, every queued item
  sends `force_prompt: true`.
- The panel shows the phase and, while waiting, "Waiting for box: <model> (since hh:mm)".
- **Generate** on `AudioSlotCard` enqueues one item with `start: true`, not `/admin/generate`, and shows the slot's
  live job state (`useAudioSlotJobs` already polls it).
  - The slot card also gets the "Force regenerate prompt" checkbox.
- **Write with model** enqueues `{prompt_only: true, force_prompt: true}`.
- `/admin/generate` stays for scripts, but it no longer proposes. It returns 409 "no prompt" when nothing is stored.
- Tests:
  - A route test for the boolean validation.
  - Frontend tests for the checkbox reaching the request body and for single Generate using the queue
    (vitest, the existing `useAudioAdmin` test style).

### Task 4: The history UI

- `AudioSlotCard` renders `prompt.history` from `GET /admin/prompts/:kind/:key`, which already returns it.
  - It is a collapsed `<details>` labelled "Prompt history (N)", newest first.
  - Each row shows the time, the author (`model`, or "hand" when `via` is null), the style and the text.
- **Restore** calls the existing `PUT /admin/prompts/:kind/:key/:slot` with the old text and style, and
  `expectActiveId` set to the current active id.
- Tests:
  - Restore sends the old text and style with the current active id.
  - A 409 shows the reload message.
  - Restore adds exactly one new active row and the previous active row moves into history.

### Task 5: Live check (needs the real box)

- Apply the migrations to the dev DB.
- Create the `text` provider in the AI Providers UI, with the same URL and token as `gpu-box-audio` and the model
  `qwen3.6-35b-a3b`.
- **Acceptance run:**
  1. Pin the brain in the box UI.
  2. Queue about 10 slots with no prompt: music, ambience and SFX.
  3. Start the drain.
  4. Expect each switch to appear once per boundary in the box log, every slot to end with an active prompt and a
     bound clip, and 0 failed.
- **Force run:** re-queue 3 of those slots with Force ticked. Expect 3 new prompt versions, the history UI listing
  the old ones, and Restore working.
- **Style canary:** 20 world-music slots. Record the style distribution and compare it with the 40/40
  `medieval_fantasy` result from CPU qwen2.5. Do NOT queue all ~2,300 slots until this has been looked at.

## Acceptance criteria (as the user sees them)

- A music batch on slots without prompts finishes with no "holds the card" failures.
- In the box log, models switch only at phase boundaries, never between two jobs.
- With "Force regenerate prompt" ticked, existing prompts are replaced, and each old one is visible under
  Prompt history with a working Restore.
- If the box is busy or pinned, the batch panel says "Waiting for box" and the batch resumes on its own. No slot
  is marked failed because of it.
- Clicking Generate on one slot with no prompt produces a prompt and a clip without an error.

## Risks and open items

- **The model IDs for ambience and SFX are unknown** until Task 0. If one gateway model ID covers several engines,
  the per-group switch collapses to fewer switches. That is fine.
- **The pause has no timeout.** A box pinned by hand pauses the run forever. It is visible in the UI, but not
  alerted. The user has not decided on a limit.
- **The "Propose" button** still calls the brain directly and can cause one eviction mid-batch. Delete it later, or
  route it through the queue.
- **A single Generate during a long audio phase waits** until the next prompt phase. That is accepted, and it is
  visible as a queued job.
- **Nodemon restarts** kill a running drain whenever any backend file changes ([[art-batch-dies-on-backend-edit]]).
  Run the live check while no other session is editing `backend/`.
- **The SFX cache.** LLM-written entity text is not unique per subject. The dedupe against all stored sha1s stays
  as it is. Do not weaken it.
