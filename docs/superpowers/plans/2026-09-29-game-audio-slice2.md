# Game Audio — Slice 2 (batch generation queue + git export/seed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- An admin ticks many worlds/biomes × slots (or picks rows from Missing sounds) and queues them as one batch; a background drain generates them one at a time on the GPU box, grouped so the box switches model as rarely as possible.
- Clips can be browsed and pruned in a library view and reused from it.
- World and biome editors show their sound slots.
- `make audio-export` / `make audio-seed` put the bound clips into git and back.

**Architecture:**
- **Queue:** a new `audio_jobs` table and queue module, modelled on `art_jobs`/`artJobQueue`. It claims one job at a time, earliest drain group first (`music` → `ambience`), with `FOR UPDATE SKIP LOCKED`, retry backoff and a consecutive-failure breaker.
- **Shared generation path:** the generate → store → bind code is moved out of the slice-1 route into `audioGeneration.js`, so the synchronous route and the drain use one path.
- **Export/seed:** `audioSeed.js` mirrors `artSeed.js`. Clip ids are preserved, so re-seeding is idempotent.

**Tech Stack:** as slice 1 — Node/Express (CommonJS) + raw pg + node:test/supertest; React 19 + TanStack Query + styled-components + vitest.

**Spec:** [docs/superpowers/specs/2026-09-28-game-audio-design.md](../specs/2026-09-28-game-audio-design.md). Relevant parts:
- §1 `audio_jobs`
- §2 "Dispatcher"
- §4 "Batch mode", "Library view", "Editor sections"
- §5 export/seed
- "Box contract, measured 2026-09-28"

Slice 1 is merged at `af234f0`.

**Scope ruling (recorded in the spec by Task 0):** the spec's slice 2 also lists the `sfx-pack` drain groups and the Sounds section in the ENTITY editor. No SFX subject exists until slice 3 (creature/attack/item/skill/world-point slots), so both move to slice 3.
- The queue is built group-driven: `drain_group` column plus a `DRAIN_ORDER` constant. Slice 3 adds `sfx_realistic`, `sfx_retro` and a pack path without schema churn.

## Global Constraints

- **Format:** OGG only. Never store WAV, never `?master=true`, never re-encode.
- **Subject keys:** subjects keyed by NAME; the export/seed files key bindings by subject name, never by DB id.
- **Seeds:** every generation sends an explicit integer seed, random unless the admin set one (the box caches identical requests).
- **Model switching:** one drain per process; jobs run one at a time (the GPU box wedges under concurrent load); groups drain in `DRAIN_ORDER` so the box switches model at most once per group.
- **409/busy:** a 409 or "busy" from the box is back off and retry, never `model-gateway/switch force`.
- **Breaker:** the drain stops after `AUDIO_BREAKER_TRIP` (default 3) consecutive provider failures.
- **Auth:** `/api/audio/admin/*` = adminGuard. The box token never appears in a response, log or error. Image paths never use the audio provider.
- **Tests:**
  - DB tests are gated on `TEST_DATABASE_URL` (skip when unset).
  - Run them with `TEST_DATABASE_URL` **and** `DATABASE_URL` both pointing at a per-branch scratch DB, set on separate `export` lines.
  - Never mutate the dev DB `game_db`. Clean up only rows the test created, pushing each id immediately after its insert.
  - Never deactivate providers you did not create.
- **Green:**
  - Backend is green when exit 0 on the audio files, and the full suite's failing-file set equals `main`'s. Today's baseline is 7 files: authority_items_catalog, item_types_reserved_and_reprice, loot_behavior_drops_db, passive_respec_migration_db, progression_kill_xp, progression_routes, rarity_db.
  - Frontend is green when the only failure is the known `progressionExtras.test.js`.
- **Git and commits:**
  - Worktree `../something2-audio2` on branch `feat/game-audio-slice2`. Never branch, checkout or stash in the shared main checkout.
  - Commit subject `type(scope): summary (SOMET-NNN)`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Migration:** timestamp `1714440570000`. `1714440549000` and `1714440560000` are taken; re-check other branches before running.

## Review Focus

1. **The backend restarts mid-batch** (nodemon restarts on ANY backend edit — memory "art batch dies on backend edit"). Rows left `running` must not stay stuck forever: `startDrain` re-queues orphaned `running` rows and refunds their attempt. Pinned in Task 2.
2. **The box is busy with image work or asleep:**
   - Jobs back off with jitter and are retried up to `AUDIO_JOB_MAX_ATTEMPTS`.
   - Three consecutive failures stop the drain with a readable error in the status.
   - No job is lost; failed ones are visible and retryable from the UI.

   Pinned in Task 3.
3. **The same slot is queued twice** (double click, overlapping batches, Missing-sounds + manual tick). There is only one live job per (subject_kind, subject_key, slot), and the second enqueue reports `already_live`. Pinned in Task 1 (unique index) and Task 4 (route).
4. **Seeding on a fresh machine, or onto a DB where a subject was renamed/deleted:**
   - A binding whose subject is gone is reported and skipped, never inserted.
   - Clip rows keep their exported ids, so a second seed is a no-op; `--force` re-uploads.
   - A missing .ogg file is reported, not a crash.

   Pinned in Task 8.
5. **Deleting a clip:** its MinIO object is removed too; deleting a clip that other subjects share asks nothing but reports how many bindings went with it; bulk-delete only touches UNBOUND clips. Pinned in Task 6.

---

## File map

**Backend (create):**
- `backend/migrations/1714440570000_audio_jobs.js`
- `backend/src/services/audioGeneration.js`: provider resolution, propose context, box track name, generate → store → bind (shared by the route and the drain)
- `backend/src/services/audioJobQueue.js`: enqueue/claim/complete/fail/release/stats/list/requeueOrphans/clear
- `backend/src/services/audioDispatcher.js`: startDrain/stopDrain/runStatus/__resetRun
- `backend/src/services/audioSeed.js`: exportAudio/seedAudio/parseArgs
- `backend/scripts/export-audio.js`, `backend/scripts/seed-audio.js`
- tests:
  - `audio_generation_db.test.js`
  - `audio_job_queue_db.test.js`
  - `audio_dispatcher_db.test.js`
  - `audio_jobs_routes_db.test.js`
  - `audio_library_routes_db.test.js`
  - `audio_seed_db.test.js`

**Backend (modify):**
- `backend/src/api/audioRoutes.js`: use audioGeneration; job, library and bind-from-library routes
- `backend/src/services/audioLibrary.js`:
  - `listClips`, `deleteClip` removes the object, `deleteUnboundClips`
  - `bindClip` unchanged
  - `storeClip` gains an optional `id`, for seeding
- `backend/src/services/assetStore.js`: `removeObject(key)`
- `backend/src/services/artSeed.js`: export `matchOwner`, `readObject` (reuse, no copy)
- `backend/src/index.js`:
  - provider Test route → `listStyles` for audio
  - the provider-pin validator rejects audio ids
- `Makefile`: `audio-export`, `audio-seed`
- `docs/ai-providers.md`: replace "Slice 1 limit" with the queue section; export/seed
- `docs/superpowers/specs/2026-09-28-game-audio-design.md`: slice-scope ruling (Task 0)

**Frontend (create):**
- `frontend/src/games/something2/audioBatch.js`: pure batch selection + progress
- `frontend/src/games/something2/AudioBatchPanel.jsx`
- `frontend/src/games/something2/AudioLibrary.jsx`
- `frontend/src/games/something2/SubjectSounds.jsx`: slot cards for one subject, used by the Audio tab, MapCard and BiomeCard
- tests: `__tests__/audioBatch.test.js`

