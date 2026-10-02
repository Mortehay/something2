# Game Audio — Slice 1 (world music + biome ambience, end to end) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin generates or uploads music and ambience clips for a world or
biome in a new Audio tab. The game plays the world's music plus the ambience of
the biome under the player, with volume controls, and logs every sound it
wanted but did not have.

**Architecture:**
- **Box connection:** a new `audio` modality on `ai_providers` plus a
  hand-written adapter (`remoteAudioProvider.js`) for the GPU box's audio API.
- **Storage:** clips go to MinIO as OGG and are recorded in `audio_clips`;
  `audio_bindings` attaches any number of clips to a (subject, slot).
  `audioSubjects.js` is the code registry of subject kinds and slots.
- **Playback:** the client loads a world's bindings on join and plays them
  through a small Web Audio `AudioEngine` (music and ambience buses under a
  master bus).
- **Biome under the player:** read from a coarse per-chunk biome grid that the
  chunk route now returns.

**Tech Stack:**
- backend: Node/Express (CommonJS), raw `pg`, `node:test` + supertest, MinIO via
  `assetStore`, node-pg-migrate
- frontend: React 19 + TanStack Query + styled-components, plain Web Audio,
  vitest (node env)

**Spec:** [docs/superpowers/specs/2026-09-28-game-audio-design.md](../specs/2026-09-28-game-audio-design.md).
Read sections 1–3 and "Box contract, measured 2026-09-28" before starting.
Slices 2 (batch + git export/seed) and 3 (creature and combat SFX) get their own
plans after this one is browser-verified.

## Global Constraints

- **Format:** OGG only. Store the box's OGG Vorbis as delivered; never store
  WAV, never call `?master=true`, never re-encode.
- **Keys:** bindings key subjects by **name** (`worlds.name`, `biomes.name`),
  never by DB id.
- **Size caps:** music/ambience 8 MB, SFX 1 MB.
- **Auth:**
  - the box token is write-only: `serializeProvider` strips it on every read;
  - use `loadProviderWithSecret` / `loadActiveProviderWithSecret` server-side
    only;
  - every `/api/audio/admin/*` route uses `adminGuard`; the two player routes
    use `playerGuard`.
- **Outbound calls:** every call to the box goes through `safeFetch` +
  `readCapped`/`readJsonCapped` + `providerDiscovery.authHeaders`.
- **Seeds:** every generation sends an explicit seed, random unless the admin
  set one. The box caches by request.
- **Image isolation:** image generation must never pick an audio provider.
- **Tests:**
  - DB tests are gated on `TEST_DATABASE_URL`: `skip` when unset. Run them with
    `TEST_DATABASE_URL` **and** `DATABASE_URL` both pointing at a per-branch
    scratch DB. **Never** point them at the shared dev DB, never run
    `DELETE`/`TRUNCATE` against catalog tables, and clean up only rows the test
    created.
  - A backend test run is green only if `npm test; echo $?` prints `0`. Also
    grep for `^not ok` and `testTimeoutFailure`.