**Frontend (modify):**
- `useAudioAdmin.js`: job, library and bind hooks
- `AudioAdmin.jsx`: batch mode, Library tab, uses SubjectSounds
- `AudioSlotCard.jsx`: "+ From library"
- `MapsAdmin.jsx` (MapCard), `BiomesAdmin.jsx` (BiomeCard)
- `SettingsAdmin.jsx`: modality select disabled when editing

---

### Task 0: Worktree, scratch DB, ticket, spec ruling

**Files:** `docs/superpowers/specs/2026-09-28-game-audio-design.md` (Slices section)

- [ ] **Step 1: Create the worktree.**

```bash
cd /home/markunn/worker/coding/jsgame/something2
git worktree add ../something2-audio2 -b feat/game-audio-slice2 main
ln -s /home/markunn/worker/coding/jsgame/something2/backend/node_modules ../something2-audio2/backend/node_modules
ln -s /home/markunn/worker/coding/jsgame/something2/frontend/node_modules ../something2-audio2/frontend/node_modules
git -C ../something2-audio2 check-ignore backend/node_modules frontend/node_modules   # both must print
```

- [ ] **Step 2: Create the scratch DB `game_audio_s2` and seed it fully**, exactly as slice 1 did:
  - migrate, `seed-catalogs`, `FORCE=1 seed-passive-tree`, `SPEC=p5-descent seed-map`, then `SPEC=vale-region seed-map` LAST;
  - read the password from the main checkout's `.env` without printing it;
  - write `db.env` (TEST_DATABASE_URL + DATABASE_URL) into the SDD workspace, mode 600.

- [ ] **Step 3: Plane.** Create child item "Game audio slice 2 — batch queue + export/seed" under epic SOMET-589, state In Progress. Use its number in every commit.

- [ ] **Step 4: Record the scope ruling in the spec.** In "Slices":
  - item 2 becomes: `audio_jobs` + the grouped drain for music/ambience; batch mode and Missing-sounds → batch; Sounds sections in the world and biome editors; library view; `make audio-export` / `audio-seed`.
  - item 3 gains: the `sfx-pack` drain groups (`sfx_realistic`, `sfx_retro`) and the entity-editor Sounds section.
  - Add one line: "Moved from slice 2 on 2026-09-29: no SFX subject exists before slice 3."
  - Commit `docs: move sfx-pack drain and entity-editor sounds to audio slice 3 (SOMET-NNN)`.

---

### Task 1: Migration — `audio_jobs`

**Files:**
- Create: `backend/migrations/1714440570000_audio_jobs.js`
- Test: `backend/tests/audio_job_queue_db.test.js` (schema part; Task 2 extends it)

**Interfaces:**
- Produces:
  - table `audio_jobs(id bigserial PK, batch_id uuid NOT NULL, subject_kind text, subject_key text, slot text, clip_kind text CHECK music|ambience|sfx, drain_group text CHECK music|ambience|sfx_realistic|sfx_retro, style text, prompt text, slots jsonb, provider_id int FK ai_providers SET NULL, seed bigint, state text CHECK queued|running|done|failed DEFAULT 'queued', attempts int DEFAULT 0, last_error text, not_before timestamptz, claimed_at timestamptz, clip_id uuid FK audio_clips SET NULL, created_at, updated_at)`
  - partial unique index `audio_jobs_one_live_per_slot` on `(subject_kind, subject_key, slot) WHERE state IN ('queued','running')`
  - index `audio_jobs_claim_idx` on `(state, drain_group, id)`

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/audio_job_queue_db.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('audio_jobs schema', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `jobschema-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key = $1', [tag]); }
    finally { await pool.end(); }
  });
  const ins = (state = 'queued', group = 'ambience') => pool.query(
    `INSERT INTO audio_jobs (batch_id, subject_kind, subject_key, slot, clip_kind, drain_group, state)
     VALUES (gen_random_uuid(), 'biome', $1, 'ambience', 'ambience', $2, $3) RETURNING id`, [tag, group, state]);

  await ins('queued');
  await assert.rejects(ins('queued'), /duplicate key/i, 'one live job per slot');
  await ins('done');
  await ins('failed');                       // finished jobs do not block
  await assert.rejects(ins('queued', 'drums'), /check constraint/i);
  await assert.rejects(ins('paused'), /check constraint/i);
});
```

- [ ] **Step 2: Run it and confirm it fails.**
  Run: `source <db.env>; cd backend && node --test tests/audio_job_queue_db.test.js; echo $?`
  Expected: `relation "audio_jobs" does not exist`, exit ≠ 0.

- [ ] **Step 3: Write the migration**

```js
// backend/migrations/1714440570000_audio_jobs.js
exports.shorthands = undefined;

// Game audio slice 2 (spec §1 audio_jobs, §2 Dispatcher). Modelled on art_jobs
// (1714440530000 + 540000): a job is one (subject, slot) generation; the
// partial unique index makes enqueue idempotent while a slot is queued or
// running; drain_group is what the dispatcher orders by so the GPU box
// switches model at most once per group (music, then ambience; slice 3 adds
// sfx_realistic and sfx_retro).
exports.up = (pgm) => {
  pgm.createTable('audio_jobs', {
    id: 'bigserial',
    batch_id: { type: 'uuid', notNull: true },
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    slot: { type: 'text', notNull: true },
    clip_kind: { type: 'text', notNull: true, check: "clip_kind IN ('music', 'ambience', 'sfx')" },
    drain_group: {
      type: 'text', notNull: true,
      check: "drain_group IN ('music', 'ambience', 'sfx_realistic', 'sfx_retro')",
    },
    style: { type: 'text' },
    prompt: { type: 'text' },
    slots: { type: 'jsonb' },
    provider_id: { type: 'integer', references: 'ai_providers', onDelete: 'SET NULL' },
    seed: { type: 'bigint' },
    state: {
      type: 'text', notNull: true, default: 'queued',
      check: "state IN ('queued', 'running', 'done', 'failed')",
    },
    attempts: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
    not_before: { type: 'timestamptz' },
    claimed_at: { type: 'timestamptz' },
    clip_id: { type: 'uuid', references: 'audio_clips', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    CREATE UNIQUE INDEX audio_jobs_one_live_per_slot
      ON audio_jobs (subject_kind, subject_key, slot) WHERE state IN ('queued', 'running')
  `);
  pgm.createIndex('audio_jobs', ['state', 'drain_group', 'id'], { name: 'audio_jobs_claim_idx' });
};