- **Commits:**
  - work in a worktree on branch `feat/game-audio-slice1`, never in the shared
    main checkout;
  - subject `type(scope): summary (SOMET-NNN)` (ticket numbers come from the
    Plane tickets created at execution start);
  - end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Migrations:** use the timestamp `1714440560000` (headroom above
  main's `1714440548000`). Before running it, re-check that no other branch has
  taken it.

## Review Focus

1. **An admin activates the audio provider while an image provider is active.**
   Both stay active, and the next tile/entity job still uses the image one.
   Pinned in Task 2 (DB test) and Task 12 (UI `activeProvider` filter).
2. **The box answers with a WAV, HTML, an empty body or a 30 MB file** (wrong
   endpoint, error page, `master=true` by mistake). The clip is rejected with a
   readable error and nothing is written to MinIO or the DB. Pinned in Task 4
   and Task 5.
3. **A world whose biomes have no ambience, or a world with no bindings at
   all.** There's silence and no exception; the miss is logged once per session
   per slot, not once per frame. Pinned in Task 9 (lookup + miss dedupe) and
   Task 10 (engine with an empty bindings map).
4. **The player walks along a biome border, crossing every few hundred ms.**
   Ambience does not restart repeatedly; the switch happens only after 1.5 s of
   the new biome. Pinned in Task 9 (`BiomeTracker` hysteresis).
5. **localStorage throws** (private window, blocked storage). The game starts
   with default volumes and the Sound tab still works for the session. Pinned in
   Task 9 (`audioSettings`).

---

## File map

**Backend (create):**
- `backend/migrations/1714440560000_audio_catalog.js`: `modality`,
  per-modality active index, `audio_clips`, `audio_bindings`, `audio_misses`
- `backend/src/services/oggInfo.js`: pure OGG checks (magic, sample rate,
  duration)
- `backend/src/services/remoteAudioProvider.js`: box adapter (`listStyles`,
  `propose`, `generateTrack`)
- `backend/src/services/audioSubjects.js`: subject/slot registry (slice 1:
  `world`, `biome`)
- `backend/src/services/audioLibrary.js`: clips, bindings, misses, world
  bindings bundle
- `backend/src/api/audioRoutes.js`: `/api/audio/*` router
- tests: `backend/tests/audio_catalog_db.test.js`, `ogg_info.test.js`,
  `remote_audio_provider.test.js`, `audio_library_db.test.js`,
  `audio_routes_db.test.js`, `chunk_biome_grid.test.js`
- fixtures: `backend/tests/fixtures/audio/{tone.ogg,tone.wav}`

**Backend (modify):**
- `backend/src/services/aiProviders.js`: modality field, per-modality
  activation and active lookup
- `backend/src/services/worldGenService.js:67-72`: image-only provider pick
- `backend/src/services/mapService.js`: `chunkBiomeGrid` export
- `backend/src/index.js`: mount the router, `.ogg` content type, refresh-models
  branch for audio, chunk route `biomes`
- `backend/tests/ai_providers.test.js`: modality tests

**Frontend (create):**
- `frontend/src/games/something2/src/js/audio/audioLookup.js`: pure chain
  resolution + weighted pick
- `.../audio/biomeTracker.js`: pure hysteresis
- `.../audio/missLog.js`: dedupe + flush
- `.../audio/audioSettings.js`: localStorage volumes
- `.../audio/AudioEngine.js`: Web Audio buses, music rotation, ambience
  crossfade
- `.../audio/audioClient.js`: fetch bindings, post misses
- `.../audio/__tests__/*.test.js`
- `frontend/src/games/something2/AudioAdmin.jsx`,
  `frontend/src/games/something2/useAudioAdmin.js`

**Frontend (modify):**
- `.../src/js/core/ChunkedMap.js`: store the per-chunk biome grid, `biomeAt`
- `.../src/js/net/chunkFetcher.js`, `.../src/js/net/ChunkStreamer.js`: carry
  `biomes`
- `.../src/js/core/Game.js`: engine lifecycle (`initChunked`, `update`,
  `destroy`)
- `frontend/src/games/something2/GameSettings.jsx`: Sound tab
- `frontend/src/games/something2/SettingsAdmin.jsx`: modality select
- `frontend/src/games/something2/useAiProviders.js`: image-only
  `activeProvider`
- `frontend/src/App.jsx`, `frontend/src/ui/navSections.js`,
  `frontend/src/ui/__tests__/navSections.test.js`: Audio route
- `docs/ai-providers.md`: audio provider section

---

### Task 0: Worktree, scratch DB, tickets

**Files:** none (setup)

- [ ] **Step 1: Create an isolated worktree.** Several sessions share the main
  checkout, so never branch or check out there.

```bash
cd /home/markunn/worker/coding/jsgame/something2
git worktree add ../something2-audio -b feat/game-audio-slice1 main
cd ../something2-audio
```

- [ ] **Step 2: Create a scratch DB for this branch and migrate it.**

```bash
docker compose -f compose/develop/docker-compose.yml exec -T db \
  psql -U postgres -c "CREATE DATABASE game_audio_s1 TEMPLATE template0;"
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:15432/game_audio_s1
export DATABASE_URL=postgres://postgres:postgres@localhost:15432/game_audio_s1
cd backend && npm run migrate:up && cd ..
```

  - If the compose file, credentials or port differ, read them from
    `compose/develop/docker-compose.yml` and `.ai/commands.md`.
  - Do not guess, and do not fall back to the dev DB.
  - Set both variables on **separate** `export` lines. `export A=.. B="$A"`
    leaves B empty.

- [ ] **Step 3: Create Plane tickets** with the `plane-workflow` skill: one
  parent "Game audio — slice 1" under the audio epic, plus one child per task
  1–13. Use their SOMET numbers in commit subjects.

---

### Task 1: Migration — modality + audio tables

**Files:**
- Create: `backend/migrations/1714440560000_audio_catalog.js`
- Test: `backend/tests/audio_catalog_db.test.js`

**Interfaces:**
- Produces:
  - column `ai_providers.modality text NOT NULL DEFAULT 'image' CHECK (modality IN ('image','audio'))`
  - index `ai_providers_single_active_per_modality` (unique on `modality` WHERE `is_active`)
  - tables `audio_clips`, `audio_bindings`, `audio_misses`, with the columns below

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/audio_catalog_db.test.js
// Schema guards for the audio catalog (spec §1). Gated on TEST_DATABASE_URL:
// this file inserts rows, so it must never touch the shared dev DB.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('audio catalog schema', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const providers = [];
  const clips = [];
  t.after(async () => {
    try {
      if (clips.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clips]);
      if (providers.length) await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [providers]);
      await pool.query("DELETE FROM audio_misses WHERE subject_key LIKE 'schema-test-%'");
    } finally { await pool.end(); }
  });
  const tag = `${process.pid}-${Date.now()}`;
  const insertProvider = async (name, modality) => {
    const r = await pool.query(
      `INSERT INTO ai_providers (name, base_url, request_template, modality)
       VALUES ($1, 'http://127.0.0.1:9/', '{}'::jsonb, $2) RETURNING id`, [name, modality]);
    providers.push(r.rows[0].id);
    return r.rows[0].id;
  };

  await t.test('existing rows default to image, bad modality rejected', async () => {
    const id = await insertProvider(`schema-img-${tag}`, 'image');
    const r = await pool.query('SELECT modality FROM ai_providers WHERE id = $1', [id]);
    assert.equal(r.rows[0].modality, 'image');
    await assert.rejects(insertProvider(`schema-bad-${tag}`, 'video'), /check constraint/i);
  });

  await t.test('one active per modality, not one active overall', async () => {
    // Clear only OUR rows' activity; never touch rows this test did not make.
    const img = await insertProvider(`schema-a-img-${tag}`, 'image');
    const aud = await insertProvider(`schema-a-aud-${tag}`, 'audio');
    const aud2 = await insertProvider(`schema-a-aud2-${tag}`, 'audio');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE ai_providers SET is_active = false WHERE is_active');
      await client.query('UPDATE ai_providers SET is_active = true WHERE id = ANY($1)', [[img, aud]]);
      await assert.rejects(
        client.query('UPDATE ai_providers SET is_active = true WHERE id = $1', [aud2]),
        /duplicate key/i,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  await t.test('clips: kind check, bindings unique + cascade', async () => {
    const c = await pool.query(
      `INSERT INTO audio_clips (kind, label, storage_key, bytes, duration_ms, source)
       VALUES ('ambience', 'schema test', $1, 10, 1000, 'uploaded') RETURNING id`,
      [`audio/ambience/schema-${tag}.ogg`]);
    const clipId = c.rows[0].id;
    clips.push(clipId);
    await assert.rejects(pool.query(
      `INSERT INTO audio_clips (kind, label, storage_key, bytes, duration_ms, source)
       VALUES ('noise', 'x', $1, 1, 1, 'uploaded')`, [`audio/x/${tag}.ogg`]), /check constraint/i);

    const bind = () => pool.query(
      `INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id)
       VALUES ('biome', $1, 'ambience', $2)`, [`schema-test-${tag}`, clipId]);
    await bind();
    await assert.rejects(bind(), /duplicate key/i);

    await pool.query('DELETE FROM audio_clips WHERE id = $1', [clipId]);
    const left = await pool.query('SELECT 1 FROM audio_bindings WHERE clip_id = $1', [clipId]);
    assert.equal(left.rowCount, 0, 'deleting a clip removes its bindings');
  });

  await t.test('misses keyed by subject + slot', async () => {
    const ins = () => pool.query(
      `INSERT INTO audio_misses (subject_kind, subject_key, slot, world)
       VALUES ('biome', $1, 'ambience', 'w') ON CONFLICT (subject_kind, subject_key, slot)
       DO UPDATE SET count = audio_misses.count + 1 RETURNING count`, [`schema-test-${tag}`]);
    assert.equal((await ins()).rows[0].count, 1);
    assert.equal((await ins()).rows[0].count, 2);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**
  Run: `cd backend && node --test tests/audio_catalog_db.test.js; echo $?`
  Expected: failures such as `column "modality" does not exist`; exit code non-zero.

- [ ] **Step 3: Write the migration**

```js
// backend/migrations/1714440560000_audio_catalog.js
exports.shorthands = undefined;

// Game audio slice 1 (spec docs/superpowers/specs/2026-09-28-game-audio-design.md §1-2).
//
// MODALITY: the same ai_providers table now holds image services AND the GPU
// box's audio service. The single-active index becomes single-active PER
// MODALITY, so activating the audio profile no longer deactivates the image one.
//
// Bindings key subjects by NAME (worlds.name, biomes.name, ...), never by id,
// for the same reason catalog_art does: a reseed renumbers ids, names survive.
exports.up = (pgm) => {
  pgm.addColumns('ai_providers', {
    modality: { type: 'text', notNull: true, default: 'image' },
  });
  pgm.addConstraint('ai_providers', 'ai_providers_modality_check', {
    check: "modality IN ('image', 'audio')",
  });
  pgm.sql('DROP INDEX IF EXISTS ai_providers_single_active_index');
  pgm.sql(`
    CREATE UNIQUE INDEX ai_providers_single_active_per_modality
      ON ai_providers (modality) WHERE is_active
  `);

  pgm.createTable('audio_clips', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    kind: { type: 'text', notNull: true, check: "kind IN ('music', 'ambience', 'sfx')" },
    label: { type: 'text', notNull: true },
    storage_key: { type: 'text', notNull: true, unique: true },
    bytes: { type: 'integer', notNull: true },
    duration_ms: { type: 'integer', notNull: true },
    loopable: { type: 'boolean', notNull: true, default: false },
    loop_start_ms: { type: 'integer' },
    loop_end_ms: { type: 'integer' },
    source: { type: 'text', notNull: true, check: "source IN ('generated', 'uploaded', 'seeded')" },
    provider_id: { type: 'integer', references: 'ai_providers', onDelete: 'SET NULL' },
    prompt: { type: 'text' },
    style_or_cue: { type: 'text' },
    engine: { type: 'text' },
    seed: { type: 'bigint' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('audio_bindings', {
    id: { type: 'serial', primaryKey: true },
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    slot: { type: 'text', notNull: true },
    clip_id: { type: 'uuid', notNull: true, references: 'audio_clips', onDelete: 'CASCADE' },
    volume: { type: 'real', notNull: true, default: 1, check: 'volume >= 0 AND volume <= 1' },
    weight: { type: 'real', notNull: true, default: 1, check: 'weight > 0' },
    sort: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('audio_bindings', 'audio_bindings_unique',
    { unique: ['subject_kind', 'subject_key', 'slot', 'clip_id'] });
  pgm.createIndex('audio_bindings', ['subject_kind', 'subject_key']);

  pgm.createTable('audio_misses', {
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    slot: { type: 'text', notNull: true },
    world: { type: 'text' },
    count: { type: 'integer', notNull: true, default: 1 },
    first_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('audio_misses', 'audio_misses_pkey',
    { primaryKey: ['subject_kind', 'subject_key', 'slot'] });
};

exports.down = (pgm) => {
  pgm.dropTable('audio_misses');
  pgm.dropTable('audio_bindings');
  pgm.dropTable('audio_clips');
  pgm.sql('DROP INDEX IF EXISTS ai_providers_single_active_per_modality');
  pgm.sql(`
    CREATE UNIQUE INDEX ai_providers_single_active_index
      ON ai_providers ((true)) WHERE is_active
  `);
  pgm.dropConstraint('ai_providers', 'ai_providers_modality_check');
  pgm.dropColumns('ai_providers', ['modality']);
};
```

- [ ] **Step 4: Migrate the scratch DB, then run the test and confirm it passes.**
  Run: `cd backend && npm run migrate:up && node --test tests/audio_catalog_db.test.js; echo $?`
  Expected: all subtests `ok`; exit code `0`.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/1714440560000_audio_catalog.js backend/tests/audio_catalog_db.test.js
git commit -m "feat(audio): migration for provider modality and audio catalog tables (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Provider modality in the service layer

**Files:**
- Modify: `backend/src/services/aiProviders.js` (the `WRITABLE` list,
  `providerFieldError`, `loadActiveProviderWithSecret`, `setActiveProvider`)
- Modify: `backend/src/services/worldGenService.js:67-72`
- Test: `backend/tests/ai_providers.test.js` (append)

**Interfaces:**
- Produces:
  - `loadActiveProviderWithSecret(db, modality = 'image')` returns the row or
    null
  - `setActiveProvider(pool, id)` deactivates only rows of the **same
    modality** as `id`
  - `providerFieldError(body)` accepts `modality`. When `modality === 'audio'`,
    `request_template` may be absent, and create fills `{}`.
- Existing callers of `loadActiveProviderWithSecret(pool)` (index.js:3120 and
  3551, bulkImageRegeneration.js:101, generate-tile-textures.js:59) keep their
  signature and now get image-only behaviour by default. Leave them unchanged.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/ai_providers.test.js`)

```js
const { loadActiveProviderWithSecret, createProvider } = require('../src/services/aiProviders');

test('providerFieldError: modality', () => {
  const base = { name: 'box', base_url: 'http://192.168.0.217:8001' };
  assert.strictEqual(providerFieldError({ ...base, modality: 'audio' }), null,
    'an audio provider needs no request_template');
  assert.match(providerFieldError({ ...base, modality: 'video', request_template: {} }), /modality/);
  assert.match(providerFieldError(base), /request_template/,
    'an image provider (the default) still requires a template');
});

test('activation is per modality', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const made = [];
  t.after(async () => {
    try { if (made.length) await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [made]); }
    finally { await pool.end(); }
  });
  const tag = `${process.pid}-${Date.now()}`;
  const img = await createProvider(pool, { name: `mod-img-${tag}`, base_url: 'http://127.0.0.1:9/', request_template: {} });
  const aud = await createProvider(pool, { name: `mod-aud-${tag}`, base_url: 'http://127.0.0.1:9/', modality: 'audio' });
  made.push(img.id, aud.id);
  assert.deepStrictEqual(aud.request_template, {}, 'audio create fills an empty template');

  await setActiveProvider(pool, img.id);
  await setActiveProvider(pool, aud.id);
  const active = await pool.query('SELECT id FROM ai_providers WHERE is_active AND id = ANY($1) ORDER BY id', [made]);
  assert.deepStrictEqual(active.rows.map((r) => r.id), [img.id, aud.id].sort((a, b) => a - b),
    'activating the audio provider must not deactivate the image one');

  const image = await loadActiveProviderWithSecret(pool);
  assert.notStrictEqual(image && image.id, aud.id, 'the default lookup never returns an audio provider');
  const audio = await loadActiveProviderWithSecret(pool, 'audio');
  assert.strictEqual(audio.id, aud.id);
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
  Run: `cd backend && node --test tests/ai_providers.test.js; echo $?`
  Expected: FAIL (`request_template must be a JSON object` for the audio body,
  and the second active provider deactivates the first).

- [ ] **Step 3: Implement.** In `backend/src/services/aiProviders.js`:

```js
// add to WRITABLE, after 'enabled':
  // Game audio slice 1: 'image' (default) or 'audio'. An audio profile talks
  // to the box's fixed audio API through remoteAudioProvider.js and has no
  // use for the image template/pointer/sheet fields.
  'modality',
```

```js
// in providerFieldError, replace the request_template block with:
  const modality = has('modality') ? body.modality : undefined;
  if (modality !== undefined && modality !== 'image' && modality !== 'audio') {
    return "modality must be 'image' or 'audio'";
  }
  const templateRequired = !partial && modality !== 'audio';
  if (templateRequired || has('request_template')) {
    // The template becomes a POST body. An array or a bare string would be
    // accepted by jsonb and then fail at generate time against the remote
    // service, which is far away from the person who typed it.
    if (!isPlainObject(body.request_template)) {
      return 'request_template must be a JSON object';
    }
  }
```

```js
// createProvider: an audio profile has no template, but the column is NOT NULL.
async function createProvider(db, body) {
  const withDefaults = body.modality === 'audio' && body.request_template === undefined
    ? { ...body, request_template: {} }
    : body;
  const { columns, values } = buildProviderPatch(withDefaults);
  // ...rest unchanged
```

```js
// The provider generation falls back to when nothing more specific is chosen.
// Scoped by modality: the audio profile is active at the same time as the
// image one (one active PER modality), and an image job must never be sent
// to the audio service.
async function loadActiveProviderWithSecret(db, modality = 'image') {
  const r = await db.query(
    'SELECT * FROM ai_providers WHERE is_active AND enabled AND modality = $1', [modality]);
  return r.rows[0] || null;
}
```

```js
// in setActiveProvider, replace the blanket deactivation with a same-modality one:
    await client.query(
      `UPDATE ai_providers SET is_active = false
        WHERE is_active AND modality = (SELECT modality FROM ai_providers WHERE id = $1)`,
      [id],
    );
```

  Also update the header comment above `setActiveProvider` so it names
  `ai_providers_single_active_per_modality`.

  In `backend/src/services/worldGenService.js`, change the query to
  `WHERE enabled AND modality = 'image' AND auth_token IS NOT NULL AND base_url IS NOT NULL`,
  and add the comment "the audio profile points at the same box with a
  different key; the world service is reached through the image profile".

- [ ] **Step 4: Run the tests and confirm they pass.**
  Run: `cd backend && node --test tests/ai_providers.test.js tests/audio_catalog_db.test.js; echo $?`
  Expected: `0`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/aiProviders.js backend/src/services/worldGenService.js backend/tests/ai_providers.test.js
git commit -m "feat(ai-providers): audio modality with one active provider per modality (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `oggInfo` — pure OGG checks

**Files:**
- Create: `backend/src/services/oggInfo.js`
- Create: `backend/tests/fixtures/audio/tone.ogg`, `backend/tests/fixtures/audio/tone.wav`
- Test: `backend/tests/ogg_info.test.js`

**Interfaces:**
- Produces:
  - `inspectOgg(buffer) -> { ok: true, sampleRate, durationMs } | { ok: false, error }`
  - `AUDIO_SIZE_CAPS = { music: 8 * 1024 * 1024, ambience: 8 * 1024 * 1024, sfx: 1024 * 1024 }`
  - `checkClipBuffer(buffer, kind) -> { ok: true, sampleRate, durationMs } | { ok: false, error }`

- [ ] **Step 1: Create the fixtures** (committed, 2 s stereo tone, about 20 KB):

```bash
mkdir -p backend/tests/fixtures/audio
ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=2" -ac 2 -ar 44100 -c:a libvorbis -q:a 2 backend/tests/fixtures/audio/tone.ogg
ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=0.2" -ac 1 -ar 8000 backend/tests/fixtures/audio/tone.wav
ls -l backend/tests/fixtures/audio
```

- [ ] **Step 2: Write the failing test**

```js
// backend/tests/ogg_info.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { inspectOgg, checkClipBuffer, AUDIO_SIZE_CAPS } = require('../src/services/oggInfo');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures/audio', f));

test('inspectOgg reads sample rate and duration from a real Vorbis file', () => {
  const r = inspectOgg(fx('tone.ogg'));
  assert.equal(r.ok, true);
  assert.equal(r.sampleRate, 44100);
  // Not derived from the fixture's own bytes by the same code path: 2 s is
  // what ffmpeg was told to make.
  assert.ok(Math.abs(r.durationMs - 2000) < 30, `durationMs ${r.durationMs} is not ~2000`);
});

test('inspectOgg rejects WAV, HTML, empty and truncated input', () => {
  assert.match(inspectOgg(fx('tone.wav')).error, /not an OGG/i);
  assert.match(inspectOgg(Buffer.from('<html>502 Bad Gateway</html>')).error, /not an OGG/i);
  assert.match(inspectOgg(Buffer.alloc(0)).error, /not an OGG/i);
  assert.equal(inspectOgg(fx('tone.ogg').subarray(0, 40)).ok, false, 'a header-only prefix has no duration');
});

test('checkClipBuffer enforces the per-kind size cap', () => {
  const big = Buffer.concat([fx('tone.ogg'), Buffer.alloc(AUDIO_SIZE_CAPS.sfx)]);
  assert.match(checkClipBuffer(big, 'sfx').error, /too large/i);
  assert.equal(checkClipBuffer(fx('tone.ogg'), 'ambience').ok, true);
  assert.match(checkClipBuffer(fx('tone.ogg'), 'speech').error, /kind/i);
});
```

- [ ] **Step 3: Run it and confirm it fails.**
  Run: `cd backend && node --test tests/ogg_info.test.js; echo $?`
  Expected: FAIL `Cannot find module '../src/services/oggInfo'`.

- [ ] **Step 4: Implement**

```js
// backend/src/services/oggInfo.js
//
// Pure checks on an OGG buffer, with no audio library (spec §2 "Every file is
// checked"). The box delivers OGG Vorbis; anything else -- a WAV master, an
// HTML error page, an empty body -- must fail the job loudly rather than be
// stored and then fail silently in a browser's decodeAudioData.
//
// Duration = granule position of the LAST page / sample rate. For Vorbis the
// granule is the PCM sample count at the end of that page, and the sample rate
// sits in the identification header (packet 1: 0x01 'vorbis', rate at +12).

const AUDIO_SIZE_CAPS = { music: 8 * 1024 * 1024, ambience: 8 * 1024 * 1024, sfx: 1024 * 1024 };
const OGGS = Buffer.from('OggS');

function vorbisSampleRate(buf) {
  const at = buf.indexOf(Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73])); // \x01vorbis
  if (at < 0 || at + 16 > buf.length) return null;
  return buf.readUInt32LE(at + 12);
}

function lastGranule(buf) {
  let pos = buf.lastIndexOf(OGGS);
  while (pos >= 0) {
    if (pos + 14 <= buf.length) {
      const g = buf.readBigInt64LE(pos + 6);
      if (g > 0n) return g;
    }
    pos = pos > 0 ? buf.lastIndexOf(OGGS, pos - 1) : -1;
  }
  return null;
}

function inspectOgg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28 || !buf.subarray(0, 4).equals(OGGS)) {
    return { ok: false, error: 'not an OGG file (expected OggS magic)' };
  }
  const sampleRate = vorbisSampleRate(buf);
  if (!sampleRate) return { ok: false, error: 'OGG has no Vorbis identification header' };
  const granule = lastGranule(buf);
  if (!granule) return { ok: false, error: 'OGG has no audio pages (duration 0)' };
  const durationMs = Math.round(Number(granule) * 1000 / sampleRate);
  if (!(durationMs > 0)) return { ok: false, error: 'OGG duration is 0' };
  return { ok: true, sampleRate, durationMs };
}

function checkClipBuffer(buf, kind) {
  const cap = AUDIO_SIZE_CAPS[kind];
  if (!cap) return { ok: false, error: `unknown clip kind '${kind}'` };
  if (buf.length > cap) {
    return { ok: false, error: `clip too large: ${buf.length} bytes, cap for ${kind} is ${cap}` };
  }
  return inspectOgg(buf);
}

module.exports = { inspectOgg, checkClipBuffer, AUDIO_SIZE_CAPS };
```

- [ ] **Step 5: Run the test and confirm it passes.** Run: `cd backend && node --test tests/ogg_info.test.js; echo $?`. Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/oggInfo.js backend/tests/ogg_info.test.js backend/tests/fixtures/audio
git commit -m "feat(audio): OGG magic, sample-rate and duration checks with size caps (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `remoteAudioProvider` — box adapter (styles, propose, generateTrack)

**Files:**
- Create: `backend/src/services/remoteAudioProvider.js`
- Test: `backend/tests/remote_audio_provider.test.js`

**Interfaces:**
- Consumes:
  - `safeFetch`, `readCapped`, `readJsonCapped`, `redactUrl` from `./safeFetch`
  - `authHeaders` from `./providerDiscovery`
  - `checkClipBuffer` from `./oggInfo`
- Produces (every function takes an optional `{ fetchImpl, sleep }` last):
  - `listStyles(provider) -> { ok, styles: [{ value, label, kind, slots }], cues: [{ value, label, engines, entity_default }] } | { ok: false, error }`
  - `propose(provider, { context, kind }) -> { ok, style, slots, prompt } | { ok: false, error }`
  - `generateTrack(provider, { kind, name, style, prompt, slots, seed, duration_s }) -> { ok, buffer, durationMs, sampleRate, loopStartMs, loopEndMs, prompt, seed } | { ok: false, error, retryable }`
- `generateTrack` behaviour, in order:
  1. POST `/api/audio`.
  2. If the JSON body has `audio` (a base64 string, or an array whose first
     element is one), decode it.
  3. Otherwise poll `GET /api/audio?kind=&name=&limit=1` every
     `AUDIO_POLL_MS` (default 3000) until `status` is `done` or `failed`, then
     `GET /api/audio/{kind}/{name}` for the bytes. Never pass `master`.
  4. Loop points come from the ledger row (`loop_start`/`loop_end` in samples,
     divided by `sample_rate`).
  5. A 409 or 503 is `{ ok: false, retryable: true }`.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/remote_audio_provider.test.js
// The adapter against a fake box. Every fake reads the request it was sent, so
// a test cannot pass while the adapter sends the wrong path/body/auth.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const rap = require('../src/services/remoteAudioProvider');

const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));
const WAV = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.wav'));
const provider = { base_url: 'http://box.test:8001', auth_token: 'sk_test', modality: 'audio' };

function fakeBox(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${(init.method || 'GET')} ${u.pathname}`;
    calls.push({ key, url: u, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const h = routes[key];
    if (!h) return new Response('not found', { status: 404 });
    return h(u, init, calls.length);
  };
  return { fetchImpl, calls };
}
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const noSleep = async () => {};

test('listStyles returns styles and cues with auth', async () => {
  const { fetchImpl, calls } = fakeBox({
    'GET /api/audio/styles': (u) => (u.searchParams.get('kind') === 'sfx'
      ? json([{ value: 'hit', label: 'Hit', kind: 'sfx', engines: ['realistic', 'retro'], entity_default: 'a creature' }])
      : json([{ value: 'forest', label: 'Forest', kind: 'ambience', slots: { mood: {} } }])),
  });
  const r = await rap.listStyles(provider, { fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.styles.map((s) => s.value), ['forest']);
  assert.deepEqual(r.cues.map((c) => c.value), ['hit']);
  assert.equal(calls[0].headers.Authorization, 'Bearer sk_test');
});

test('generateTrack: synchronous base64 response', async () => {
  const { fetchImpl, calls } = fakeBox({
    'POST /api/audio': () => json({ audio: [OGG.toString('base64')], info: { loop_start: 0, loop_end: 88200, sample_rate: 44100, prompt: 'p', seed: 7 } }),
  });
  const r = await rap.generateTrack(provider, { kind: 'ambience', name: 'n1', style: 'forest', seed: 7 }, { fetchImpl, sleep: noSleep });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.buffer.equals(OGG));
  assert.equal(r.loopEndMs, 2000);
  assert.equal(calls[0].body.seed, 7, 'the seed is sent explicitly');
  assert.equal(calls[0].body.kind, 'ambience');
});

test('generateTrack: queued response polls the ledger then fetches the file', async () => {
  let polls = 0;
  const { fetchImpl, calls } = fakeBox({
    'POST /api/audio': () => json({ id: 'x', status: 'queued', name: 'n2' }),
    'GET /api/audio': () => { polls += 1; return json({ items: [polls < 2
      ? { name: 'n2', status: 'running' }
      : { name: 'n2', status: 'done', sample_rate: 48000, loop_start: 0, loop_end: 96000, prompt: 'pp', seed: 3 }] }); },
    'GET /api/audio/music/n2': () => new Response(OGG, { status: 200, headers: { 'content-type': 'audio/ogg' } }),
  });
  const r = await rap.generateTrack(provider, { kind: 'music', name: 'n2', seed: 3 }, { fetchImpl, sleep: noSleep });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.loopEndMs, 2000);
  const fileCall = calls.find((c) => c.key === 'GET /api/audio/music/n2');
  assert.equal(fileCall.url.searchParams.has('master'), false, 'never asks for the WAV master');
});

test('generateTrack rejects a WAV, reports a failed ledger row, and marks 409 retryable', async () => {
  let r = await rap.generateTrack(provider, { kind: 'music', name: 'w', seed: 1 }, {
    fetchImpl: fakeBox({ 'POST /api/audio': () => json({ audio: WAV.toString('base64') }) }).fetchImpl, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /not an OGG/i);

  r = await rap.generateTrack(provider, { kind: 'music', name: 'f', seed: 1 }, {
    fetchImpl: fakeBox({
      'POST /api/audio': () => json({ status: 'queued' }),
      'GET /api/audio': () => json({ items: [{ name: 'f', status: 'failed', error: 'CUDA out of memory' }] }),
    }).fetchImpl, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /CUDA out of memory/);

  r = await rap.generateTrack(provider, { kind: 'music', name: 'b', seed: 1 }, {
    fetchImpl: fakeBox({ 'POST /api/audio': () => json({ detail: 'switch pending' }, 409) }).fetchImpl, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
});

test('propose passes context and kind through', async () => {
  const { fetchImpl, calls } = fakeBox({
    'POST /api/audio/propose': () => json({ kind: 'ambience', style: 'forest', slots: { mood: 'calm daytime' }, prompt: 'forest ambience' }),
  });
  const r = await rap.propose(provider, { context: 'pine forest', kind: 'ambience' }, { fetchImpl });
  assert.equal(r.style, 'forest');
  assert.deepEqual(calls[0].body, { context: 'pine forest', kind: 'ambience' });
});
```

- [ ] **Step 2: Run it and confirm it fails.**
  Run: `cd backend && node --test tests/remote_audio_provider.test.js; echo $?`
  Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// backend/src/services/remoteAudioProvider.js
//
// The adapter for the GPU box's audio API (spec §2, "Box contract, measured
// 2026-09-28"). Hand-written rather than template-driven: styles, cues and
// packs do not reduce to {{prompt}} substitution.
//
// Every call goes through safeFetch (scheme/redirect/credential guard) and a
// capped read. Every returned clip has passed checkClipBuffer, so callers can
// store what they get without re-checking.
const { safeFetch, readCapped, readJsonCapped, redactUrl } = require('./safeFetch');
const { authHeaders, resolveUrl } = require('./providerDiscovery');
const { checkClipBuffer, AUDIO_SIZE_CAPS } = require('./oggInfo');

const JSON_CAP = () => Number(process.env.AUDIO_JSON_MAX_BYTES) || 16 * 1024 * 1024; // base64 of an 8 MB clip + info
const TIMEOUT_MS = () => Number(process.env.AUDIO_GENERATE_TIMEOUT_MS) || 10 * 60 * 1000;
const POLL_MS = () => Number(process.env.AUDIO_POLL_MS) || 3000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(provider, method, pathAndQuery, body, fetchImpl) {
  const url = resolveUrl(provider.base_url, pathAndQuery);
  const headers = { ...authHeaders(provider) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const res = await safeFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    }, { fetchImpl });
    return { res };
  } catch (err) {
    return { error: `could not reach ${redactUrl(url)}: ${err.message}` };
  }
}

async function callJson(provider, method, pathAndQuery, body, fetchImpl) {
  const { res, error } = await call(provider, method, pathAndQuery, body, fetchImpl);
  if (error) return { ok: false, error, retryable: true };
  if (!res.ok) {
    return { ok: false, status: res.status, retryable: res.status === 409 || res.status === 503,
      error: `audio service answered ${res.status} for ${method} ${pathAndQuery.split('?')[0]}` };
  }
  const read = await readJsonCapped(res, JSON_CAP());
  if (read.error) return { ok: false, error: `audio service did not answer with usable JSON: ${read.error}` };
  return { ok: true, json: read.json };
}

async function listStyles(provider, { fetchImpl = fetch } = {}) {
  const s = await callJson(provider, 'GET', '/api/audio/styles', undefined, fetchImpl);
  if (!s.ok) return s;
  const c = await callJson(provider, 'GET', '/api/audio/styles?kind=sfx', undefined, fetchImpl);
  if (!c.ok) return c;
  if (!Array.isArray(s.json) || !Array.isArray(c.json)) return { ok: false, error: 'styles response is not a list' };
  return {
    ok: true,
    styles: s.json.map(({ value, label, kind, slots }) => ({ value, label, kind, slots: slots || {} })),
    cues: c.json.map(({ value, label, engines, entity_default }) => ({ value, label, engines: engines || [], entity_default })),
  };
}

async function propose(provider, { context, kind }, { fetchImpl = fetch } = {}) {
  const r = await callJson(provider, 'POST', '/api/audio/propose', { context, kind }, fetchImpl);
  if (!r.ok) return r;
  const { style, slots, prompt } = r.json || {};
  return { ok: true, style: style || null, slots: slots || {}, prompt: prompt || '' };
}

function loopMs(info, key) {
  const v = info && info[key];
  const rate = info && info.sample_rate;
  return Number.isFinite(v) && rate > 0 ? Math.round((v * 1000) / rate) : null;
}

function finish(buffer, kind, info, fallback) {
  const checked = checkClipBuffer(buffer, kind);
  if (!checked.ok) return { ok: false, error: checked.error };
  return {
    ok: true,
    buffer,
    durationMs: checked.durationMs,
    sampleRate: checked.sampleRate,
    loopStartMs: loopMs(info, 'loop_start'),
    loopEndMs: loopMs(info, 'loop_end'),
    prompt: (info && info.prompt) || fallback.prompt || null,
    seed: (info && Number.isFinite(info.seed)) ? info.seed : fallback.seed,
  };
}

async function generateTrack(provider, req, { fetchImpl = fetch, sleep = realSleep } = {}) {
  const { kind, name, style, prompt, slots, seed, duration_s: durationS } = req;
  if (kind !== 'music' && kind !== 'ambience') return { ok: false, error: `generateTrack kind must be music or ambience, got ${kind}` };
  const body = { kind, name, seed };
  if (style) body.style = style;
  if (prompt) body.prompt = prompt;
  if (slots && Object.keys(slots).length) body.slots = slots;
  if (durationS) body.duration_s = durationS;

  const started = await callJson(provider, 'POST', '/api/audio', body, fetchImpl);
  if (!started.ok) return started;
  const j = started.json || {};
  const inline = Array.isArray(j.audio) ? j.audio[0] : j.audio;
  if (typeof inline === 'string') {
    return finish(Buffer.from(inline, 'base64'), kind, j.info || j, { prompt, seed });
  }

  // Queued/async shape: poll the ledger by name until it settles.
  const deadline = Date.now() + TIMEOUT_MS();
  let row = j.status === 'done' ? j : null;
  while (!row) {
    if (Date.now() > deadline) return { ok: false, retryable: true, error: `audio generation '${name}' did not finish in time` };
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_MS());
    // eslint-disable-next-line no-await-in-loop
    const led = await callJson(provider, 'GET',
      `/api/audio?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}&limit=1`, undefined, fetchImpl);
    if (!led.ok) return led;
    const item = led.json && Array.isArray(led.json.items) ? led.json.items[0] : null;
    if (item && item.status === 'failed') return { ok: false, error: `audio service failed: ${item.error || 'no reason given'}` };
    if (item && item.status === 'done') row = item;
  }
  const { res, error } = await call(provider, 'GET',
    `/api/audio/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`, undefined, fetchImpl);
  if (error) return { ok: false, retryable: true, error };
  if (!res.ok) return { ok: false, error: `audio file fetch answered ${res.status}` };
  const read = await readCapped(res, AUDIO_SIZE_CAPS[kind] + 1);
  if (read.error) return { ok: false, error: `audio file: ${read.error}` };
  return finish(read.buffer, kind, row, { prompt, seed });
}

module.exports = { listStyles, propose, generateTrack };
```

- [ ] **Step 4: Run the test and confirm it passes.** Run: `cd backend && node --test tests/remote_audio_provider.test.js; echo $?`. Expected: `0`.
  - If `resolveUrl` drops the query string, the listStyles test catches it:
    the sfx branch returns the styles list. Fix `call` to append the query to
    `new URL(path, base)` rather than weakening the test.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/remoteAudioProvider.js backend/tests/remote_audio_provider.test.js
git commit -m "feat(audio): GPU-box audio adapter -- styles, propose, generateTrack with ledger polling (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Subject registry + audio library service

**Files:**
- Create: `backend/src/services/audioSubjects.js`
- Create: `backend/src/services/audioLibrary.js`
- Test: `backend/tests/audio_library_db.test.js`

**Interfaces:**
- `audioSubjects`:
  - `SUBJECT_KINDS`: `{ world: { slots: { music: 'music', ambience: 'ambience' }, list(db) }, biome: { slots: { ambience: 'ambience' }, list(db) } }`
  - `slotKind(subjectKind, slot) -> 'music'|'ambience'|'sfx'|null`
  - `isKnownSlot(subjectKind, slot) -> boolean`
- `audioLibrary` (all take `db` first):
  - `storeClip(db, { buffer, kind, label, source, providerId, prompt, styleOrCue, engine, seed, durationMs, loopStartMs, loopEndMs }) -> clip row`. Puts to MinIO at `audio/<kind>/<id>.ogg` with `audio/ogg`, then inserts. If the insert fails, the MinIO object is orphaned. Accepted and logged, like art.
  - `bindClip(db, { subjectKind, subjectKey, slot, clipId, volume = 1, weight = 1 }) -> binding row`. Validates the slot and that clip kind matches, and deletes the matching `audio_misses` row in the same transaction. Throws `AudioInputError` (with `.status = 400`) on a bad slot or kind mismatch.
  - `updateBinding(db, id, { volume, weight }) -> row | null`
  - `unbind(db, id) -> boolean`
  - `deleteClip(db, clipId) -> boolean` (bindings cascade)
  - `subjectSlots(db, subjectKind, subjectKey) -> { [slot]: [{ binding_id, clip_id, label, kind, duration_ms, bytes, volume, weight, url_key }] }`
  - `worldAudioBundle(db, worldId) -> { world: name, bindings: { 'world/<name>/music': [...], 'biome/<b>/ambience': [...] } } | null`. Each entry is `{ key: storage_key, volume, weight, loopable, loop_start_ms, loop_end_ms, kind }`.
  - `recordMisses(db, misses[]) -> number accepted`. Keeps only registry-known subject kinds and slots and caps at 200 entries. Upserts with `count = count + 1`.
  - `listMisses(db) -> rows` ordered by `count DESC`.
- `assetStore.putObject(key, buffer, contentType)` is the existing export.

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/audio_library_db.test.js
// Real scratch DB, fake MinIO client. Cleans up only what it created.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

test('audio library', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const put = [];
  assetStore.__setAssetClient({
    bucketExists: async () => true,
    putObject: async (bucket, key, buf) => { put.push({ key, bytes: buf.length }); },
  });
  const tag = `${process.pid}-${Date.now()}`;
  const worldName = `audio-test-world-${tag}`;
  const biomeName = `audio-test-biome-${tag}`;
  const clipIds = [];
  let worldId;
  t.after(async () => {
    try {
      if (clipIds.length) await pool.query('DELETE FROM audio_clips WHERE id = ANY($1)', [clipIds]);
      await pool.query('DELETE FROM audio_misses WHERE subject_key IN ($1, $2)', [worldName, biomeName]);
      if (worldId) await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
      await pool.query('DELETE FROM biomes WHERE name = $1', [biomeName]);
    } finally { await pool.end(); }
  });
  await pool.query('INSERT INTO biomes (name) VALUES ($1)', [biomeName]);
  worldId = (await pool.query(
    `INSERT INTO worlds (name, seed, biomes) VALUES ($1, 1, $2::jsonb) RETURNING id`,
    [worldName, JSON.stringify([biomeName])])).rows[0].id;

  const store = async (kind) => {
    const c = await lib.storeClip(pool, { buffer: OGG, kind, label: `${kind} ${tag}`, source: 'uploaded', durationMs: 2000 });
    clipIds.push(c.id);
    return c;
  };

  await t.test('storeClip writes MinIO then a row', async () => {
    const c = await store('ambience');
    assert.equal(c.storage_key, `audio/ambience/${c.id}.ogg`);
    assert.ok(put.some((p) => p.key === c.storage_key && p.bytes === OGG.length));
  });

  await t.test('bindClip rejects unknown slots and kind mismatches', async () => {
    const music = await store('music');
    await assert.rejects(lib.bindClip(pool, { subjectKind: 'biome', subjectKey: biomeName, slot: 'music', clipId: music.id }), /slot/);
    await assert.rejects(lib.bindClip(pool, { subjectKind: 'world', subjectKey: worldName, slot: 'ambience', clipId: music.id }), /kind/);
    await assert.rejects(lib.bindClip(pool, { subjectKind: 'dragon', subjectKey: 'x', slot: 'roar', clipId: music.id }), /subject/);
  });

  await t.test('binding clears the matching miss; the bundle carries world + biome slots', async () => {
    assert.equal(await lib.recordMisses(pool, [
      { subject_kind: 'biome', subject_key: biomeName, slot: 'ambience', world: worldName },
      { subject_kind: 'biome', subject_key: biomeName, slot: 'ambience', world: worldName },
      { subject_kind: 'nonsense', subject_key: 'x', slot: 'y' },
    ]), 2, 'unknown subject kinds are dropped');
    const before = await pool.query('SELECT count FROM audio_misses WHERE subject_key = $1', [biomeName]);
    assert.equal(before.rows[0].count, 2);

    const amb = await store('ambience');
    const mus = await store('music');
    await lib.bindClip(pool, { subjectKind: 'biome', subjectKey: biomeName, slot: 'ambience', clipId: amb.id, volume: 0.5 });
    await lib.bindClip(pool, { subjectKind: 'world', subjectKey: worldName, slot: 'music', clipId: mus.id });
    const after = await pool.query('SELECT 1 FROM audio_misses WHERE subject_key = $1', [biomeName]);
    assert.equal(after.rowCount, 0, 'binding a slot clears its miss');

    const bundle = await lib.worldAudioBundle(pool, worldId);
    assert.equal(bundle.world, worldName);
    assert.equal(bundle.bindings[`biome/${biomeName}/ambience`][0].volume, 0.5);
    assert.equal(bundle.bindings[`world/${worldName}/music`][0].key, mus.storage_key);
    assert.equal(await lib.worldAudioBundle(pool, '00000000-0000-0000-0000-000000000000'), null);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**
  Run: `cd backend && node --test tests/audio_library_db.test.js; echo $?`
  Expected: FAIL (module not found).
  - If `INSERT INTO worlds` or `biomes` fails on a NOT NULL column you didn't
    set, add that column to the fixture insert with a neutral value. Never
    drop the assertion.

- [ ] **Step 3: Implement `audioSubjects.js`**

```js
// backend/src/services/audioSubjects.js
//
// The code registry of what can carry sound (spec §1 "Subject registry").
// Binding validation, the bindings bundle, the misses filter and the admin
// Audio tab all read THIS list, so they cannot disagree about what a legal
// slot is. Slice 1 has world + biome; slices 2-3 add creature, attack_type,
// item, skill and world_point here.
const SUBJECT_KINDS = {
  world: {
    label: 'Worlds',
    slots: { music: 'music', ambience: 'ambience' },
    list: async (db) => (await db.query('SELECT name FROM worlds ORDER BY name')).rows.map((r) => r.name),
  },
  biome: {
    label: 'Biomes',
    slots: { ambience: 'ambience' },
    list: async (db) => (await db.query('SELECT name FROM biomes ORDER BY name')).rows.map((r) => r.name),
  },
};

function slotKind(subjectKind, slot) {
  const k = SUBJECT_KINDS[subjectKind];
  return (k && Object.prototype.hasOwnProperty.call(k.slots, slot)) ? k.slots[slot] : null;
}

function isKnownSlot(subjectKind, slot) {
  return slotKind(subjectKind, slot) !== null;
}

module.exports = { SUBJECT_KINDS, slotKind, isKnownSlot };
```

- [ ] **Step 4: Implement `audioLibrary.js`**

```js
// backend/src/services/audioLibrary.js
//
// Clips, bindings and misses (spec §1). DB functions take `db` first so a
// caller inside a transaction can pass its client.
const assetStore = require('./assetStore');
const { SUBJECT_KINDS, slotKind, isKnownSlot } = require('./audioSubjects');

class AudioInputError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const MAX_MISSES_PER_POST = 200;

async function storeClip(db, c) {
  const id = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  const key = `audio/${c.kind}/${id}.ogg`;
  await assetStore.putObject(key, c.buffer, 'audio/ogg');
  const r = await db.query(
    `INSERT INTO audio_clips (id, kind, label, storage_key, bytes, duration_ms, loopable,
       loop_start_ms, loop_end_ms, source, provider_id, prompt, style_or_cue, engine, seed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [id, c.kind, c.label, key, c.buffer.length, c.durationMs,
      c.kind !== 'sfx', c.loopStartMs ?? null, c.loopEndMs ?? null, c.source,
      c.providerId ?? null, c.prompt ?? null, c.styleOrCue ?? null, c.engine ?? null, c.seed ?? null],
  );
  return r.rows[0];
}

async function bindClip(db, { subjectKind, subjectKey, slot, clipId, volume = 1, weight = 1 }) {
  if (!SUBJECT_KINDS[subjectKind]) throw new AudioInputError(`unknown subject kind '${subjectKind}'`);
  const expected = slotKind(subjectKind, slot);
  if (!expected) throw new AudioInputError(`'${subjectKind}' has no slot '${slot}'`);
  const clip = (await db.query('SELECT kind FROM audio_clips WHERE id = $1', [clipId])).rows[0];
  if (!clip) throw new AudioInputError('clip not found');
  if (clip.kind !== expected) {
    throw new AudioInputError(`slot '${slot}' takes ${expected} clips, this clip's kind is ${clip.kind}`);
  }
  const client = db.connect ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id, volume, weight)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [subjectKind, subjectKey, slot, clipId, volume, weight]);
    await client.query(
      'DELETE FROM audio_misses WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3',
      [subjectKind, subjectKey, slot]);
    await client.query('COMMIT');
    return r.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw new AudioInputError('that clip is already bound to this slot');
    throw err;
  } finally {
    if (client !== db) client.release();
  }
}

async function updateBinding(db, id, { volume, weight }) {
  const r = await db.query(
    `UPDATE audio_bindings SET volume = COALESCE($2, volume), weight = COALESCE($3, weight)
      WHERE id = $1 RETURNING *`, [id, volume ?? null, weight ?? null]);
  return r.rows[0] || null;
}

async function unbind(db, id) {
  return (await db.query('DELETE FROM audio_bindings WHERE id = $1', [id])).rowCount > 0;
}

async function deleteClip(db, clipId) {
  return (await db.query('DELETE FROM audio_clips WHERE id = $1', [clipId])).rowCount > 0;
}

const BINDING_COLUMNS = `b.id AS binding_id, b.subject_kind, b.subject_key, b.slot, b.volume, b.weight,
  c.id AS clip_id, c.kind, c.label, c.storage_key, c.duration_ms, c.bytes, c.loopable,
  c.loop_start_ms, c.loop_end_ms`;

async function subjectSlots(db, subjectKind, subjectKey) {
  const k = SUBJECT_KINDS[subjectKind];
  if (!k) throw new AudioInputError(`unknown subject kind '${subjectKind}'`);
  const r = await db.query(
    `SELECT ${BINDING_COLUMNS} FROM audio_bindings b JOIN audio_clips c ON c.id = b.clip_id
      WHERE b.subject_kind = $1 AND b.subject_key = $2 ORDER BY b.sort, b.id`, [subjectKind, subjectKey]);
  const out = Object.fromEntries(Object.keys(k.slots).map((s) => [s, []]));
  for (const row of r.rows) if (out[row.slot]) out[row.slot].push(row);
  return out;
}