exports.down = (pgm) => {
  pgm.dropTable('audio_jobs');
};
```

- [ ] **Step 4: Migrate the scratch DB, then run the test and confirm it passes.**
  Run: `cd backend && npm run migrate:up && node --test tests/audio_job_queue_db.test.js; echo $?`
  Expected: exit `0`.
  Also verify `down` then `up` works.

- [ ] **Step 5: Commit** `feat(audio): audio_jobs table with one live job per slot (SOMET-NNN)`.

---

### Task 2: `audioGeneration` (shared path) + `audioJobQueue`

**Files:**
- Create: `backend/src/services/audioGeneration.js`, `backend/src/services/audioJobQueue.js`
- Modify: `backend/src/api/audioRoutes.js`. Delete its local `resolveAudioProvider`, `contextFor` and `boxTrackName`, and import them from audioGeneration. `/admin/generate` calls `generateForSlot`. Keep `module.exports.boxTrackName` re-exported so `audio_box_track_name.test.js` keeps passing unchanged.
- Test: `backend/tests/audio_generation_db.test.js`, extend `backend/tests/audio_job_queue_db.test.js`

**Interfaces:**
- `audioGeneration`:
  - `resolveAudioProvider(db, providerId|null) -> provider|null`: the modality is audio and it is enabled.
  - `contextFor(db, kind, key) -> string`
  - `boxTrackName(kind, key, slot, seed) -> string`: moved verbatim.
  - `randomSeed() -> int in [1, 2^31-1)`
  - `generateForSlot(db, provider, { subjectKind, subjectKey, slot, clipKind, style, prompt, slots, seed }, deps = { rap, lib }) -> { ok: true, clip, binding, seed } | { ok: false, error, retryable }`
    - When `style` and `prompt` are both empty, it first calls `rap.propose(provider, { context: await contextFor(...), kind: clipKind })`. On success it uses the proposed style/slots/prompt; a failed propose falls through to generating with no style (the box default).
- `audioJobQueue` (all `db`-first):
  - `DRAIN_ORDER = ['music', 'ambience']`
  - `drainGroupFor(clipKind) -> 'music'|'ambience'`: throws for `sfx` in slice 2.
  - `enqueue(db, items, { batchId, providerId }) -> { batch_id, queued: rows[], already_live: [{subject_kind,subject_key,slot}] }`
    - `items: [{subject_kind, subject_key, slot, clip_kind, style?, prompt?, slots?, seed?}]`
    - One INSERT over `unnest`, `ON CONFLICT DO NOTHING RETURNING *`; `already_live` = items not returned.
  - `claimNext(db) -> job|null`: the earliest claimable job in DRAIN_ORDER then id order. It sets `state='running'`, `attempts+1`, `claimed_at`, uses `FOR UPDATE SKIP LOCKED` and honours `not_before`.
  - `complete(db, id, clipId)`
  - `fail(db, id, error, { retryable }) -> 'retry'|'failed'`
    - A retryable failure with attempts < `MAX_ATTEMPTS` → `queued` with `not_before = now() + backoffMs(attempts)`.
    - Anything else → `failed`.
  - `requeueOrphans(db) -> number`: `running` → `queued`, attempts refunded. Called ONLY at drain start, when no drain runs in this process.
  - `nextClaimableAt(db) -> Date|null`
  - `stats(db) -> { [group]: { queued, running, done, failed } }` plus a `backoff` count
  - `recent(db, limit=50) -> rows` (newest first, `last_error` included)
  - `retryFailed(db) -> number`: failed → queued, attempts reset, not_before null.
  - `clear(db, { states }) -> number`: deletes only the given states among queued/failed/done; never running.
  - `MAX_ATTEMPTS` (env `AUDIO_JOB_MAX_ATTEMPTS`, default 3)
  - `backoffMs(n)` (env `AUDIO_JOB_RETRY_BASE_MS`, default 30000; base·2^(n-1) ± 25% jitter)

- [ ] **Step 1: Write the failing tests**

```js
// backend/tests/audio_generation_db.test.js
// generateForSlot against a fake rap + the real library on the scratch DB.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');
const gen = require('../src/services/audioGeneration');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

test('generateForSlot', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
  const tag = `gen-${process.pid}-${Date.now()}`;
  const worldIds = [];
  t.after(async () => {
    try {
      await pool.query(`DELETE FROM audio_clips WHERE id IN (SELECT clip_id FROM audio_bindings WHERE subject_key = $1)`, [tag]);
      if (worldIds.length) await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [worldIds]);
    } finally { await pool.end(); }
  });
  worldIds.push((await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [tag])).rows[0].id);

  const calls = [];
  const rap = {
    propose: async (p, body) => { calls.push(['propose', body]); return { ok: true, style: 'village', slots: { mood: 'calm and sunny' }, prompt: 'p' }; },
    generateTrack: async (p, body) => { calls.push(['generate', body]); return { ok: true, buffer: OGG, durationMs: 2000, sampleRate: 44100, loopStartMs: 0, loopEndMs: 2000, prompt: 'p', seed: body.seed }; },
  };
  const provider = { id: null, base_url: 'http://x', modality: 'audio' };

  const r = await gen.generateForSlot(pool, provider,
    { subjectKind: 'world', subjectKey: tag, slot: 'music', clipKind: 'music', seed: 77 }, { rap, lib });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(calls.map((c) => c[0]), ['propose', 'generate'], 'no style/prompt → propose first');
  assert.equal(calls[1][1].style, 'village');
  assert.equal(calls[1][1].seed, 77);
  assert.equal(r.binding.subject_key, tag);

  calls.length = 0;
  const r2 = await gen.generateForSlot(pool, provider,
    { subjectKind: 'world', subjectKey: tag, slot: 'ambience', clipKind: 'ambience', style: 'forest', seed: 5 }, { rap, lib });
  assert.equal(r2.ok, true);
  assert.deepEqual(calls.map((c) => c[0]), ['generate'], 'an explicit style skips propose');

  const failing = { ...rap, generateTrack: async () => ({ ok: false, error: 'box busy', retryable: true }) };
  const r3 = await gen.generateForSlot(pool, provider,
    { subjectKind: 'world', subjectKey: tag, slot: 'music', clipKind: 'music', style: 'x', seed: 9 }, { rap: failing, lib });
  assert.deepEqual({ ok: r3.ok, retryable: r3.retryable }, { ok: false, retryable: true });
});
```

  Append to `backend/tests/audio_job_queue_db.test.js`:

```js
const q = require('../src/services/audioJobQueue');

test('audio job queue', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `jobq-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}%`]); }
    finally { await pool.end(); }
  });
  // Isolate from other files' jobs: this test only ever claims ITS rows, so
  // claimNext is exercised through a helper that retries past foreign rows.
  const claimMine = async () => {
    for (let i = 0; i < 50; i++) {
      const j = await q.claimNext(pool);
      if (!j) return null;
      if (j.subject_key.startsWith(tag)) return j;
      await pool.query("UPDATE audio_jobs SET state = 'queued', attempts = attempts - 1, claimed_at = NULL WHERE id = $1", [j.id]);
    }
    return null;
  };

  const r = await q.enqueue(pool, [
    { subject_kind: 'biome', subject_key: `${tag}-b`, slot: 'ambience', clip_kind: 'ambience' },
    { subject_kind: 'world', subject_key: `${tag}-w`, slot: 'music', clip_kind: 'music' },
    { subject_kind: 'world', subject_key: `${tag}-w`, slot: 'ambience', clip_kind: 'ambience' },
  ], { providerId: null });
  assert.equal(r.queued.length, 3);
  const again = await q.enqueue(pool, [{ subject_kind: 'world', subject_key: `${tag}-w`, slot: 'music', clip_kind: 'music' }], {});
  assert.equal(again.queued.length, 0);
  assert.deepEqual(again.already_live, [{ subject_kind: 'world', subject_key: `${tag}-w`, slot: 'music' }]);
  assert.throws(() => q.drainGroupFor('sfx'), /slice 3/);

  const first = await claimMine();
  assert.equal(first.drain_group, 'music', 'music drains before ambience even though it was enqueued second');
  assert.equal(first.attempts, 1);

  assert.equal(await q.fail(pool, first.id, 'box busy', { retryable: true }), 'retry');
  const row = (await pool.query('SELECT state, not_before FROM audio_jobs WHERE id = $1', [first.id])).rows[0];
  assert.equal(row.state, 'queued');
  assert.ok(row.not_before > new Date(), 'backoff pushes not_before into the future');

  const second = await claimMine();
  assert.equal(second.drain_group, 'ambience', 'the backed-off music job is not claimable yet');
  await q.complete(pool, second.id, null);

  const third = await claimMine();
  assert.equal(third.state, 'running');
  assert.equal(await q.requeueOrphans(pool) >= 1, true);
  const orphan = (await pool.query('SELECT state, attempts FROM audio_jobs WHERE id = $1', [third.id])).rows[0];
  assert.deepEqual(orphan, { state: 'queued', attempts: 0 }, 'orphaned running row re-queued with its attempt refunded');

  await pool.query("UPDATE audio_jobs SET attempts = $2 WHERE id = $1", [first.id, q.MAX_ATTEMPTS]);
  await pool.query("UPDATE audio_jobs SET state = 'running' WHERE id = $1", [first.id]);
  assert.equal(await q.fail(pool, first.id, 'still busy', { retryable: true }), 'failed', 'attempts exhausted → failed');
  assert.equal(await q.retryFailed(pool) >= 1, true);
  const retried = (await pool.query('SELECT state, attempts, not_before FROM audio_jobs WHERE id = $1', [first.id])).rows[0];
  assert.deepEqual(retried, { state: 'queued', attempts: 0, not_before: null });
});
```

- [ ] **Step 2: Run them and confirm they fail** (modules missing).

- [ ] **Step 3: Implement `audioGeneration.js`.**
  - Move `resolveAudioProvider`, `contextFor` and `boxTrackName` from audioRoutes.js verbatim, including their comments.
  - Then add:

```js
const crypto = require('node:crypto');
const defaultRap = require('./remoteAudioProvider');
const defaultLib = require('./audioLibrary');