async function worldAudioBundle(db, worldId) {
  const w = (await db.query('SELECT name, biomes FROM worlds WHERE id = $1', [worldId])).rows[0];
  if (!w) return null;
  const biomes = Array.isArray(w.biomes) ? w.biomes.filter((b) => typeof b === 'string') : [];
  const r = await db.query(
    `SELECT ${BINDING_COLUMNS} FROM audio_bindings b JOIN audio_clips c ON c.id = b.clip_id
      WHERE (b.subject_kind = 'world' AND b.subject_key = $1)
         OR (b.subject_kind = 'biome' AND b.subject_key = ANY($2))
      ORDER BY b.sort, b.id`, [w.name, biomes]);
  const bindings = {};
  for (const row of r.rows) {
    const key = `${row.subject_kind}/${row.subject_key}/${row.slot}`;
    (bindings[key] = bindings[key] || []).push({
      key: row.storage_key, kind: row.kind, volume: row.volume, weight: row.weight,
      loopable: row.loopable, loop_start_ms: row.loop_start_ms, loop_end_ms: row.loop_end_ms,
    });
  }
  return { world: w.name, bindings };
}

async function recordMisses(db, misses) {
  if (!Array.isArray(misses)) return 0;
  const ok = misses.slice(0, MAX_MISSES_PER_POST).filter((m) => m
    && typeof m.subject_key === 'string' && m.subject_key.length <= 200
    && isKnownSlot(m.subject_kind, m.slot));
  for (const m of ok) {
    // eslint-disable-next-line no-await-in-loop
    await db.query(
      `INSERT INTO audio_misses (subject_kind, subject_key, slot, world) VALUES ($1,$2,$3,$4)
       ON CONFLICT (subject_kind, subject_key, slot)
       DO UPDATE SET count = audio_misses.count + 1, last_seen = now(), world = EXCLUDED.world`,
      [m.subject_kind, m.subject_key, m.slot, typeof m.world === 'string' ? m.world.slice(0, 200) : null]);
  }
  return ok.length;
}

async function listMisses(db) {
  return (await db.query('SELECT * FROM audio_misses ORDER BY count DESC, last_seen DESC LIMIT 500')).rows;
}

module.exports = {
  AudioInputError, storeClip, bindClip, updateBinding, unbind, deleteClip,
  subjectSlots, worldAudioBundle, recordMisses, listMisses, MAX_MISSES_PER_POST,
};
```

- [ ] **Step 5: Run the test and confirm it passes.** Run: `cd backend && node --test tests/audio_library_db.test.js; echo $?`. Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/audioSubjects.js backend/src/services/audioLibrary.js backend/tests/audio_library_db.test.js
git commit -m "feat(audio): subject registry and clip/binding/miss library (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Audio routes, `.ogg` assets, audio model refresh

**Files:**
- Create: `backend/src/api/audioRoutes.js`
- Modify: `backend/src/index.js`:
  - mount next to `/api/characters` (~line 524);
  - asset route type (~line 3196);
  - `refresh-models` route (~line 2785)
- Test: `backend/tests/audio_routes_db.test.js`

**Interfaces:**
- Consumes: Task 4 `generateTrack`, `propose`, `listStyles`; Task 5 library; `aiProviders.loadActiveProviderWithSecret(db, 'audio')`, `loadProviderWithSecret`.
- Produces (all JSON unless noted):
  - `GET /api/audio/world/:worldId` (player) → `worldAudioBundle`, or 404
  - `POST /api/audio/misses` (player) body `{ misses: [...] }` → `{ accepted }`
  - `GET /api/audio/admin/subjects` (admin) → `[{ kind, label, slots: {slot: clipKind}, subjects: [name] }]`
  - `GET /api/audio/admin/slots/:kind/:key` (admin) → `subjectSlots`
  - `POST /api/audio/admin/propose` (admin) `{ subject_kind, subject_key, slot }` → `{ style, slots, prompt }`
  - `POST /api/audio/admin/generate` (admin) `{ subject_kind, subject_key, slot, style?, prompt?, slots?, seed?, provider_id? }` → `{ clip, binding }`. **Synchronous** in slice 1: it holds the request up to `AUDIO_GENERATE_TIMEOUT_MS` (the queue arrives in slice 2). Errors: 400 bad input, 503 no audio provider, 502 provider failure with the provider's message.
  - `POST /api/audio/admin/upload?subject_kind=&subject_key=&slot=&label=` (admin) raw body `Content-Type: audio/ogg`, up to 8 MB → `{ clip, binding }`
  - `PATCH /api/audio/admin/bindings/:id` `{ volume?, weight? }`, `DELETE /api/audio/admin/bindings/:id`, `DELETE /api/audio/admin/clips/:id`
  - `GET /api/audio/admin/misses` (admin) → rows
- For an audio provider, `POST /api/ai-providers/:id/refresh-models` stores
  `[...styles.map(s => s.value), ...cues.map(c => 'cue:' + c.value)]` in
  `models_cache`. The rows also come back in the response as `styles`/`cues`
  for the UI.

- [ ] **Step 1: Write the failing test.** It uses a real scratch DB with users
  created per run, as in `passive_nodes_admin_routes.test.js`. The box is a
  local `http.createServer` that serves the fixture, so the real
  `safeFetch` → `generateTrack` path is exercised.

```js
// backend/tests/audio_routes_db.test.js
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const assetStore = require('../src/services/assetStore');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

async function makeUser(pool, role, tag) {
  const username = `audio-${role}-${tag}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', role]);
  return { id: r.rows[0].id, username, role, tokenVersion: r.rows[0].token_version };
}
const bearer = (u) => `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.tokenVersion })}`;

test('audio routes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
  const tag = `${process.pid}-${Date.now()}`;
  const worldName = `audio-route-world-${tag}`;
  const made = { users: [], providers: [], worlds: [] };
  const seen = [];
  const box = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.method === 'POST' && req.url === '/api/audio') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ audio: [OGG.toString('base64')], info: { sample_rate: 44100, loop_start: 0, loop_end: 88200, prompt: 'forest', seed: 11 } }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => box.listen(0, '127.0.0.1', r));
  const boxUrl = `http://127.0.0.1:${box.address().port}`;

  t.after(async () => {
    try {
      await pool.query(`DELETE FROM audio_clips WHERE id IN (SELECT clip_id FROM audio_bindings WHERE subject_key = $1)`, [worldName]);
      await pool.query('DELETE FROM audio_misses WHERE subject_key = $1', [worldName]);
      if (made.worlds.length) await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [made.worlds]);
      if (made.providers.length) await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [made.providers]);
      if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
    } finally { box.close(); await pool.end(); }
  });

  const admin = await makeUser(pool, 'admin', tag);
  const player = await makeUser(pool, 'player', tag);
  made.users.push(admin.id, player.id);
  const worldId = (await pool.query(`INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id`, [worldName])).rows[0].id;
  made.worlds.push(worldId);
  const prov = (await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template, modality, auth_token)
     VALUES ($1, $2, '{}'::jsonb, 'audio', 'sk_route_test') RETURNING id`, [`audio-route-${tag}`, boxUrl])).rows[0].id;
  made.providers.push(prov);

  await t.test('admin routes reject a player (403) and anonymous (401)', async () => {
    assert.equal((await request(app).get('/api/audio/admin/subjects').set('Authorization', bearer(player))).status, 403);
    assert.equal((await request(app).get('/api/audio/admin/subjects')).status, 401);
  });

  await t.test('generate stores, binds, and uses the provider token', async () => {
    const res = await request(app).post('/api/audio/admin/generate').set('Authorization', bearer(admin))
      .send({ subject_kind: 'world', subject_key: worldName, slot: 'music', style: 'village', provider_id: prov });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.clip.kind, 'music');
    assert.equal(res.body.clip.loop_end_ms, 2000);
    const sent = seen.find((s) => s.url === '/api/audio');
    assert.equal(sent.auth, 'Bearer sk_route_test');
    assert.ok(Number.isInteger(JSON.parse(sent.body).seed), 'a seed is always sent');
    assert.equal(JSON.stringify(res.body).includes('sk_route_test'), false, 'the token never leaves the server');
  });

  await t.test('generate rejects a slot the subject does not have', async () => {
    const res = await request(app).post('/api/audio/admin/generate').set('Authorization', bearer(admin))
      .send({ subject_kind: 'biome', subject_key: 'x', slot: 'music', provider_id: prov });
    assert.equal(res.status, 400);
  });

  await t.test('upload accepts OGG and rejects anything else', async () => {
    const q = `subject_kind=world&subject_key=${encodeURIComponent(worldName)}&slot=ambience&label=up`;
    const ok = await request(app).post(`/api/audio/admin/upload?${q}`).set('Authorization', bearer(admin))
      .set('Content-Type', 'audio/ogg').send(OGG);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const bad = await request(app).post(`/api/audio/admin/upload?${q}`).set('Authorization', bearer(admin))
      .set('Content-Type', 'audio/ogg').send(Buffer.from('RIFF....WAVEfmt '));
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /not an OGG/i);
  });

  await t.test('player bundle + misses', async () => {
    const b = await request(app).get(`/api/audio/world/${worldId}`).set('Authorization', bearer(player));
    assert.equal(b.status, 200);
    assert.equal(b.body.world, worldName);
    assert.equal(b.body.bindings[`world/${worldName}/music`].length, 1);
    assert.equal(b.body.bindings[`world/${worldName}/ambience`].length, 1);
    const m = await request(app).post('/api/audio/misses').set('Authorization', bearer(player))
      .send({ misses: [{ subject_kind: 'biome', subject_key: worldName, slot: 'ambience', world: worldName }] });
    assert.equal(m.status, 200);
    assert.equal(m.body.accepted, 1);
  });

  await t.test('.ogg assets are served as audio/ogg', async () => {
    const { Readable } = require('node:stream');
    assetStore.__setAssetClient({ getObject: async () => Readable.from([OGG]) });
    const res = await request(app).get('/api/assets/audio/music/x.ogg');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /audio\/ogg/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**
  Run: `cd backend && node --test tests/audio_routes_db.test.js; echo $?`
  Expected: FAIL (404 on `/api/audio/admin/subjects`).

- [ ] **Step 3: Implement `backend/src/api/audioRoutes.js`**

```js
// backend/src/api/audioRoutes.js
//
// Game audio slice 1 (spec §2-4). Two audiences on one mount:
//   /api/audio/world/:id and /api/audio/misses  -- playerGuard, the game client
//   /api/audio/admin/*                          -- adminGuard, the Audio tab
// The box token is read server-side only (loadProviderWithSecret /
// loadActiveProviderWithSecret) and never appears in a response.
const express = require('express');
const crypto = require('node:crypto');
const { requireAdmin, requireAuth } = require('../auth/middleware.js');
const aiProviders = require('../services/aiProviders');
const rap = require('../services/remoteAudioProvider');
const lib = require('../services/audioLibrary');
const { SUBJECT_KINDS, slotKind } = require('../services/audioSubjects');
const { checkClipBuffer } = require('../services/oggInfo');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveAudioProvider(pool, providerId) {
  if (providerId != null) {
    const p = await aiProviders.loadProviderWithSecret(pool, providerId);
    return p && p.modality === 'audio' && p.enabled ? p : null;
  }
  return aiProviders.loadActiveProviderWithSecret(pool, 'audio');
}