function randomSeed() { return crypto.randomInt(1, 2 ** 31 - 1); }

// The one generate → store → bind path (spec §2). The synchronous
// /admin/generate route and the batch drain both call this, so a clip made
// either way has the same label, provenance columns and binding.
async function generateForSlot(db, provider, spec, { rap = defaultRap, lib = defaultLib } = {}) {
  const { subjectKind, subjectKey, slot, clipKind } = spec;
  let { style = null, prompt = null, slots = null } = spec;
  const seed = Number.isInteger(spec.seed) ? spec.seed : randomSeed();
  if (!style && !prompt) {
    const p = await rap.propose(provider, { context: await contextFor(db, subjectKind, subjectKey), kind: clipKind });
    if (p.ok) ({ style, slots, prompt } = { style: p.style, slots: p.slots, prompt: p.prompt });
  }
  const gen = await rap.generateTrack(provider, {
    kind: clipKind, name: boxTrackName(subjectKind, subjectKey, slot, seed), style, prompt, slots, seed,
  });
  if (!gen.ok) return { ok: false, error: gen.error, retryable: Boolean(gen.retryable) };
  const clip = await lib.storeClip(db, {
    buffer: gen.buffer, kind: clipKind, label: `${subjectKey} ${slot}${style ? ` (${style})` : ''}`,
    source: 'generated', providerId: provider.id ?? null, prompt: gen.prompt, styleOrCue: style,
    seed: gen.seed, durationMs: gen.durationMs, loopStartMs: gen.loopStartMs, loopEndMs: gen.loopEndMs,
  });
  const binding = await lib.bindClip(db, { subjectKind, subjectKey, slot, clipId: clip.id });
  return { ok: true, clip, binding, seed };
}

module.exports = { resolveAudioProvider, contextFor, boxTrackName, randomSeed, generateForSlot };
```

  The route's `/admin/generate` becomes:
  - `checkSubject` → sfx 400 → `resolveAudioProvider` (503)
  - → `generateForSlot(pool, provider, {subjectKind: b.subject_kind, ..., seed: Number.isInteger(b.seed) ? b.seed : undefined})`
  - → `!ok` → 502 `{error, retryable}`, else 201 `{clip, binding}`.

- [ ] **Step 4: Implement `audioJobQueue.js`**

```js
// backend/src/services/audioJobQueue.js
//
// The audio generation queue (spec §2 "Dispatcher"). Modelled on
// artJobQueue.js; the differences are deliberate:
//   * one job at a time, claimed in DRAIN_ORDER (music, then ambience) so the
//     GPU box switches model at most once per group;
//   * requeueOrphans runs at every drain start: a nodemon restart (ANY backend
//     edit) kills a running drain mid-job, and art's manual "requeue stale"
//     button is exactly the step people forget.
const DRAIN_ORDER = ['music', 'ambience'];
const MAX_ATTEMPTS = Number(process.env.AUDIO_JOB_MAX_ATTEMPTS) || 3;
const RETRY_BASE_MS = () => Number(process.env.AUDIO_JOB_RETRY_BASE_MS) || 30000;

function drainGroupFor(clipKind) {
  if (clipKind === 'music' || clipKind === 'ambience') return clipKind;
  throw new Error(`no drain group for ${clipKind} until slice 3 (sfx-pack)`);
}

function backoffMs(attempts) {
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(RETRY_BASE_MS() * 2 ** Math.max(0, attempts - 1) * jitter);
}

async function enqueue(db, items, { batchId = null, providerId = null } = {}) {
  const batch = batchId || (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  const cols = { kind: [], key: [], slot: [], clip: [], group: [], style: [], prompt: [], slots: [], seed: [] };
  for (const it of items) {
    cols.kind.push(it.subject_kind); cols.key.push(it.subject_key); cols.slot.push(it.slot);
    cols.clip.push(it.clip_kind); cols.group.push(drainGroupFor(it.clip_kind));
    cols.style.push(it.style || null); cols.prompt.push(it.prompt || null);
    cols.slots.push(it.slots ? JSON.stringify(it.slots) : null);
    cols.seed.push(Number.isInteger(it.seed) ? it.seed : null);
  }
  const r = await db.query(
    `INSERT INTO audio_jobs (batch_id, provider_id, subject_kind, subject_key, slot, clip_kind, drain_group,
                             style, prompt, slots, seed)
     SELECT $1, $2, k, key, s, c, g, st, pr, sl::jsonb, sd
       FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::bigint[])
         AS u(k, key, s, c, g, st, pr, sl, sd)
     ON CONFLICT DO NOTHING RETURNING *`,
    [batch, providerId, cols.kind, cols.key, cols.slot, cols.clip, cols.group, cols.style, cols.prompt, cols.slots, cols.seed],
  );
  const got = new Set(r.rows.map((j) => `${j.subject_kind}/${j.subject_key}/${j.slot}`));
  const already_live = items
    .filter((it) => !got.has(`${it.subject_kind}/${it.subject_key}/${it.slot}`))
    .map(({ subject_kind, subject_key, slot }) => ({ subject_kind, subject_key, slot }));
  return { batch_id: batch, queued: r.rows, already_live };
}

async function claimNext(db) {
  const r = await db.query(
    `UPDATE audio_jobs SET state = 'running', attempts = attempts + 1, claimed_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM audio_jobs
         WHERE state = 'queued' AND (not_before IS NULL OR not_before <= now())
         ORDER BY array_position($1::text[], drain_group), id
         FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`, [DRAIN_ORDER]);
  return r.rows[0] || null;
}

async function complete(db, id, clipId) {
  await db.query(
    `UPDATE audio_jobs SET state = 'done', clip_id = $2, last_error = NULL, updated_at = now() WHERE id = $1`,
    [id, clipId]);
}

async function fail(db, id, error, { retryable = false } = {}) {
  const row = (await db.query('SELECT attempts FROM audio_jobs WHERE id = $1', [id])).rows[0];
  const retry = retryable && row && row.attempts < MAX_ATTEMPTS;
  await db.query(
    `UPDATE audio_jobs SET state = $2, last_error = $3, updated_at = now(),
            not_before = CASE WHEN $2 = 'queued' THEN now() + ($4::int * interval '1 millisecond') ELSE NULL END
      WHERE id = $1`,
    [id, retry ? 'queued' : 'failed', String(error).slice(0, 2000), retry ? backoffMs(row.attempts) : 0]);
  return retry ? 'retry' : 'failed';
}

async function requeueOrphans(db) {
  const r = await db.query(
    `UPDATE audio_jobs SET state = 'queued', attempts = GREATEST(attempts - 1, 0), claimed_at = NULL, updated_at = now()
      WHERE state = 'running'`);
  return r.rowCount;
}

async function nextClaimableAt(db) {
  const r = await db.query(
    `SELECT min(COALESCE(not_before, now())) AS at FROM audio_jobs WHERE state = 'queued'`);
  return r.rows[0].at;
}

async function stats(db) {
  const r = await db.query(
    `SELECT drain_group, state, count(*)::int AS n,
            count(*) FILTER (WHERE state = 'queued' AND not_before > now())::int AS backoff
       FROM audio_jobs GROUP BY 1, 2`);
  const out = {};
  let backoff = 0;
  for (const g of DRAIN_ORDER) out[g] = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const row of r.rows) {
    out[row.drain_group] = out[row.drain_group] || { queued: 0, running: 0, done: 0, failed: 0 };
    out[row.drain_group][row.state] = row.n;
    backoff += row.backoff;
  }
  return { groups: out, backoff };
}