async function contextFor(pool, subjectKind, subjectKey) {
  if (subjectKind === 'world') {
    const w = (await pool.query('SELECT name, biomes FROM worlds WHERE name = $1', [subjectKey])).rows[0];
    const biomes = w && Array.isArray(w.biomes) ? w.biomes.join(', ') : '';
    return `a medieval fantasy world called ${subjectKey}${biomes ? ` with ${biomes} regions` : ''}`;
  }
  const b = (await pool.query('SELECT name, art_style FROM biomes WHERE name = $1', [subjectKey])).rows[0];
  return `the ${subjectKey} biome${b && b.art_style ? `: ${b.art_style}` : ''}`;
}

function sendError(res, err) {
  if (err && err.status === 400) return res.status(400).json({ error: err.message });
  console.error(err);
  return res.status(500).json({ error: 'audio request failed' });
}

module.exports = function audioRoutes(pool) {
  const router = express.Router();
  const admin = requireAdmin(pool);
  const player = requireAuth(pool);

  router.get('/world/:worldId', player, async (req, res) => {
    if (!UUID.test(req.params.worldId)) return res.status(400).json({ error: 'worldId must be a uuid' });
    try {
      const bundle = await lib.worldAudioBundle(pool, req.params.worldId);
      if (!bundle) return res.status(404).json({ error: 'world not found' });
      res.json(bundle);
    } catch (err) { sendError(res, err); }
  });

  router.post('/misses', player, async (req, res) => {
    try {
      res.json({ accepted: await lib.recordMisses(pool, req.body && req.body.misses) });
    } catch (err) { sendError(res, err); }
  });

  router.get('/admin/subjects', admin, async (req, res) => {
    try {
      const out = [];
      for (const [kind, def] of Object.entries(SUBJECT_KINDS)) {
        // eslint-disable-next-line no-await-in-loop
        out.push({ kind, label: def.label, slots: def.slots, subjects: await def.list(pool) });
      }
      res.json(out);
    } catch (err) { sendError(res, err); }
  });

  router.get('/admin/slots/:kind/:key', admin, async (req, res) => {
    try { res.json(await lib.subjectSlots(pool, req.params.kind, req.params.key)); }
    catch (err) { sendError(res, err); }
  });

  router.post('/admin/propose', admin, async (req, res) => {
    const { subject_kind: kind, subject_key: key, slot } = req.body || {};
    const clipKind = slotKind(kind, slot);
    if (!clipKind || typeof key !== 'string') return res.status(400).json({ error: 'unknown subject or slot' });
    try {
      const provider = await resolveAudioProvider(pool, req.body.provider_id);
      if (!provider) return res.status(503).json({ error: 'No active audio provider. Add one under AI Providers with modality "audio".' });
      const r = await rap.propose(provider, { context: await contextFor(pool, kind, key), kind: clipKind });
      if (!r.ok) return res.status(502).json({ error: r.error });
      res.json({ style: r.style, slots: r.slots, prompt: r.prompt });
    } catch (err) { sendError(res, err); }
  });

  router.post('/admin/generate', admin, async (req, res) => {
    const b = req.body || {};
    const clipKind = slotKind(b.subject_kind, b.slot);
    if (!clipKind || typeof b.subject_key !== 'string' || !b.subject_key) {
      return res.status(400).json({ error: 'unknown subject or slot' });
    }
    if (clipKind === 'sfx') return res.status(400).json({ error: 'sfx generation arrives in slice 2' });
    try {
      const provider = await resolveAudioProvider(pool, b.provider_id);
      if (!provider) return res.status(503).json({ error: 'No active audio provider. Add one under AI Providers with modality "audio".' });
      // Always an explicit seed: the box caches by request, so a repeated or
      // omitted seed hands back the previous file (spec §2).
      const seed = Number.isInteger(b.seed) ? b.seed : crypto.randomInt(1, 2 ** 31 - 1);
      const name = `s2-${b.subject_kind}-${b.subject_key}-${b.slot}-${seed}`.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 120);
      const gen = await rap.generateTrack(provider, {
        kind: clipKind, name, style: b.style || null, prompt: b.prompt || null, slots: b.slots || null, seed,
      });
      if (!gen.ok) return res.status(502).json({ error: gen.error, retryable: Boolean(gen.retryable) });
      const clip = await lib.storeClip(pool, {
        buffer: gen.buffer, kind: clipKind, label: `${b.subject_key} ${b.slot}${b.style ? ` (${b.style})` : ''}`,
        source: 'generated', providerId: provider.id, prompt: gen.prompt, styleOrCue: b.style || null,
        seed: gen.seed, durationMs: gen.durationMs, loopStartMs: gen.loopStartMs, loopEndMs: gen.loopEndMs,
      });
      const binding = await lib.bindClip(pool, { subjectKind: b.subject_kind, subjectKey: b.subject_key, slot: b.slot, clipId: clip.id });
      res.status(201).json({ clip, binding });
    } catch (err) { sendError(res, err); }
  });

  router.post('/admin/upload', admin, express.raw({ type: 'audio/ogg', limit: '8mb' }), async (req, res) => {
    const { subject_kind: kind, subject_key: key, slot, label } = req.query;
    const clipKind = slotKind(kind, slot);
    if (!clipKind || !key) return res.status(400).json({ error: 'unknown subject or slot' });
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'send the file as Content-Type: audio/ogg' });
    const checked = checkClipBuffer(req.body, clipKind);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    try {
      const clip = await lib.storeClip(pool, {
        buffer: req.body, kind: clipKind, label: String(label || `${key} ${slot} (upload)`).slice(0, 200),
        source: 'uploaded', durationMs: checked.durationMs,
      });
      const binding = await lib.bindClip(pool, { subjectKind: kind, subjectKey: key, slot, clipId: clip.id });
      res.status(201).json({ clip, binding });
    } catch (err) { sendError(res, err); }
  });

  router.patch('/admin/bindings/:id', admin, async (req, res) => {
    const id = Number(req.params.id);
    const { volume, weight } = req.body || {};
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    if (volume !== undefined && !(volume >= 0 && volume <= 1)) return res.status(400).json({ error: 'volume must be 0..1' });
    if (weight !== undefined && !(weight > 0)) return res.status(400).json({ error: 'weight must be > 0' });
    try {
      const row = await lib.updateBinding(pool, id, { volume, weight });
      return row ? res.json(row) : res.status(404).json({ error: 'binding not found' });
    } catch (err) { sendError(res, err); }
  });

  router.delete('/admin/bindings/:id', admin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    try { return (await lib.unbind(pool, id)) ? res.status(204).end() : res.status(404).json({ error: 'binding not found' }); }
    catch (err) { sendError(res, err); }
  });

  router.delete('/admin/clips/:id', admin, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'id must be a uuid' });
    try { return (await lib.deleteClip(pool, req.params.id)) ? res.status(204).end() : res.status(404).json({ error: 'clip not found' }); }
    catch (err) { sendError(res, err); }
  });

  router.get('/admin/misses', admin, async (req, res) => {
    try { res.json(await lib.listMisses(pool)); } catch (err) { sendError(res, err); }
  });

  return router;
};
```

- [ ] **Step 4: Wire it into `backend/src/index.js`**

```js
// near the other api/*Routes requires at the top:
const audioRoutes = require('./api/audioRoutes.js');
const remoteAudioProvider = require('./services/remoteAudioProvider');

// after app.use('/api/characters', ...):
// Game audio (spec docs/superpowers/specs/2026-09-28-game-audio-design.md).
// Player routes (world bundle, misses) and admin routes (/admin/*) share one
// mount; each route carries its own guard.
app.use('/api/audio', audioRoutes(guardPool));
```

```js
// in GET /api/assets/*, add the audio type beside png/json:
    else if (/\.ogg$/i.test(key)) res.type('audio/ogg');
```

```js
// in POST /api/ai-providers/:id/refresh-models, right after the 404 check:
    if (provider.modality === 'audio') {
      const r = await remoteAudioProvider.listStyles(provider);
      if (!r.ok) return res.json({ ok: false, error: r.error, status: r.status ?? null });
      const models = [...r.styles.map((s) => s.value), ...r.cues.map((c) => `cue:${c.value}`)];
      await aiProviders.saveModelsCache(pool, id, models);
      return res.json({ ok: true, models, styles: r.styles, cues: r.cues });
    }
```

  **Check the body parser order.** `app.use(express.json({ limit: '256kb' }))`
  runs globally, but it only parses `application/json`, so an `audio/ogg`
  body reaches `express.raw` intact. The upload test proves it.

- [ ] **Step 5: Run the tests and confirm they pass.**
  Run: `cd backend && node --test tests/audio_routes_db.test.js tests/assets_route.test.js tests/ai_providers.test.js; echo $?`
  Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api/audioRoutes.js backend/src/index.js backend/tests/audio_routes_db.test.js
git commit -m "feat(audio): world bundle, misses, admin generate/upload/bindings routes; .ogg assets (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Per-chunk biome grid on the chunk route

**Files:**
- Modify: `backend/src/services/mapService.js` (add + export `chunkBiomeGrid`
  next to `sampleBiomeRegion`, ~line 450)
- Modify: `backend/src/index.js`, `GET /api/worlds/:id/chunk` (~line 4757).
  Both `res.json({ world_id, cx, cy, data, decorations })` calls gain `biomes`.
- Test: `backend/tests/chunk_biome_grid.test.js`

**Interfaces:**
- Produces:
  - `chunkBiomeGrid(cfg, cx, cy, chunkSize, step = 8) -> (string|null)[][]`,
    row-major, `ceil(chunkSize/step)` square. Cell `[r][c]` is the biome name
    at tile `(cy*chunkSize + r*step + step/2, cx*chunkSize + c*step + step/2)`.
  - The chunk response field `biomes` holds that grid. It is `null` when the
    world declares no biomes.
  - Payload: 64 names for a 64-tile chunk (about 1 KB).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/chunk_biome_grid.test.js
const test = require('node:test');
const assert = require('node:assert');
const { chunkBiomeGrid, sampleBiomeRegion, worldConfig } = require('../src/services/mapService');

function cfgWithBiomes() {
  return worldConfig({
    seed: 12345, chunkSize: 64, width: 400, height: 400, biomeCell: 40,
    tileTypes: { grass: { walkable: true }, sand: { walkable: true } },
    biomes: [{ name: 'forest', terrain_tiles: ['grass'] }, { name: 'desert', terrain_tiles: ['sand'] }],
  });
}

test('chunkBiomeGrid matches sampleBiomeRegion at each cell centre', () => {
  const cfg = cfgWithBiomes();
  const grid = chunkBiomeGrid(cfg, 2, 1, 64, 8);
  assert.equal(grid.length, 8);
  assert.equal(grid[0].length, 8);
  for (const [r, c] of [[0, 0], [3, 5], [7, 7]]) {
    const expected = sampleBiomeRegion(cfg, 1 * 64 + r * 8 + 4, 2 * 64 + c * 8 + 4);
    assert.equal(grid[r][c], expected ? expected.name : null);
  }
  const names = new Set(grid.flat());
  assert.ok([...names].every((n) => n === 'forest' || n === 'desert'));
});

test('chunkBiomeGrid is null for a world without biomes', () => {
  const cfg = worldConfig({ seed: 1, chunkSize: 64, tileTypes: { grass: { walkable: true } } });
  assert.equal(chunkBiomeGrid(cfg, 0, 0, 64), null);
});
```

- [ ] **Step 2: Run it and confirm it fails.**
  Run: `cd backend && node --test tests/chunk_biome_grid.test.js; echo $?`
  Expected: FAIL `chunkBiomeGrid is not a function`.
  - If `worldConfig`'s input keys differ from the ones above (read
    `worldConfig` at mapService.js:209), fix the **fixture** to match its real
    input shape. The assertion compares against `sampleBiomeRegion` itself, so
    it stays meaningful.
  - If every cell comes back the same biome, lower `biomeCell` until the
    `names` check sees the real field. Never delete that check.

- [ ] **Step 3: Implement** in `mapService.js`, below `sampleBiomeRegion`:

```js
// Game audio (spec §3 "Ambience"): the client needs to know which biome the
// player stands in, and it already streams chunks -- so each chunk carries a
// coarse grid of biome names computed from the SAME field terrain uses. One
// cell per `step` tiles; biome regions are far larger than that, so ambience
// is exact to within a few tiles of a border.
function chunkBiomeGrid(cfg, cx, cy, chunkSize, step = 8) {
  if (!cfg.biomes || cfg.biomes.length === 0) return null;
  const n = Math.ceil(chunkSize / step);
  const half = Math.floor(step / 2);
  const grid = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) {
      const region = sampleBiomeRegion(cfg, cy * chunkSize + r * step + half, cx * chunkSize + c * step + half);
      row.push(region ? region.name : null);
    }
    grid.push(row);
  }
  return grid;
}
```

  Add `chunkBiomeGrid,` to `module.exports`. In the chunk route, compute
  `const biomes = chunkBiomeGrid(worldCfg, cx, cy, world.chunk_size || 64);`
  once after `worldCfg` is built, and add `biomes` to **both**
  `res.json({ ... })` calls. Import it with the other mapService functions at
  the top of index.js.

- [ ] **Step 4: Run the tests and confirm they pass.**
  Run: `cd backend && node --test tests/chunk_biome_grid.test.js; echo $?`. Expected: `0`.
  - Then run any existing chunk-route test (`grep -l "/chunk" backend/tests/*.test.js`).
    If one pins the exact response keys, add `biomes` to its expectation;
    don't loosen it.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/mapService.js backend/src/index.js backend/tests/chunk_biome_grid.test.js
git commit -m "feat(map): chunk responses carry a coarse biome grid for ambience (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Client — chunks keep their biome grid

**Files:**
- Modify: `frontend/src/games/something2/src/js/net/chunkFetcher.js:17-18`
- Modify: `frontend/src/games/something2/src/js/net/ChunkStreamer.js:53`
- Modify: `frontend/src/games/something2/src/js/core/ChunkedMap.js` (`setChunk`, `removeChunk`, new `biomeAt`)
- Test: `frontend/src/games/something2/src/js/core/__tests__/chunkedMapBiome.test.js`

**Interfaces:**
- Produces:
  - `fetchChunk` returns `{ tiles, decorations, biomes }` (`biomes` may be
    null)
  - `ChunkedMap.setChunk(cx, cy, grid, decorations = [], biomes = null)`
  - `ChunkedMap.biomeAt(worldX, worldY) -> string|null`. It returns null when
    the chunk isn't loaded or has no grid.
- World pixels → tile: `MAP_TILE_SIZE` (100) from `core/constants.js`. Read
  `getTileAt` in ChunkedMap.js for the exact world→chunk→local conversion and
  **reuse it** rather than re-deriving it.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/games/something2/src/js/core/__tests__/chunkedMapBiome.test.js
import { describe, it, expect } from 'vitest';
import { ChunkedMap } from '../ChunkedMap.js';
import { MAP_TILE_SIZE } from '../constants.js';

const size = 64;
const grid = Array.from({ length: size }, () => Array(size).fill('grass'));
const biomes = Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => (c < 4 ? 'forest' : 'desert')));