async function recent(db, limit = 50) {
  return (await db.query(
    `SELECT id, batch_id, subject_kind, subject_key, slot, drain_group, state, attempts, last_error, not_before,
            clip_id, updated_at
       FROM audio_jobs ORDER BY updated_at DESC, id DESC LIMIT $1`, [limit])).rows;
}

async function retryFailed(db) {
  return (await db.query(
    `UPDATE audio_jobs SET state = 'queued', attempts = 0, not_before = NULL, last_error = NULL, updated_at = now()
      WHERE state = 'failed'
        AND NOT EXISTS (SELECT 1 FROM audio_jobs l WHERE l.state IN ('queued','running')
                          AND l.subject_kind = audio_jobs.subject_kind AND l.subject_key = audio_jobs.subject_key
                          AND l.slot = audio_jobs.slot)`)).rowCount;
}

async function clear(db, { states = ['queued', 'failed', 'done'] } = {}) {
  const allowed = states.filter((s) => s === 'queued' || s === 'failed' || s === 'done');
  if (!allowed.length) return 0;
  return (await db.query('DELETE FROM audio_jobs WHERE state = ANY($1)', [allowed])).rowCount;
}

module.exports = {
  DRAIN_ORDER, MAX_ATTEMPTS, drainGroupFor, backoffMs, enqueue, claimNext, complete, fail,
  requeueOrphans, nextClaimableAt, stats, recent, retryFailed, clear,
};
```

  `retryFailed`'s NOT EXISTS guard stops a retry from colliding with a live job for the same slot on the unique index. If several failed rows exist for one slot, keep only the newest: before the UPDATE, delete older failed duplicates for the same slot. Add a test case for it.

- [ ] **Step 5: Run and confirm they pass:** `audio_generation_db`, `audio_job_queue_db`, `audio_routes_db`, `audio_box_track_name`. Exit `0`.

- [ ] **Step 6: Commit** `feat(audio): shared generate-store-bind path and the audio job queue (SOMET-NNN)`.

---

### Task 3: `audioDispatcher`

**Files:**
- Create: `backend/src/services/audioDispatcher.js`
- Test: `backend/tests/audio_dispatcher_db.test.js`

**Interfaces:**
- `startDrain(db, { deps } = {}) -> runStatus()`
  - Throws `err.code = 'ALREADY_RUNNING'` when a drain is live in this process.
  - Throws `err.code = 'NO_PROVIDER'` when no job can resolve a provider AND no audio provider is active.
- `stopDrain() -> runStatus()`
- `runStatus() -> { running, started_at, finished_at, done, failed, retried, current: {id, subject_kind, subject_key, slot, drain_group}|null, stopping, stopped_reason, error, requeued_orphans }`
- `__resetRun()` (test seam)
- `__setDeps(deps|null)` (test seam): sets the default `deps` used when `startDrain` is called without `deps`. The routes (Task 4) start drains without deps, so their test injects fakes this way. `null` restores the real modules.
- `startDrain` is a plain synchronous function: it sets `run` and kicks off the detached async loop before returning, so a second call in the same tick throws `ALREADY_RUNNING`.
- `deps`: `{ queue, generateForSlot, resolveAudioProvider, sleep, now }`. The defaults are the real modules and a `setTimeout` sleep.
- Loop behaviour:
  1. `requeueOrphans` first.
  2. Then repeat until stopped:
     - `claimNext`. Nothing claimable → if `nextClaimableAt` is in the future, sleep `min(wait, AUDIO_DRAIN_MAX_WAIT_MS default 60000)` in 1 s slices that notice `stopping`; if no queued job exists, finish with `stopped_reason: 'empty'`.
     - Resolve the job's provider: `job.provider_id` via `resolveAudioProvider`, else the active audio provider. None → `fail(..., 'no audio provider', {retryable:false})`.
     - `generateForSlot(db, provider, {subjectKind: job.subject_kind, subjectKey: job.subject_key, slot: job.slot, clipKind: job.clip_kind, style: job.style, prompt: job.prompt, slots: job.slots, seed: job.seed == null ? undefined : Number(job.seed)})`.
     - ok → `complete(job.id, clip.id)` and reset the consecutive-failure count.
     - Not ok → `fail(job.id, error, {retryable})` and count it.
     - A thrown exception is treated as retryable:false with the message.
  3. When `consecutiveFailures >= AUDIO_BREAKER_TRIP (default 3)`, stop with `stopped_reason: 'breaker'` and `error: <last error>`.

- [ ] **Step 1: Write the failing test.** It uses a real DB queue and fake generate/provider. The fake generate records the ORDER it saw (group sequence) and can be scripted to fail.

```js
// backend/tests/audio_dispatcher_db.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const q = require('../src/services/audioJobQueue');
const d = require('../src/services/audioDispatcher');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

async function waitIdle(timeoutMs = 10000) {
  const t0 = Date.now();
  while (d.runStatus().running) {
    if (Date.now() - t0 > timeoutMs) throw new Error('drain did not finish');
    await new Promise((r) => setTimeout(r, 20));
  }
  return d.runStatus();
}

test('audio dispatcher', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `disp-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_jobs WHERE subject_key LIKE $1', [`${tag}%`]); }
    finally { d.__resetRun(); await pool.end(); }
  });
  // Foreign queued jobs (another file) would be claimed too; park them for the
  // duration and restore after, touching only their not_before.
  const foreign = (await pool.query(
    `UPDATE audio_jobs SET not_before = now() + interval '1 hour' WHERE state = 'queued' AND not_before IS NULL
       AND subject_key NOT LIKE $1 RETURNING id`, [`${tag}%`])).rows.map((r) => r.id);
  t.after(async () => { if (foreign.length) await pool.query('UPDATE audio_jobs SET not_before = NULL WHERE id = ANY($1)', [foreign]); });

  const provider = { id: null, modality: 'audio' };
  const seen = [];
  const baseDeps = {
    resolveAudioProvider: async () => provider,
    sleep: async () => {},
    generateForSlot: async (db, p, spec) => { seen.push(`${spec.clipKind}:${spec.subjectKey}`); return { ok: true, clip: { id: null } }; },
  };

  await t.test('drains music before ambience and finishes empty', async () => {
    await q.enqueue(pool, [
      { subject_kind: 'biome', subject_key: `${tag}-a1`, slot: 'ambience', clip_kind: 'ambience' },
      { subject_kind: 'world', subject_key: `${tag}-m1`, slot: 'music', clip_kind: 'music' },
      { subject_kind: 'biome', subject_key: `${tag}-a2`, slot: 'ambience', clip_kind: 'ambience' },
      { subject_kind: 'world', subject_key: `${tag}-m2`, slot: 'music', clip_kind: 'music' },
    ], {});
    d.startDrain(pool, { deps: baseDeps });
    assert.throws(() => d.startDrain(pool, { deps: baseDeps }), (e) => e.code === 'ALREADY_RUNNING');
    const s = await waitIdle();
    assert.deepEqual(seen.map((x) => x.split(':')[0]), ['music', 'music', 'ambience', 'ambience']);
    assert.equal(s.done, 4);
    assert.equal(s.stopped_reason, 'empty');
  });

  await t.test('three consecutive failures trip the breaker; nothing is lost', async () => {
    d.__resetRun();
    seen.length = 0;
    await q.enqueue(pool, [1, 2, 3, 4].map((i) => ({ subject_kind: 'biome', subject_key: `${tag}-f${i}`, slot: 'ambience', clip_kind: 'ambience' })), {});
    const failing = { ...baseDeps, generateForSlot: async () => ({ ok: false, error: 'box asleep', retryable: true }) };
    d.startDrain(pool, { deps: failing });
    const s = await waitIdle();
    assert.equal(s.stopped_reason, 'breaker');
    assert.match(s.error, /box asleep/);
    const rows = (await pool.query(`SELECT state FROM audio_jobs WHERE subject_key LIKE $1`, [`${tag}-f%`])).rows;
    assert.equal(rows.length, 4, 'no job deleted');
    assert.ok(rows.every((r) => r.state === 'queued'), 'retryable failures went back to the queue with backoff');
  });

  await t.test('an orphaned running row is re-queued at start', async () => {
    d.__resetRun();
    await pool.query(`UPDATE audio_jobs SET not_before = NULL WHERE subject_key LIKE $1`, [`${tag}-f%`]);
    await pool.query(`UPDATE audio_jobs SET state = 'running', attempts = 1 WHERE subject_key = $1`, [`${tag}-f1`]);
    d.startDrain(pool, { deps: baseDeps });
    const s = await waitIdle();
    assert.ok(s.requeued_orphans >= 1);
    const f1 = (await pool.query(`SELECT state FROM audio_jobs WHERE subject_key = $1`, [`${tag}-f1`])).rows[0];
    assert.equal(f1.state, 'done');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement `audioDispatcher.js`** as specified in Interfaces:
  - a module-level `run` object;
  - `startDrain` sets it synchronously before the async loop starts (so the second call throws);
  - the loop runs in a detached `(async () => { ... })()` with a top-level try/catch that records `error` and `finished_at`;
  - `stopDrain` sets `stopping = true` and the loop checks it before every claim;
  - `current` is set while a job runs;
  - `sleep` must be injectable and sliced to notice stop.

  Mirror the style and comments of artDispatcher.js, and name why each rule exists (restart recovery, breaker, one-at-a-time GPU).

- [ ] **Step 4: Run and confirm it passes** (exit `0`).
- [ ] **Step 5: Commit** `feat(audio): batch drain -- grouped order, backoff, breaker, orphan recovery (SOMET-NNN)`.

---

### Task 4: Job routes

**Files:**
- Modify: `backend/src/api/audioRoutes.js`
- Test: `backend/tests/audio_jobs_routes_db.test.js`

**Interfaces** (all adminGuard):
- `POST /api/audio/admin/jobs` → 201 `{ batch_id, queued, already_live, rejected }`
  - Body: `{ items: [{subject_kind, subject_key, slot, style?, prompt?}], provider_id?, start?: boolean }`.
  - `items` must be an array of 1–500 entries.
  - Each item goes through `checkSubject`. A failing item goes to `rejected: [{item, error}]`; sfx slots are rejected with `'sfx batches arrive in slice 3'`.
  - `provider_id` must resolve via `resolveAudioProvider` or it is a 400.
  - `start: true` also calls `startDrain`; ALREADY_RUNNING is fine, since the running drain will pick the jobs up.
- `GET /api/audio/admin/jobs` → `{ run: runStatus(), stats, recent }`
- `POST /api/audio/admin/jobs/dispatch` → 202 runStatus | 409 ALREADY_RUNNING | 503 when no audio provider is active and none is pinned
- `POST /api/audio/admin/jobs/stop` → 200 runStatus
- `POST /api/audio/admin/jobs/retry-failed` → `{ requeued }`
- `POST /api/audio/admin/jobs/clear` body `{ states?: ['queued','failed','done'] }` → `{ cleared }`; 409 while a drain runs (queued rows would race the claim)

- [ ] **Step 1: Write the failing route test.**
  - Real scratch DB, admin + player users created per run (the pattern from `audio_routes_db.test.js`).
  - The drain runs with `audioDispatcher.__setDeps(fakeDeps)`: add this test seam in Task 3's module so the route-started drain uses fakes.
  - Assertions:
    - a player gets 403 on every jobs route;
    - enqueue with one valid item, one unknown subject and one duplicate → queued 1, rejected 1, `already_live` 1 on a second call;
    - `start:true` returns and the run finishes (poll `GET /jobs` until `run.running === false`), leaving the job `done`;
    - `clear` while running → 409; `clear` after → count;
    - `retry-failed` re-queues a failed row.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement** the routes (validation first, inside try; 400/409/503 exactly as above).
- [ ] **Step 4: Run and confirm it passes**, together with every audio test file.
- [ ] **Step 5: Commit** `feat(audio): batch job routes (SOMET-NNN)`.

---

### Task 5: Library, bind-from-library, object deletion

**Files:**
- Modify: `backend/src/services/assetStore.js`, `backend/src/services/audioLibrary.js`, `backend/src/api/audioRoutes.js`
- Test: `backend/tests/audio_library_routes_db.test.js`

**Interfaces:**
- `assetStore.removeObject(key)`: resolves when removed or already missing; other errors throw.
- `audioLibrary.listClips(db, { kind?, unbound?: boolean, limit=50, offset=0 }) -> { rows: [clip + binding_count], total }`
- `audioLibrary.deleteClip(db, id, { store = assetStore }) -> { deleted: boolean, bindings: n }`: deletes the row, which cascades to bindings, then calls `store.removeObject(storage_key)`. An object-removal failure is logged, not thrown; the row is already gone.
- `audioLibrary.deleteUnboundClips(db, { kind?, store }) -> { deleted: n }`
- Routes:
  - `GET /api/audio/admin/clips?kind=&unbound=1&limit=&offset=`
  - `DELETE /api/audio/admin/clips/:id` → `{ deleted, bindings }`
  - `POST /api/audio/admin/clips/delete-unbound` `{ kind? }`
  - `POST /api/audio/admin/bindings` `{ subject_kind, subject_key, slot, clip_id }`: `checkSubject` + `bindClip` (kind mismatch → 400) → 201

- [ ] **Step 1: Write failing tests** (fake asset client recording `removeObject` calls):
  - list filters by kind and unbound;
  - delete removes the object and reports the binding count;
  - `delete-unbound` never touches a bound clip;
  - bind-from-library binds an existing clip to a second subject and rejects a kind mismatch;
  - a player gets 403.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** `removeObject` uses `getClient().removeObject(BUCKET(), key)` and treats `NoSuchKey`/`NotFound` as success.
- [ ] **Step 4: Run and confirm they pass**, plus `assets_route.test.js`.
- [ ] **Step 5: Commit** `feat(audio): clip library, bind from library, delete removes the object (SOMET-NNN)`.

---

### Task 6: Frontend — batch mode + library view

**Files:**
- Create: `audioBatch.js`, `AudioBatchPanel.jsx`, `AudioLibrary.jsx`, `__tests__/audioBatch.test.js`
- Modify: `useAudioAdmin.js`, `AudioAdmin.jsx`, `AudioSlotCard.jsx`

**Interfaces:**
- `audioBatch.js` (pure):
  - `buildBatchItems(selectedSubjects: Set<'kind/key'>, slotChoice: {[kind]: Set<slot>}, subjectsResponse) -> [{subject_kind, subject_key, slot}]`
    - Only slots that exist for the kind; SFX slots excluded; deduped; stable order (kind, key, slot).
  - `itemsFromMisses(missRows) -> items` (music/ambience slots only)
  - `mergeItems(a, b)` (dedupe by kind/key/slot)
  - `batchProgress({ run, stats }) -> { phase: 'idle'|'queued'|'running'|'finished'|'stopped', done, failed, queued, running, total, pct, group: 'music'|'ambience'|null, backoff }`
    - `group` = the group currently running, else the first group with queued jobs.
  - `shouldPoll({ run, stats }) -> boolean`: true while running, or queued > 0.
- Hooks in `useAudioAdmin.js` (all with `authHeaders()`):
  - `useAudioJobs()`: query `['audio-jobs']`, `refetchInterval: (q) => shouldPoll(q.state.data) ? 2000 : false`
  - `useEnqueueAudioJobs()` → POST /admin/jobs `{items, start: true}`; invalidates `['audio-jobs']`
  - `useStartAudioDrain`, `useStopAudioDrain`, `useRetryAudioFailures`, `useClearAudioJobs`
  - `useAudioClips({kind, unbound, page})`, `useDeleteClip()`, `useDeleteUnboundClips()`, `useBindFromLibrary()`
  - Every mutation that changes bindings invalidates `['audio-slots', …]`, `['audio-subjects']` and `['audio-misses']`.
  - When a drain finishes (phase changes to finished/stopped), `AudioBatchPanel` invalidates `['audio-subjects']` and `['audio-misses']` once, so badges update.

- [ ] **Step 1: Write the failing pure tests.**

```js
import { describe, it, expect } from 'vitest';
import { buildBatchItems, itemsFromMisses, mergeItems, batchProgress, shouldPoll } from '../audioBatch.js';

const subjects = [
  { kind: 'world', slots: { music: 'music', ambience: 'ambience' }, subjects: ['Vale', 'Ash'] },
  { kind: 'biome', slots: { ambience: 'ambience' }, subjects: ['Meadow'] },
];

describe('audioBatch', () => {
  it('builds kind×slot items for the ticked subjects only, deduped and ordered', () => {
    const items = buildBatchItems(new Set(['world/Vale', 'biome/Meadow', 'biome/Nope']),
      { world: new Set(['music', 'ambience']), biome: new Set(['ambience', 'music']) }, subjects);
    expect(items).toEqual([
      { subject_kind: 'biome', subject_key: 'Meadow', slot: 'ambience' },
      { subject_kind: 'world', subject_key: 'Vale', slot: 'ambience' },
      { subject_kind: 'world', subject_key: 'Vale', slot: 'music' },
    ]);
  });
  it('takes only music/ambience misses and merges without duplicates', () => {
    const m = itemsFromMisses([{ subject_kind: 'biome', subject_key: 'Meadow', slot: 'ambience' },
      { subject_kind: 'creature', subject_key: 'Slime', slot: 'hurt' }]);
    expect(m).toEqual([{ subject_kind: 'biome', subject_key: 'Meadow', slot: 'ambience' }]);
    expect(mergeItems(m, m)).toHaveLength(1);
  });
  it('reports progress and the group being drained', () => {
    const stats = { groups: { music: { queued: 0, running: 1, done: 2, failed: 0 }, ambience: { queued: 3, running: 0, done: 0, failed: 1 } }, backoff: 0 };
    const p = batchProgress({ run: { running: true }, stats });
    expect(p).toMatchObject({ phase: 'running', done: 2, failed: 1, queued: 3, running: 1, total: 7, group: 'music' });
    expect(shouldPoll({ run: { running: false }, stats })).toBe(true);
    expect(shouldPoll({ run: { running: false }, stats: { groups: {}, backoff: 0 } })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Implement** `audioBatch.js`, the hooks, and the UI:
  - **`AudioAdmin`:**
    - a "Batch" toggle adds a checkbox per subject row plus "select all visible";
    - a slot chooser per kind (Worlds: Music / Ambience; Biomes: Ambience), with an optional style override (a select filled from the active audio provider's `models_cache` minus `cue:` entries; blank means Suggest per subject);
    - "Queue N jobs" → `useEnqueueAudioJobs`;
    - the Missing sounds list gains checkboxes plus "Add to batch" (music/ambience rows only, others disabled with the tooltip "SFX batches arrive in slice 3").
  - **`AudioBatchPanel`** (shown whenever `stats` has any job):
    - one progress bar;
    - per-group counts in DRAIN_ORDER, with the running group highlighted;
    - the current job;
    - Start / Stop / Retry failed / Clear finished;
    - the last 10 failures with `last_error`;
    - the breaker message when `stopped_reason === 'breaker'`.
  - **Library tab `AudioLibrary`:**
    - kind filter and "unbound only";
    - rows with play (the shared preview), label, kind, duration, size, binding count, delete (confirm text includes the binding count);
    - "Delete all unbound (N)".
  - **`AudioSlotCard`:** "+ From library" opens a small picker listing clips of the slot's clip kind → `useBindFromLibrary`.
  - Follow `ArtConsoleAdmin` styling tokens. Keep each new component under ~300 lines.

- [ ] **Step 4: Run the tests and confirm they pass:** `cd frontend && npx vitest run` (only progressionExtras may fail). Run eslint on the touched files: no new errors.
- [ ] **Step 5: Commit** `feat(admin): audio batch mode, progress panel and clip library (SOMET-NNN)`.

---

### Task 7: Sounds sections in the world and biome editors

**Files:**
- Create: `SubjectSounds.jsx`
- Modify: `AudioAdmin.jsx`, `MapsAdmin.jsx` (MapCard, before its closing `</Card>` ~line 390), `BiomesAdmin.jsx` (BiomeCard, before `</Card>` ~line 117)

**Interfaces:**
- `SubjectSounds({ kind, subjectKey, compact })`:
  - renders one `AudioSlotCard` per slot for that subject;
  - owns its own `useAudioPreview` (moved from AudioAdmin.jsx into `useAudioPreview.js` if AudioAdmin exports it only locally);
  - the slots come from `useAudioSubjects()`.
- `AudioAdmin` uses it for the selected subject (no behaviour change).
- MapCard passes `kind="world"`, `subjectKey={world.name}` (the SAVED name, not the editable local state).
- BiomeCard renders it only when `!isNew`, with `subjectKey={biome.name}`.

- [ ] **Step 1: Write a failing test** that pins the one piece of logic: a pure `subjectSlotsFor(subjectsResponse, kind) -> [{slot, clipKind}]` in `audioBatch.js`, returning `[]` for an unknown kind. The component is a thin render over it.
- [ ] **Step 2–4:** implement, run `npx vitest run`, lint.
- [ ] **Step 5: Commit** `feat(admin): Sounds sections in the world and biome editors (SOMET-NNN)`.

---

### Task 8: `make audio-export` / `make audio-seed`

**Files:**
- Create: `backend/src/services/audioSeed.js`, `backend/scripts/export-audio.js`, `backend/scripts/seed-audio.js`
- Modify: `backend/src/services/artSeed.js` (add `matchOwner`, `readObject` to `module.exports`), `backend/src/services/audioLibrary.js` (`storeClip` accepts optional `id`), `Makefile`
- Test: `backend/tests/audio_seed_db.test.js`

**Interfaces:**
- `AUDIO_SEEDS_ROOT = backend/seeds/audio`
- `exportAudio({ db, store, root = AUDIO_SEEDS_ROOT, kinds = ['music','ambience','sfx'], only = null, log }) -> { [kind]: { exported, bytes, missing: [] } }`
  - Only clips with ≥1 binding.
  - `only` = subject names: exports those subjects' bound clips and MERGES the manifests (keeps other entries).
  - Writes `<root>/<kind>/<slug(label)>-<id first 8>.ogg`, where `slug` = `safeName` from artSeed.
  - Writes `<root>/clips.json`: an array sorted by id of `{id, kind, label, file: '<kind>/<name>.ogg', bytes, duration_ms, loopable, loop_start_ms, loop_end_ms, prompt, style_or_cue, engine, seed}`.
  - Writes `<root>/bindings.json`: an array sorted by `(subject_kind, subject_key, slot, clip_id)` of `{subject_kind, subject_key, slot, clip_id, volume, weight, sort}`.
  - `matchOwner` is applied to every file and directory it creates, with `backend/seeds` as the reference.
  - Logs total bytes written.
- `seedAudio({ db, store, root, kinds, only, force, log }) -> { clips: { linked, skipped, missingFile }, bindings: { bound, skipped, missingSubject: [] } }`
  - For each clip in clips.json whose kind is in `kinds`: a row with that id already exists and `!force` → skipped.
  - Otherwise read the file (missing → `missingFile`), then `store.putObject('audio/<kind>/<id>.ogg', buf, 'audio/ogg')`, then upsert the row with that id and `source = 'seeded'` (force → UPDATE the provenance columns).
  - Then each binding whose clip was seeded or already present: `subjectExists` false → `missingSubject` (logged, skipped); else INSERT … ON CONFLICT DO NOTHING (`bound` counts inserts only).
  - `only` limits both files to those subject names.
- `parseArgs(argv)`: `--kind=music,ambience`, `--only=a,b`, `--force`; unknown kind → throws.
- Makefile (next to art-export, with a usage comment in the same style):

```make
audio-export:
	$(COMPOSE) exec -T backend node scripts/export-audio.js \
		$(if $(KIND),--kind="$(KIND)") $(if $(ONLY),--only="$(ONLY)")

audio-seed:
	$(COMPOSE) exec -T backend node scripts/seed-audio.js \
		$(if $(KIND),--kind="$(KIND)") $(if $(ONLY),--only="$(ONLY)") $(if $(FORCE),--force)
```

  Add both to `.PHONY`.

- [ ] **Step 1: Write the failing round-trip test** on the scratch DB with a tmp dir and an in-memory store (a `Map` of key → Buffer implementing `getObjectStream`, `putObject`, `objectExists`):
  1. Create a world + biome and 3 clips: one bound to the world, one bound to the biome, one unbound.
  2. `exportAudio`: assert 2 files, correct names, manifests sorted, the unbound clip absent.
  3. Delete the clip and binding rows AND the world (simulating a fresh DB where the world was renamed).
  4. `seedAudio`: clips linked 2; bindings bound 1 (biome); `missingSubject` lists the world binding; objects written at `audio/<kind>/<id>.ogg`.
  5. Run `seedAudio` again: everything skipped / bound 0.
  6. `force`: linked 2 again.
  7. Remove one .ogg file: `missingFile` 1, no throw.
  8. `parseArgs(['--kind=drums'])` throws.
  9. Clean up only your own rows and the tmp dir.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement** audioSeed.js and the two scripts, as thin wrappers exactly like export-art.js / seed-art.js (dotenv from `../../.env`, Pool, summary print, `pool.end()`).
- [ ] **Step 4: Run and confirm it passes**, plus `art_seed_policy.test.js` (artSeed exports changed).
- [ ] **Step 5: Commit** `feat(audio): make audio-export / audio-seed with idempotent clip ids (SOMET-NNN)`.

---

### Task 9: Parked slice-1 provider hygiene

**Files:**
- Modify: `backend/src/index.js` (`POST /api/ai-providers/:id/test` ~2820; the provider-pin validator in `backend/src/services/providerPin.js` or wherever `providerPinError` lives), `backend/src/services/remoteAudioProvider.js` (`callJson` error detail), `frontend/src/games/something2/SettingsAdmin.jsx` (modality select disabled when editing)
- Tests: extend `ai_providers.test.js`, `remote_audio_provider.test.js` and the pin test file (find it with `grep -l providerPinError backend/tests`)

- [ ] **Step 1: Write failing tests:**
  - the audio provider Test route calls `listStyles` (fake box: 401 on `/api/audio/styles` → `{ok:false, status:401}` even though `/` answers 200);
  - pinning a tile/entity type to an audio provider id → 400 "not an image provider";
  - a non-2xx box response includes the box's `detail` text, via `safeFetch.errorDetail`, never the token.
- [ ] **Step 2–4:** implement; run those files plus all audio files; frontend lint.
  - In SettingsAdmin, render the modality as the existing read-only span when editing, instead of an enabled select.
- [ ] **Step 5: Commit** `fix(ai-providers): audio Test probes styles, pins refuse audio ids, box error detail (SOMET-NNN)`.

---

### Task 10: Suites, live batch, git round trip, docs

**Files:**
- Modify: `docs/ai-providers.md`. Replace "Slice 1 limit: synchronous generation" with "Batch generation" (queue, drain order, breaker, restart recovery) and "Export and seed" (commands, layout, `--only`, `--force`, missing-subject report).

- [ ] **Step 1: Full backend suite on a FRESH fully seeded scratch DB.** It is green only if the failing-file set equals the 7-file baseline.
  - If extra files fail, run them alone twice and in a second full run before calling them intermittent. The two art-job files are known to interfere across files.
- [ ] **Step 2: Frontend** `npx vitest run`: only progressionExtras may fail.
- [ ] **Step 3: Isolated stack**, as in slice 1:
  - backend on :13201 against the slice-2 scratch DB (source the main `.env`; rewrite the redis/minio hosts to localhost:16379 / 19000; `PORT=13201`);
  - vite on :15273 with a throwaway `vite.verify.config.mjs` added to `.git/info/exclude`, deleted afterwards;
  - kill both by PID file at the end.
- [ ] **Step 4: Live batch on the GPU box** (only when `GET /api/model-gateway` shows nothing pending; ask for a box key if none is stored):
  1. Register an audio provider with a key the user supplies (never commit it).
  2. Queue 2 ambience (two biomes) + 1 music (one world) with `start: true`.
  3. Poll `GET /admin/jobs`.
  4. Record: the order the three ran in (music first); total wall time; that `stats` ends with 3 done.
  5. Record the box's `model-gateway` `active.model` before and after, to confirm at most one switch per group.
- [ ] **Step 5: Git round trip:**
  1. `node scripts/export-audio.js` against the scratch DB, with the store pointed at MinIO. Confirm `backend/seeds/audio/{clips,bindings}.json` and 3 `.ogg` files, and record the bytes.
  2. Create another fresh scratch DB, migrate + seed-catalogs + seed-map, then `node scripts/seed-audio.js`. Confirm 3 clips linked, 3 bindings bound, 0 missing.
  3. Start the isolated backend against THAT DB, log in as a player, and confirm `window.__s2audio()` shows the seeded music playing.
- [ ] **Step 6: Browser UI check (admin):**
  - batch mode queues from ticked subjects;
  - the progress panel moves through groups;
  - Stop halts after the current job;
  - Library lists and deletes an unbound clip (the object is gone from MinIO);
  - "+ From library" binds;
  - the world editor (Maps) and biome editor show Sounds.
- [ ] **Step 7: Commit the exported seed files?** No. The exported clips are the user's content decision: leave `backend/seeds/audio/` UNCOMMITTED and report it; the user decides what goes into git.
  - Commit only the docs: `docs: audio batch generation and export/seed (SOMET-NNN)`.
- [ ] **Step 8: Finish** with `superpowers:finishing-a-development-branch`. Drop the scratch DBs only after the merge is verified.