describe('ChunkedMap.biomeAt', () => {
  it('reads the chunk biome grid at the 8-tile cell under a world position', () => {
    const m = new ChunkedMap(size);
    m.setChunk(1, 0, grid, [], biomes);
    const x0 = 1 * size * MAP_TILE_SIZE;
    expect(m.biomeAt(x0 + 2 * MAP_TILE_SIZE, 5 * MAP_TILE_SIZE)).toBe('forest');   // tile col 2 -> cell 0
    expect(m.biomeAt(x0 + 40 * MAP_TILE_SIZE, 5 * MAP_TILE_SIZE)).toBe('desert');  // tile col 40 -> cell 5
  });
  it('is null for an unloaded chunk, a chunk without a grid, and after removal', () => {
    const m = new ChunkedMap(size);
    expect(m.biomeAt(0, 0)).toBe(null);
    m.setChunk(0, 0, grid, []);
    expect(m.biomeAt(0, 0)).toBe(null);
    m.setChunk(0, 0, grid, [], biomes);
    m.removeChunk(0, 0);
    expect(m.biomeAt(0, 0)).toBe(null);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**
  Run: `cd frontend && npx vitest run src/games/something2/src/js/core/__tests__/chunkedMapBiome.test.js`
  Expected: FAIL `m.biomeAt is not a function`. If `ChunkedMap` is a default
  export, fix the import in the test.

- [ ] **Step 3: Implement.**
  - `ChunkedMap`:
    - add `this.biomes = new Map()` in the constructor;
    - in `setChunk`, `if (biomes) this.biomes.set(CHUNK_KEY(cx, cy), biomes); else this.biomes.delete(CHUNK_KEY(cx, cy));`;
    - in `removeChunk`, delete from `this.biomes`;
    - add:

```js
    // Game audio: the biome under a world position, from the coarse grid the
    // chunk route sends (one cell per 8x8 tiles). null = unknown, which the
    // ambience tracker treats as "keep what is playing".
    biomeAt(worldX, worldY) {
        const col = Math.floor(worldX / MAP_TILE_SIZE);
        const row = Math.floor(worldY / MAP_TILE_SIZE);
        const cx = Math.floor(col / this.chunkSize);
        const cy = Math.floor(row / this.chunkSize);
        const g = this.biomes.get(CHUNK_KEY(cx, cy));
        if (!g) return null;
        const step = this.chunkSize / g.length;
        const r = Math.floor((row - cy * this.chunkSize) / step);
        const c = Math.floor((col - cx * this.chunkSize) / step);
        return (g[r] && g[r][c]) || null;
    }
```

  (Import `MAP_TILE_SIZE` if ChunkedMap.js doesn't already. If `getTileAt`
  uses a different world→tile rule, use that rule here too.)
  - `chunkFetcher.js`: `return { tiles: body.data, decorations: body.decorations || [], biomes: body.biomes || null };`
  - `ChunkStreamer.js:53`: `this.map.setChunk(lcx, lcy, chunk.tiles, chunk.decorations, chunk.biomes);`

- [ ] **Step 4: Run the tests and confirm they pass.**
  Run: `cd frontend && npx vitest run src/games/something2/src/js`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/core/ChunkedMap.js frontend/src/games/something2/src/js/net/chunkFetcher.js frontend/src/games/something2/src/js/net/ChunkStreamer.js frontend/src/games/something2/src/js/core/__tests__/chunkedMapBiome.test.js
git commit -m "feat(client): keep each chunk's biome grid and answer biomeAt (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Client audio — pure pieces (lookup, pick, hysteresis, misses, settings)

**Files:**
- Create in `frontend/src/games/something2/src/js/audio/`: `audioLookup.js`, `biomeTracker.js`, `missLog.js`, `audioSettings.js`
- Test: `frontend/src/games/something2/src/js/audio/__tests__/audioPure.test.js`

**Interfaces:**
- `audioLookup.js`:
  - `resolveChain(bindings, keys: string[]) -> { clips, key } | { clips: [], key: null, missKey: keys[0] }`
    returns the first key with a non-empty list.
  - `pickWeighted(clips, rand = Math.random) -> clip|null`
  - `ambienceChain(world, biome) -> string[]` returns
    `['biome/<biome>/ambience', 'world/<world>/ambience']`, with the biome
    entry omitted when `biome` is null.
  - `musicChain(world) -> ['world/<world>/music']`
- `biomeTracker.js`: `class BiomeTracker { constructor({ holdMs = 1500 }); sample(biome, nowMs) -> string|null|undefined }`.
  It returns the new committed biome when it changes, and `undefined` when
  nothing changed. A null sample is ignored, meaning "unknown, keep current".
- `missLog.js`: `class MissLog { record(missKey, world) -> boolean(first time); drain() -> [{ subject_kind, subject_key, slot, world }] }`
- `audioSettings.js`:
  - `DEFAULT_VOLUMES = { master: 0.8, music: 0.35, ambience: 0.6, sfx: 0.8, muted: false }`
  - `loadVolumes(storage = globalThis.localStorage) -> volumes`
  - `saveVolumes(v, storage) -> void`
  - Both never throw.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/games/something2/src/js/audio/__tests__/audioPure.test.js
import { describe, it, expect } from 'vitest';
import { resolveChain, pickWeighted, ambienceChain, musicChain } from '../audioLookup.js';
import { BiomeTracker } from '../biomeTracker.js';
import { MissLog } from '../missLog.js';
import { loadVolumes, saveVolumes, DEFAULT_VOLUMES } from '../audioSettings.js';

describe('resolveChain', () => {
  const b = { 'world/vale/ambience': [{ key: 'w' }], 'biome/forest/ambience': [] };
  it('falls back biome -> world and reports the most specific miss when all are empty', () => {
    expect(resolveChain(b, ambienceChain('vale', 'forest'))).toEqual({ clips: [{ key: 'w' }], key: 'world/vale/ambience' });
    expect(resolveChain({}, ambienceChain('vale', 'forest'))).toEqual({ clips: [], key: null, missKey: 'biome/forest/ambience' });
    expect(ambienceChain('vale', null)).toEqual(['world/vale/ambience']);
    expect(musicChain('vale')).toEqual(['world/vale/music']);
  });
});

describe('pickWeighted', () => {
  it('respects weights and handles empty lists', () => {
    const clips = [{ key: 'a', weight: 1 }, { key: 'b', weight: 3 }];
    expect(pickWeighted(clips, () => 0.1).key).toBe('a');
    expect(pickWeighted(clips, () => 0.5).key).toBe('b');
    expect(pickWeighted([], () => 0.5)).toBe(null);
  });
});

describe('BiomeTracker', () => {
  it('commits a new biome only after it holds for holdMs; border flicker never switches', () => {
    const t = new BiomeTracker({ holdMs: 1500 });
    expect(t.sample('forest', 0)).toBe('forest');           // first known biome commits at once
    for (let ms = 100; ms < 3000; ms += 200) {                // flicker every 200 ms
      expect(t.sample(ms % 400 === 100 ? 'desert' : 'forest', ms)).toBeUndefined();
    }
    expect(t.sample('desert', 3000)).toBeUndefined();
    expect(t.sample('desert', 4499)).toBeUndefined();
    expect(t.sample('desert', 4500)).toBe('desert');
    expect(t.sample(null, 5000)).toBeUndefined();            // unknown keeps current
  });
});

describe('MissLog', () => {
  it('records each key once and drains in the server shape', () => {
    const m = new MissLog();
    expect(m.record('biome/forest/ambience', 'vale')).toBe(true);
    expect(m.record('biome/forest/ambience', 'vale')).toBe(false);
    expect(m.drain()).toEqual([{ subject_kind: 'biome', subject_key: 'forest', slot: 'ambience', world: 'vale' }]);
    expect(m.drain()).toEqual([]);
    expect(m.record('biome/forest/ambience', 'vale')).toBe(false); // still once per session
  });
  it('keeps subject keys that contain slashes intact', () => {
    const m = new MissLog();
    m.record('world/Vale/North/music', 'x');
    expect(m.drain()[0]).toMatchObject({ subject_kind: 'world', subject_key: 'Vale/North', slot: 'music' });
  });
});

describe('audioSettings', () => {
  it('returns defaults when storage throws, and round-trips when it works', () => {
    const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    expect(loadVolumes(throwing)).toEqual(DEFAULT_VOLUMES);
    expect(() => saveVolumes({ ...DEFAULT_VOLUMES, music: 0.1 }, throwing)).not.toThrow();
    const mem = new Map();
    const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    saveVolumes({ ...DEFAULT_VOLUMES, music: 0.1 }, store);
    expect(loadVolumes(store).music).toBe(0.1);
    store.setItem('something2.audio.volumes', '{"music": 7, "master": "loud"}');
    expect(loadVolumes(store)).toEqual(DEFAULT_VOLUMES);     // out-of-range and wrong types fall back
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**
  Run: `cd frontend && npx vitest run src/games/something2/src/js/audio`. Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```js
// audioLookup.js
// Pure resolution of "what should play" (spec §1 "Lookup chains"). A chain is
// a list of binding keys, most specific first; the first non-empty one wins.
export function resolveChain(bindings, keys) {
  for (const key of keys) {
    const clips = bindings && bindings[key];
    if (Array.isArray(clips) && clips.length > 0) return { clips, key };
  }
  return { clips: [], key: null, missKey: keys[0] };
}

export function pickWeighted(clips, rand = Math.random) {
  if (!Array.isArray(clips) || clips.length === 0) return null;
  const total = clips.reduce((s, c) => s + (c.weight > 0 ? c.weight : 1), 0);
  let x = rand() * total;
  for (const c of clips) {
    x -= c.weight > 0 ? c.weight : 1;
    if (x < 0) return c;
  }
  return clips[clips.length - 1];
}

export const ambienceChain = (world, biome) =>
  (biome ? [`biome/${biome}/ambience`] : []).concat(`world/${world}/ambience`);
export const musicChain = (world) => [`world/${world}/music`];
```

```js
// biomeTracker.js
// Hysteresis for ambience (spec §3): a new biome must hold for holdMs before
// it replaces the current one, so walking a border does not restart loops.
export class BiomeTracker {
  constructor({ holdMs = 1500 } = {}) {
    this.holdMs = holdMs;
    this.current = undefined;
    this.candidate = null;
    this.since = 0;
  }

  sample(biome, nowMs) {
    if (biome == null) return undefined;
    if (this.current === undefined) { this.current = biome; return biome; }
    if (biome === this.current) { this.candidate = null; return undefined; }
    if (biome !== this.candidate) { this.candidate = biome; this.since = nowMs; return undefined; }
    if (nowMs - this.since >= this.holdMs) {
      this.current = biome;
      this.candidate = null;
      return biome;
    }
    return undefined;
  }
}
```

```js
// missLog.js
// Sounds the game wanted and did not have (spec §3 "Misses log"). Each key is
// recorded once per session; drain() hands the unsent ones to the poster.
export class MissLog {
  constructor() { this.seen = new Set(); this.pending = []; }

  record(missKey, world) {
    if (!missKey || this.seen.has(missKey)) return false;
    this.seen.add(missKey);
    const first = missKey.indexOf('/');
    const last = missKey.lastIndexOf('/');
    if (first < 0 || last <= first) return false;
    this.pending.push({
      subject_kind: missKey.slice(0, first),
      subject_key: missKey.slice(first + 1, last),
      slot: missKey.slice(last + 1),
      world: world || null,
    });
    return true;
  }

  drain() { const out = this.pending; this.pending = []; return out; }
}
```

```js
// audioSettings.js
// Per-viewer volumes. Storage can throw (private window, blocked site data),
// so every access is wrapped and a bad value falls back to the default.
const KEY = 'something2.audio.volumes';
export const DEFAULT_VOLUMES = Object.freeze({ master: 0.8, music: 0.35, ambience: 0.6, sfx: 0.8, muted: false });

const inRange = (v) => typeof v === 'number' && v >= 0 && v <= 1;

export function loadVolumes(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(KEY);
    if (!raw) return { ...DEFAULT_VOLUMES };
    const p = JSON.parse(raw);
    const out = { ...DEFAULT_VOLUMES };
    for (const k of ['master', 'music', 'ambience', 'sfx']) if (inRange(p[k])) out[k] = p[k];
    if (typeof p.muted === 'boolean') out.muted = p.muted;
    const anyBad = ['master', 'music', 'ambience', 'sfx'].some((k) => k in p && !inRange(p[k]));
    return anyBad ? { ...DEFAULT_VOLUMES } : out;
  } catch (_) {
    return { ...DEFAULT_VOLUMES };
  }
}

export function saveVolumes(v, storage = globalThis.localStorage) {
  try { if (storage) storage.setItem(KEY, JSON.stringify(v)); } catch (_) { /* per-viewer convenience only */ }
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `cd frontend && npx vitest run src/games/something2/src/js/audio`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/src/js/audio
git commit -m "feat(client-audio): lookup chains, weighted pick, biome hysteresis, miss log, volume storage (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `AudioEngine` + `audioClient` + Game integration

**Files:**
- Create: `frontend/src/games/something2/src/js/audio/AudioEngine.js`, `.../audio/audioClient.js`
- Modify: `frontend/src/games/something2/src/js/core/Game.js`:
  - `initChunked` (~line 502, after `this.worldId = worldId;`)
  - `update(dt)` (~line 1171)
  - `destroy()` (~line 1154)
- Test: `frontend/src/games/something2/src/js/audio/__tests__/AudioEngine.test.js`

**Interfaces:**
- `audioClient.js`:
  - `fetchWorldAudio(worldId) -> { world, bindings }`, or `{ world: null, bindings: {} }` on any failure (with one `console.warn`)
  - `postMisses(misses) -> Promise<void>`, which never throws
- `AudioEngine`:
  - `new AudioEngine({ ctxFactory = () => new AudioContext(), fetchBytes = (url) => fetch(url).then(r => r.arrayBuffer()), urlFor = (key) => assetUrl(API_URL, key), now = () => performance.now(), rand = Math.random, postMisses = audioClientPostMisses })`
  - `setWorld({ world, bindings })` crossfades music to the new world and resets the biome tracker
  - `tick(biome, nowMs)`: call every frame; it samples the biome at most every 500 ms
  - `setVolumes(v)`, `volumes()`
  - `unlock()`: resume the context; call from user input
  - `snapshot() -> { state, world, biome, music: { key, playing }, ambience: { key, playing }, gains: {...} }`
  - `flushMisses()` posts the drained misses
  - `destroy()`
  - `window.__s2audio = () => engine.snapshot()` is set only when `import.meta.env.DEV`
- Buses: `master ← music, ambience` (GainNodes). Music ends → 3–8 s gap → next
  weighted pick (a single clip repeats after the gap). Ambience loops, using
  the clip's `loop_start_ms`/`loop_end_ms` when present, and crossfades over
  2 s on change. Music crossfades over 2 s on world change.

- [ ] **Step 1: Write the failing test** with a fake AudioContext that records
  every node, so the test asserts real graph behaviour, not calls into its own
  mock.

```js
// frontend/src/games/something2/src/js/audio/__tests__/AudioEngine.test.js
import { describe, it, expect } from 'vitest';
import { AudioEngine } from '../AudioEngine.js';

function fakeCtx() {
  const sources = [];
  const ctx = {
    state: 'suspended', currentTime: 0, destination: { name: 'dest' },
    resume() { this.state = 'running'; return Promise.resolve(); },
    close() { this.state = 'closed'; return Promise.resolve(); },
    createGain() {
      return { gain: { value: 1, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; }, cancelScheduledValues() {} },
        connect(n) { this.out = n; }, disconnect() { this.out = null; } };
    },
    createBufferSource() {
      const s = { buffer: null, loop: false, loopStart: 0, loopEnd: 0, started: false, stopped: false, onended: null,
        connect(n) { this.out = n; }, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(s);
      return s;
    },
    decodeAudioData: async (ab) => ({ duration: 2, tag: new TextDecoder().decode(ab) }),
  };
  return { ctx, sources };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function engineWith(bindings, { posted = [] } = {}) {
  const { ctx, sources } = fakeCtx();
  const engine = new AudioEngine({
    ctxFactory: () => ctx,
    fetchBytes: async (url) => new TextEncoder().encode(url).buffer,
    urlFor: (k) => `u:${k}`,
    rand: () => 0,
    postMisses: async (m) => { posted.push(...m); },
  });
  engine.setWorld({ world: 'vale', bindings });
  return { engine, ctx, sources, posted };
}

describe('AudioEngine', () => {
  it('plays world music and biome ambience on their own buses', async () => {
    const { engine, sources } = engineWith({
      'world/vale/music': [{ key: 'm.ogg', volume: 1, weight: 1, loopable: true }],
      'biome/forest/ambience': [{ key: 'f.ogg', volume: 0.5, weight: 1, loopable: true, loop_start_ms: 0, loop_end_ms: 1500 }],
    });
    engine.unlock();
    engine.tick('forest', 0);
    await flush(); await flush();
    const snap = engine.snapshot();
    expect(snap.music).toMatchObject({ key: 'm.ogg', playing: true });
    expect(snap.ambience).toMatchObject({ key: 'f.ogg', playing: true });
    const amb = sources.find((s) => s.buffer && s.buffer.tag === 'u:f.ogg');
    expect(amb.loop).toBe(true);
    expect(amb.loopEnd).toBe(1.5);
  });

  it('falls back to world ambience, and logs + posts one miss when nothing is bound', async () => {
    const { engine, posted } = engineWith({});
    engine.unlock();
    engine.tick('desert', 0);
    engine.tick('desert', 600);
    await flush();
    expect(engine.snapshot().ambience.playing).toBe(false);
    await engine.flushMisses();
    expect(posted).toEqual([
      { subject_kind: 'world', subject_key: 'vale', slot: 'music', world: 'vale' },
      { subject_kind: 'biome', subject_key: 'desert', slot: 'ambience', world: 'vale' },
    ]);
  });

  it('mute and volumes drive the master and bus gains', () => {
    const { engine } = engineWith({});
    engine.setVolumes({ master: 0.5, music: 0.2, ambience: 1, sfx: 1, muted: true });
    expect(engine.snapshot().gains).toMatchObject({ master: 0, music: 0.2, ambience: 1 });
    engine.setVolumes({ master: 0.5, music: 0.2, ambience: 1, sfx: 1, muted: false });
    expect(engine.snapshot().gains.master).toBe(0.5);
  });

  it('a decode failure is silence plus a warning, never a throw', async () => {
    const { ctx, sources } = fakeCtx();
    ctx.decodeAudioData = async () => { throw new Error('bad data'); };
    const engine = new AudioEngine({ ctxFactory: () => ctx, fetchBytes: async () => new ArrayBuffer(4), urlFor: (k) => k, rand: () => 0, postMisses: async () => {} });
    engine.setWorld({ world: 'vale', bindings: { 'world/vale/music': [{ key: 'x.ogg', weight: 1, volume: 1 }] } });
    engine.unlock();
    await flush(); await flush();
    expect(engine.snapshot().music.playing).toBe(false);
    expect(sources.every((s) => !s.started)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `cd frontend && npx vitest run src/games/something2/src/js/audio`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement `audioClient.js`**

```js
// audioClient.js -- the two player routes (spec §3).
import { API_URL } from '../../../../../config.js';
import { authHeaders } from '../net/auth.js';

export async function fetchWorldAudio(worldId) {
  try {
    const res = await fetch(`${API_URL}/api/audio/world/${worldId}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[audio] no sound for world ${worldId}: ${err.message}`);
    return { world: null, bindings: {} };
  }
}

export async function postMisses(misses) {
  if (!misses.length) return;
  try {
    await fetch(`${API_URL}/api/audio/misses`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ misses }) });
  } catch (_) { /* best-effort: a lost miss report costs nothing */ }
}
```

- [ ] **Step 4: Implement `AudioEngine.js`**

```js
// AudioEngine.js -- plain Web Audio playback for music + ambience (spec §3).
// Never throws into the frame: every failure is silence plus one warning per
// clip URL per session. Slice 3 adds an sfx bus beside these two.
import { API_URL } from '../../../../../config.js';
import { assetUrl } from '../net/assets.js';
import { resolveChain, pickWeighted, ambienceChain, musicChain } from './audioLookup.js';
import { BiomeTracker } from './biomeTracker.js';
import { MissLog } from './missLog.js';
import { DEFAULT_VOLUMES } from './audioSettings.js';
import { postMisses as defaultPostMisses } from './audioClient.js';

const FADE_S = 2;
const BIOME_SAMPLE_MS = 500;
const MUSIC_GAP_MS = [3000, 8000];

export class AudioEngine {
  constructor({
    ctxFactory = () => new AudioContext(),
    fetchBytes = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }),
    urlFor = (key) => assetUrl(API_URL, key),
    now = () => performance.now(),
    rand = Math.random,
    postMisses = defaultPostMisses,
  } = {}) {
    Object.assign(this, { ctxFactory, fetchBytes, urlFor, now, rand, postMisses });
    this.ctx = null;
    this.buffers = new Map();   // url -> Promise<AudioBuffer|null>
    this.warned = new Set();
    this.misses = new MissLog();
    this.tracker = new BiomeTracker({ holdMs: 1500 });
    this.world = null;
    this.bindings = {};
    this.biome = null;
    this.lastBiomeSample = -Infinity;
    this.vol = { ...DEFAULT_VOLUMES };
    this.channels = { music: { key: null, node: null, gain: null }, ambience: { key: null, node: null, gain: null } };
    this.musicTimer = null;
  }

  _ensureCtx() {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = this.ctxFactory();
    } catch (err) {
      this._warn('ctx', `[audio] Web Audio unavailable: ${err.message}`);
      return null;
    }
    const g = () => this.ctx.createGain();
    this.bus = { master: g(), music: g(), ambience: g() };
    this.bus.music.connect(this.bus.master);
    this.bus.ambience.connect(this.bus.master);
    this.bus.master.connect(this.ctx.destination);
    this._applyGains();
    return this.ctx;
  }

  _warn(key, msg) { if (!this.warned.has(key)) { this.warned.add(key); console.warn(msg); } }

  _applyGains() {
    if (!this.bus) return;
    this.bus.master.gain.value = this.vol.muted ? 0 : this.vol.master;
    this.bus.music.gain.value = this.vol.music;
    this.bus.ambience.gain.value = this.vol.ambience;
  }

  setVolumes(v) { this.vol = { ...this.vol, ...v }; this._ensureCtx(); this._applyGains(); }
  volumes() { return { ...this.vol }; }

  unlock() {
    const ctx = this._ensureCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (this.world && !this.channels.music.key) this._startMusic();
  }

  setWorld({ world, bindings }) {
    this.world = world;
    this.bindings = bindings || {};
    this.tracker = new BiomeTracker({ holdMs: 1500 });
    this.biome = null;
    this.lastBiomeSample = -Infinity;
    this._stop('ambience');
    this._stop('music');
    if (world) this._startMusic();
  }

  tick(biome, nowMs = this.now()) {
    if (!this.world || nowMs - this.lastBiomeSample < BIOME_SAMPLE_MS) return;
    this.lastBiomeSample = nowMs;
    const committed = this.tracker.sample(biome, nowMs);
    if (committed !== undefined) { this.biome = committed; this._switchAmbience(); }
  }

  _resolve(chain) {
    const r = resolveChain(this.bindings, chain);
    if (!r.key) this.misses.record(r.missKey, this.world);
    return r;
  }

  _startMusic() {
    if (!this.world) return;
    const { clips } = this._resolve(musicChain(this.world));
    const clip = pickWeighted(clips, this.rand);
    if (clip) this._play('music', clip, { loop: false });
  }

  _switchAmbience() {
    const { clips, key } = this._resolve(ambienceChain(this.world, this.biome));
    if (key && this.channels.ambience.chainKey === key) return;   // same source already playing
    const clip = pickWeighted(clips, this.rand);
    this.channels.ambience.chainKey = key;
    if (!clip) { this._stop('ambience'); return; }
    this._play('ambience', clip, { loop: true });
  }

  async _buffer(url) {
    if (!this.buffers.has(url)) {
      this.buffers.set(url, (async () => {
        try {
          const bytes = await this.fetchBytes(url);
          return await this.ctx.decodeAudioData(bytes);
        } catch (err) {
          this._warn(url, `[audio] could not load ${url}: ${err.message}`);
          return null;
        }
      })());
    }
    return this.buffers.get(url);
  }

  async _play(channel, clip, { loop }) {
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const ch = this.channels[channel];
    const token = Symbol(channel);
    ch.pending = token;
    const buffer = await this._buffer(this.urlFor(clip.key));
    if (ch.pending !== token) return;            // superseded while loading
    if (!buffer) { this._stop(channel); return; }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (loop) {
      src.loop = true;
      if (clip.loop_end_ms > 0) {
        src.loopStart = (clip.loop_start_ms || 0) / 1000;
        src.loopEnd = clip.loop_end_ms / 1000;
      }
    }
    const gain = ctx.createGain();
    const target = typeof clip.volume === 'number' ? clip.volume : 1;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(target, ctx.currentTime + FADE_S);
    src.connect(gain);
    gain.connect(this.bus[channel]);
    this._fadeOut(ch);
    Object.assign(ch, { key: clip.key, node: src, gain });
    if (channel === 'music') {
      src.onended = () => {
        if (ch.node !== src) return;
        ch.key = null; ch.node = null;
        const [lo, hi] = MUSIC_GAP_MS;
        this.musicTimer = setTimeout(() => this._startMusic(), lo + this.rand() * (hi - lo));
      };
    }
    src.start();
  }

  _fadeOut(ch) {
    if (!ch.node || !this.ctx) return;
    const { node, gain } = ch;
    try {
      gain.gain.cancelScheduledValues(this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + FADE_S);
      node.onended = null;
      node.stop(this.ctx.currentTime + FADE_S);
    } catch (_) { /* already stopped */ }
  }

  _stop(channel) {
    const ch = this.channels[channel];
    ch.pending = null;
    this._fadeOut(ch);
    Object.assign(ch, { key: null, node: null, gain: null, chainKey: undefined });
    if (channel === 'music' && this.musicTimer) { clearTimeout(this.musicTimer); this.musicTimer = null; }
  }

  async flushMisses() { await this.postMisses(this.misses.drain()); }

  snapshot() {
    const ch = (c) => ({ key: this.channels[c].key, playing: Boolean(this.channels[c].node) });
    return {
      state: this.ctx ? this.ctx.state : 'none',
      world: this.world,
      biome: this.biome,
      music: ch('music'),
      ambience: ch('ambience'),
      gains: this.bus ? { master: this.bus.master.gain.value, music: this.bus.music.gain.value, ambience: this.bus.ambience.gain.value } : null,
    };
  }

  destroy() {
    this._stop('music');
    this._stop('ambience');
    this.flushMisses();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    this.bus = null;
  }
}
```

  The miss test expects the music miss **before** the ambience miss.
  `setWorld` resolves music first, so that order holds; keep it.

- [ ] **Step 5: Wire it into `Game.js`.** Import at the top:

```js
import { AudioEngine } from '../audio/AudioEngine.js';
import { fetchWorldAudio } from '../audio/audioClient.js';
import { loadVolumes } from '../audio/audioSettings.js';
```

  In `initChunked`, after `this.worldId = worldId;`:

```js
        // Game audio (spec §3). One engine per Game; a re-entry (new world)
        // swaps its world rather than building a second AudioContext.
        if (!this.audio) {
            this.audio = new AudioEngine();
            this.audio.setVolumes(loadVolumes());
            if (import.meta.env && import.meta.env.DEV) window.__s2audio = () => this.audio.snapshot();
            this._audioMissTimer = setInterval(() => this.audio && this.audio.flushMisses(), 30000);
        }
        this.audio.unlock(); // initChunked runs from the Play click: sticky user activation
        fetchWorldAudio(worldId).then((bundle) => {
            if (this.audio && this.worldId === worldId) this.audio.setWorld(bundle);
        });
```

  In `update(dt)`, inside `if (this.chunked) {` after `cx`/`cy` are computed:

```js
            if (this.audio) this.audio.tick(this.chunkedMap.biomeAt(cx, cy), performance.now());
```

  In `destroy()`, before `cancelAnimationFrame`:

```js
        if (this._audioMissTimer) clearInterval(this._audioMissTimer);
        if (this.audio) { this.audio.destroy(); this.audio = null; }
```

  Also call `this.audio.unlock()` in the existing keydown and mousedown
  handlers (`this._keydownHandler`, `this._mouseDownHandler`). This covers a
  context that started suspended because `initChunked` ran without a fresh
  gesture (e.g. a resume after reconnect).

- [ ] **Step 6: Run the tests and confirm they pass.** Run: `cd frontend && npx vitest run src/games/something2`. Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/something2/src/js/audio frontend/src/games/something2/src/js/core/Game.js
git commit -m "feat(client-audio): AudioEngine with music rotation and biome ambience crossfade, wired into Game (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Sound tab in the in-game Settings panel

**Files:**
- Modify: `frontend/src/games/something2/GameSettings.jsx`: add the `'sound'`
  tab beside `'general'`/`'keybinds'` (~lines 174-190)
- Test: `frontend/src/games/something2/src/js/audio/__tests__/volumeModel.test.js`

**Interfaces:**
- Consumes: `gameRef.current.audio` (`setVolumes`, `volumes`), plus
  `saveVolumes`/`loadVolumes`.
- Produces: `applyVolumeChange(current, field, value) -> next`, a pure helper
  exported from `audioSettings.js`. It clamps to 0..1 and treats `muted` as a
  boolean.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/games/something2/src/js/audio/__tests__/volumeModel.test.js
import { describe, it, expect } from 'vitest';
import { applyVolumeChange, DEFAULT_VOLUMES } from '../audioSettings.js';

describe('applyVolumeChange', () => {
  it('clamps sliders and toggles mute without touching other fields', () => {
    const v = applyVolumeChange(DEFAULT_VOLUMES, 'music', 1.7);
    expect(v.music).toBe(1);
    expect(v.master).toBe(DEFAULT_VOLUMES.master);
    expect(applyVolumeChange(v, 'ambience', -2).ambience).toBe(0);
    expect(applyVolumeChange(v, 'muted', 'yes').muted).toBe(true);
    expect(applyVolumeChange(v, 'bogus', 0.5)).toEqual(v);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `cd frontend && npx vitest run src/games/something2/src/js/audio`. Expected: FAIL (`applyVolumeChange` not exported).

- [ ] **Step 3: Implement.** Add to `audioSettings.js`:

```js
export function applyVolumeChange(current, field, value) {
  if (field === 'muted') return { ...current, muted: Boolean(value) };
  if (!['master', 'music', 'ambience', 'sfx'].includes(field)) return current;
  const n = Number(value);
  return { ...current, [field]: Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : current[field] };
}
```

  In `GameSettings.jsx`:
  - import `loadVolumes`, `saveVolumes` and `applyVolumeChange`;
  - add `const [volumes, setVolumesState] = useState(loadVolumes);`;
  - add a `TabButton` "Sound" with `$active={activeTab === 'sound'}`;
  - render a `{activeTab === 'sound' && (...)}` block that reuses the file's
    existing `Row` styled component, with a mute checkbox plus three
    `<input type="range" min="0" max="1" step="0.05">` sliders labelled
    Master, Music and Ambience. The SFX slider arrives in slice 3.

  Each `onChange` calls:

```js
  const changeVolume = useCallback((field, value) => {
    setVolumesState((cur) => {
      const next = applyVolumeChange(cur, field, value);
      saveVolumes(next);
      const game = gameRef.current;
      if (game && game.audio) game.audio.setVolumes(next);
      return next;
    });
  }, [gameRef]);
```

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `cd frontend && npx vitest run src/games/something2`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/GameSettings.jsx frontend/src/games/something2/src/js/audio/audioSettings.js frontend/src/games/something2/src/js/audio/__tests__/volumeModel.test.js
git commit -m "feat(settings): Sound tab with master/music/ambience volume and mute (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: AI Providers — modality select, image-only `activeProvider`

**Files:**
- Modify: `frontend/src/games/something2/SettingsAdmin.jsx`: the provider form
- Modify: `frontend/src/games/something2/useAiProviders.js`: `activeProvider` becomes image-only, and add `activeAudioProvider`
- Test: `frontend/src/games/something2/__tests__/aiProvidersModality.test.js`
  (create the folder if the repo keeps hook tests elsewhere; check
  `ls frontend/src/games/something2/__tests__` first and follow what's there)

**Interfaces:**
- Produces: `pickActive(providers, modality) -> provider|null`, a pure function
  exported from `useAiProviders.js`. `useAiProviders()` returns
  `activeProvider: pickActive(data, 'image')` and
  `activeAudioProvider: pickActive(data, 'audio')`. A row without `modality`
  counts as `'image'`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { pickActive } from '../useAiProviders.js';

describe('pickActive', () => {
  const rows = [
    { id: 1, is_active: true, enabled: true, modality: 'audio' },
    { id: 2, is_active: true, enabled: true },                    // legacy row: image
    { id: 3, is_active: true, enabled: false, modality: 'image' },
  ];
  it('never hands the image pickers the audio provider', () => {
    expect(pickActive(rows, 'image').id).toBe(2);
    expect(pickActive(rows, 'audio').id).toBe(1);
    expect(pickActive([], 'audio')).toBe(null);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `cd frontend && npx vitest run src/games/something2/__tests__/aiProvidersModality.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `useAiProviders.js`:

```js
export function pickActive(providers, modality) {
  return (providers || []).find((p) => p.is_active && p.enabled !== false
    && (p.modality || 'image') === modality) || null;
}
```

  and return `activeProvider: pickActive(data, 'image'), activeAudioProvider: pickActive(data, 'audio')`.

  In `SettingsAdmin.jsx`'s provider form:
  - add a **Modality** `<select>` (Image / Audio) that is sent as `modality`
    on create. It's shown read-only when editing, since changing modality
    would orphan clips' provider attribution.
  - When `modality === 'audio'`, hide the request template, response pointer,
    models path/pointer and sheet fields, and show one line: "Talks to the
    box's /api/audio endpoints. Refresh lists its styles and cues."
  - Show a modality badge on each provider card.
  - After Refresh on an audio provider, render the returned `styles`/`cues`
    labels in a compact list.
  - Check every other file using `activeProvider` (`grep -rn "activeProvider" frontend/src/games/something2`).
    They should now receive the image one without changes. Confirm
    `ProviderChoice.jsx`/`ProviderPinField.jsx` list only image providers:
    filter by `(p.modality || 'image') === 'image'` wherever they map
    `providers`.

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `cd frontend && npx vitest run src/games/something2`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/SettingsAdmin.jsx frontend/src/games/something2/useAiProviders.js frontend/src/games/something2/ProviderChoice.jsx frontend/src/games/something2/ProviderPinField.jsx frontend/src/games/something2/__tests__/aiProvidersModality.test.js
git commit -m "feat(admin): audio modality in AI Providers; image pickers never see the audio provider (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Audio admin tab (worlds + biomes, generate/upload/play/remove, misses)

**Files:**
- Create: `frontend/src/games/something2/useAudioAdmin.js`, `frontend/src/games/something2/AudioAdmin.jsx`
- Modify: `frontend/src/App.jsx` (add `<Route path="audio" element={<AudioAdmin />} />` inside `RequireAdmin`, next to `art`), `frontend/src/ui/navSections.js` (item `{ id: 'audio', label: 'Audio', path: '/game/audio', Icon: HiOutlineSpeakerWave }` directly below `art`), `frontend/src/ui/__tests__/navSections.test.js` (add `'/game/audio'` to its expected list)
- Test: `frontend/src/games/something2/__tests__/audioAdminModel.test.js`

**Interfaces:**
- `useAudioAdmin.js` (TanStack Query, `apiFetch` + `authHeaders()` on
  **every** call, since all routes are admin-guarded):
  - `useAudioSubjects()`
  - `useSubjectSlots(kind, key)`
  - `useAudioMisses()`
  - `useProposeAudio()`
  - `useGenerateAudio()`: toasts "Generating… this can take a few minutes"
    while pending
  - `useUploadAudio()`: sends `Content-Type: audio/ogg` with the raw file,
    overriding `authHeaders()`'s JSON content type
  - `useUpdateBinding()`, `useUnbind()`
  - Mutations invalidate `['audio-slots', kind, key]` and `['audio-misses']`.
- Pure helper `slotRows(subjectsResponse) -> [{ kind, label, key, slots: [{ slot, clipKind }] }]`
  for the subject tree, exported from `useAudioAdmin.js`.

- [ ] **Step 1: Write the failing test** (the pure model plus the nav entry)

```js
import { describe, it, expect } from 'vitest';
import { slotRows } from '../useAudioAdmin.js';

describe('slotRows', () => {
  it('flattens the registry response into a subject tree with slot kinds', () => {
    const rows = slotRows([
      { kind: 'world', label: 'Worlds', slots: { music: 'music', ambience: 'ambience' }, subjects: ['vale'] },
      { kind: 'biome', label: 'Biomes', slots: { ambience: 'ambience' }, subjects: ['forest', 'desert'] },
    ]);
    expect(rows.map((r) => `${r.kind}/${r.key}`)).toEqual(['world/vale', 'biome/forest', 'biome/desert']);
    expect(rows[0].slots).toEqual([{ slot: 'music', clipKind: 'music' }, { slot: 'ambience', clipKind: 'ambience' }]);
  });
});
```

  Update `navSections.test.js`'s expected path list to include `'/game/audio'`
  right after `'/game/art'`.

- [ ] **Step 2: Run them and confirm they fail.** Run: `cd frontend && npx vitest run src/games/something2/__tests__/audioAdminModel.test.js src/ui`. Expected: FAIL (both).

- [ ] **Step 3: Implement.**
  - `slotRows`:

```js
export function slotRows(subjects) {
  const out = [];
  for (const group of subjects || []) {
    const slots = Object.entries(group.slots || {}).map(([slot, clipKind]) => ({ slot, clipKind }));
    for (const key of group.subjects || []) out.push({ kind: group.kind, label: group.label, key, slots });
  }
  return out;
}
```

  - `AudioAdmin.jsx` layout. Follow `ArtConsoleAdmin.jsx` for styled-components
    tokens (`--s2-*`) and page structure.
    - **Left column:** a group per subject kind with a filter box. Each subject
      shows `filled/total` slots, where "filled" means the slot has ≥1 clip.
      Below that is a **Missing sounds** list from `useAudioMisses()` (subject,
      slot, count, last seen); clicking a row selects that subject.
    - **Right column:** for the selected subject, one card per slot.
      - Each clip row has ▶/■ (a single shared `new Audio(assetUrl(API_URL, storage_key))`
        so only one preview plays), label, duration (`m:ss`), size (KB), a
        volume slider (PATCH on release), weight input, and a remove button
        (DELETE the binding; confirm first).
      - Each slot also has:
        - **Suggest** (`useProposeAudio`): fills style/prompt fields;
        - **Generate** (`useGenerateAudio`): disabled while pending, shows
          elapsed seconds, error shown inline in the card;
        - **Upload .ogg** (`<input type="file" accept=".ogg,audio/ogg">`).
    - Empty state when no audio provider is active: "No audio provider — add
      one under AI Providers with modality Audio" with a link to
      `/game/settings`.

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `cd frontend && npx vitest run`. Expected: all pass (exit code 0).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/something2/AudioAdmin.jsx frontend/src/games/something2/useAudioAdmin.js frontend/src/games/something2/__tests__/audioAdminModel.test.js frontend/src/App.jsx frontend/src/ui/navSections.js frontend/src/ui/__tests__/navSections.test.js
git commit -m "feat(admin): Audio tab -- world/biome slots, suggest/generate/upload, preview, misses (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Full suites, live box, browser verification, docs

**Files:**
- Modify: `docs/ai-providers.md` (new section "Audio providers": modality,
  what Refresh lists, where clips land, the per-modality active rule)
- Modify: `docs/superpowers/specs/2026-09-28-game-audio-design.md` (record the
  real `POST /api/audio` response shape under "Box contract")

- [ ] **Step 1: Run the full backend suite on the scratch DB.**

```bash
cd backend
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:15432/game_audio_s1
export DATABASE_URL=postgres://postgres:postgres@localhost:15432/game_audio_s1
npm test > /tmp/audio-s1-backend.log 2>&1; echo "exit $?"
grep -cE "^not ok|testTimeoutFailure" /tmp/audio-s1-backend.log
```

  Expected: `exit 0` and `0`. Any `not ok` is red: open it and read the failure
  message, not just the test name.

- [ ] **Step 2: Run the full frontend suite.** Run: `cd frontend && npx vitest run; echo "exit $?"`. Expected: `exit 0`.

- [ ] **Step 3: Live box.** Run the branch's backend and frontend. If the dev
  stack is occupied, use the second-instance recipe from memory
  ("Creature respawn & second-instance verification").
  - In **AI Providers**, create "gpu-box-audio":
    - modality Audio;
    - base URL `http://192.168.0.217:8001`;
    - token = the `something2-audio` key;
    - then Activate and Refresh.
  - Expected: the image provider is **still active**, and Refresh lists 5
    music + 5 ambience styles and 10 `cue:` entries.
  - In **Audio**, pick the entry world:
    - Suggest + Generate `music` with style `medieval_fantasy`;
    - for one of its biomes, generate `ambience` (e.g. `forest`).
  - Record the real `POST /api/audio` response shape (inline base64, or
    queued + poll) in the spec's "Box contract" section.

- [ ] **Step 4: Browser verification.** Use Chrome DevTools MCP, and
  `exitFullscreen()` first, since the game auto-enters fullscreen on Play.
  1. Log in and press Play in the entry world.
  2. `evaluate_script`: `window.__s2audio()`.
     Expected:
     - `state: 'running'`;
     - `music.playing: true` with the generated key;
     - `ambience.playing: true` in the biome you bound.
  3. Walk into a different biome with no ambience bound, and wait more than
     2 s. Expected:
     - `biome` changes;
     - `ambience` falls back to the world ambience, or `playing: false` if
       none is bound;
     - within 30 s (or on leaving the world) a row appears in the Audio tab's
       **Missing sounds** for that biome.
  4. Sound tab: set Music to 0 and check `__s2audio().gains.music === 0`;
     mute and check `gains.master === 0`; reload the page and the settings
     persist.
  5. Walk back and forth over a biome border for 5 s. Expected: `ambience.key`
     does not flip on every crossing.

  Screenshots cannot prove sound. The `__s2audio` snapshot plus actually
  listening is the evidence. Report both.

- [ ] **Step 5: Update the docs and commit.**

```bash
git add docs/ai-providers.md docs/superpowers/specs/2026-09-28-game-audio-design.md
git commit -m "docs: audio providers and the measured POST /api/audio contract (SOMET-NNN)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Finish the branch** with the `superpowers:finishing-a-development-branch` skill:
  - cherry-pick onto main rather than merging in the shared checkout;
  - don't push unless asked;
  - drop the scratch DB only after the merge is verified.
