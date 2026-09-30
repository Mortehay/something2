# Audio Prompt Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every audio slot (music, ambience, SFX) can carry a stored, versioned, editable prompt written by an LLM (GPU box `/api/text`, CPU Ollama fallback), and generation uses it.

**Architecture:** A `textProvider` client (box first, Ollama fallback) feeds an `audioPromptWriter` that builds per-slot context with `audioPromptContext` and stores results in a new `audio_prompts` table via `audioPrompts`. `generateForSlot` and `sfxRequestFor` read the stored prompt before falling back to today's `propose`/`entityPhrase`. There are three ways in: admin routes (slot card), the `make audio-describe` batch, and export/seed.

**Tech Stack:** Node/Express CommonJS, raw `pg`, node-pg-migrate, `node --test` + supertest; React + TanStack Query + styled-components, vitest (node env).

**Spec:** `docs/superpowers/specs/2026-09-30-audio-prompt-writer-design.md`

## Global Constraints

- Work only in the worktree `/home/markunn/worker/coding/jsgame/something2-wt-audio-prompts`, branch `feat/audio-prompt-writer`. Never `checkout`/`stash`/`branch` in the shared main checkout.
- Commit subject `type(scope): summary (SOMET-NNN)` once a ticket exists; until then `type(audio): summary`. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- DB tests: set **both** `TEST_DATABASE_URL` and `DATABASE_URL` to the scratch DB (Task 1 creates it). Never run a DB test, seeder or ad-hoc `DELETE`/`UPDATE` against the shared dev DB `game_db`.
- Read the exit code of every test run, not the `# fail` line (a subtest timeout is not counted there).
- Text provider timeout `TEXT_PROVIDER_TIMEOUT_MS`, default `300000`.
- Prompt temperature `AUDIO_PROMPT_TEMPERATURE`, default `0.15`.
- Stored prompt text is trimmed and capped at **400** chars (`MAX_PROMPT_TEXT`).
- A stale prompt is **used and flagged**, never dropped. A hand-written row (`source_input` null) is never stale.
- Stored `''` means "deliberately cleared": generation falls through to today's path, and the UI distinguishes it from null.
- Box semantics: 409/503 = busy (fall back or wait), other 4xx = our bug (no fallback).
- Do not edit backend files while a `make audio-describe` or art batch runs in the dev container (nodemon restarts the backend and kills the batch).

## Review Focus

1. **A hand-saved style the box does not know.** `PUT` with `style: "forrest"` must be refused with 400 when the active audio provider's `models_cache` lists styles, instead of failing minutes later on Generate. Test in Task 8.
2. **Two writes to the same slot at once** (the batch and a click). The partial unique index makes the second insert fail with `23505`, which must answer 409 "prompt changed, reload", not 500. Test in Task 4 (store) and Task 8 (route).
3. **LLM returns 200 but the wrong shape** (json null, extra prose, empty `entity`, style not in the list). The writer must retry once, then fail that slot without storing anything. Test in Task 6.
4. **A model answer longer than the box accepts.** A 1,200-char answer is stored trimmed to 400 chars and never sent to the box in full. Test in Task 4.
5. **An edited SFX prompt must reach the box as a new entity** (the box caches by `(engine, cue, entity)` globally). The fake box asserts that the entity sent is the stored text plus `(take N)`, and that a cleared `''` prompt sends `entityPhrase`. Test in Task 7.

---

## File map

| File | Responsibility |
|---|---|
| `backend/migrations/1714440610000_audio_prompts.js` (create) | `'text'` modality + `audio_prompts` table |
| `backend/src/services/textProvider.js` (create) | `complete()` box→fallback, `listTextModels()` |
| `backend/src/services/aiProviders.js` (modify) | accept `'text'` modality |
| `backend/src/index.js` (modify ~2812-2870) | refresh/test routes for text providers |
| `backend/src/services/audioPrompts.js` (create) | store: get/list/save/history |
| `backend/src/services/audioPromptContext.js` (create) | catalog snapshot + pure context builder + `isStale` |
| `backend/src/services/audioPromptWriter.js` (create) | contracts, schema, validate, retry, store |
| `backend/src/services/audioGeneration.js` (modify) | stored-prompt precedence |
| `backend/src/api/audioRoutes.js` (modify) | prompt routes + `promptStates` in `/admin/subjects` |
| `backend/scripts/describe-audio-slots.js` (create) + `Makefile` | `make audio-describe` |
| `backend/src/services/audioSeed.js` (modify) | `prompts.json` export/seed |
| `frontend/src/games/something2/providerForm.js`, `SettingsAdmin.jsx` (modify) | Text modality in AI Providers |
| `frontend/src/games/something2/audioSelection.js`, `AudioSlotTable.jsx` (modify) | Prompt column + filter |
| `frontend/src/games/something2/useAudioAdmin.js`, `AudioSlotCard.jsx` (modify) | prompt editor |

---

### Task 1: Scratch DB + migration

**Files:**
- Create: `backend/migrations/1714440610000_audio_prompts.js`
- Test: `backend/tests/audio_prompts_migration_db.test.js`

**Interfaces:**
- Produces: table `audio_prompts(id bigserial, subject_kind, subject_key, slot, style, text, source_input, hint, model, via, active, created_at)`; index `audio_prompts_one_active` unique on `(subject_kind, subject_key, slot) WHERE active`; `ai_providers_modality_check` allows `'text'`.

- [ ] **Step 1: Check the timestamp is free on every branch**

```bash
cd /home/markunn/worker/coding/jsgame/something2-wt-audio-prompts
git log --all --name-only --format= -- 'backend/migrations/*' | sort -u | tail -5
```
Expected: nothing at or above `1714440610000` except `1714440600000` (tile-transition branch). If something collides, pick the next free `...X0000` and use it everywhere below.

- [ ] **Step 2: Create the scratch DB**

```bash
docker exec something2-db-1 sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE game_db_audio_prompts;"'
export SCRATCH=postgres://user:password@localhost:15432/game_db_audio_prompts
cd backend
DATABASE_URL=$SCRATCH npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*'
DATABASE_URL=$SCRATCH node scripts/seed-catalogs.js
```
Expected: migrations end at `1714440590000_audio_clips_sha1`. Verify the credentials with `grep DATABASE_URL ../.env` first. Set **both** vars on each command, in separate assignments (`export A=..; export B=$A` on one line leaves B empty):
```bash
export TEST_DATABASE_URL=$SCRATCH
export DATABASE_URL=$SCRATCH
```

- [ ] **Step 3: Write the failing test**

```js
// backend/tests/audio_prompts_migration_db.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('audio_prompts migration', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `mig-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try {
      await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [tag]);
      await pool.query('DELETE FROM ai_providers WHERE name = $1', [tag]);
    } finally { await pool.end(); }
  });

  const p = await pool.query(
    "INSERT INTO ai_providers (name, base_url, request_template, modality) VALUES ($1, 'http://x', '{}', 'text') RETURNING modality",
    [tag]);
  assert.equal(p.rows[0].modality, 'text');

  await pool.query(
    "INSERT INTO audio_prompts (subject_kind, subject_key, slot, text) VALUES ('world', $1, 'music', 'a')", [tag]);
  await assert.rejects(
    pool.query("INSERT INTO audio_prompts (subject_kind, subject_key, slot, text) VALUES ('world', $1, 'music', 'b')", [tag]),
    (err) => err.code === '23505', 'two active rows for one slot must be refused');
  await pool.query("UPDATE audio_prompts SET active = false WHERE subject_key = $1", [tag]);
  await pool.query(
    "INSERT INTO audio_prompts (subject_kind, subject_key, slot, text) VALUES ('world', $1, 'music', 'b')", [tag]);
  const n = await pool.query('SELECT count(*)::int AS n FROM audio_prompts WHERE subject_key = $1', [tag]);
  assert.equal(n.rows[0].n, 2, 'inactive history rows are kept');
});
```

- [ ] **Step 4: Run it and see it fail**

Run: `node --test tests/audio_prompts_migration_db.test.js`
Expected: FAIL. The `ai_providers_modality_check` violation or `relation "audio_prompts" does not exist`.

- [ ] **Step 5: Write the migration**

```js
// backend/migrations/1714440610000_audio_prompts.js
//
// Audio prompt writer (spec 2026-09-30 §3.2, §4). Two things:
//   1. ai_providers gains the 'text' modality -- the GPU box's /api/text,
//      one active per modality like image and audio.
//   2. audio_prompts: the stored, versioned prompt per audio slot. One ACTIVE
//      row per (kind, key, slot); an edit deactivates the old row and inserts
//      a new one, so history is kept.
exports.up = (pgm) => {
  pgm.dropConstraint('ai_providers', 'ai_providers_modality_check');
  pgm.addConstraint('ai_providers', 'ai_providers_modality_check', {
    check: "modality IN ('image', 'audio', 'text')",
  });

  pgm.createTable('audio_prompts', {
    id: { type: 'bigserial', primaryKey: true },
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    slot: { type: 'text', notNull: true },
    // music/ambience only: one of the box's style values for that clip kind.
    style: { type: 'text' },
    // The prompt (music/ambience) or the entity phrase (sfx). '' is legal and
    // means someone cleared it on purpose -- generation then falls through.
    text: { type: 'text', notNull: true },
    // Exactly what the model was given. Null for a hand-written row, which is
    // therefore never stale.
    source_input: { type: 'text' },
    hint: { type: 'text' },
    model: { type: 'text' },
    // 'box' | 'fallback'; null when a person wrote it.
    via: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('audio_prompts', ['subject_kind', 'subject_key', 'slot'], {
    name: 'audio_prompts_one_active', unique: true, where: 'active',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('audio_prompts');
  pgm.sql("DELETE FROM ai_providers WHERE modality = 'text'");
  pgm.dropConstraint('ai_providers', 'ai_providers_modality_check');
  pgm.addConstraint('ai_providers', 'ai_providers_modality_check', {
    check: "modality IN ('image', 'audio')",
  });
};
```

- [ ] **Step 6: Migrate the scratch DB and see the test pass**

```bash
npx node-pg-migrate up --ignore-pattern '(?!.*\.js$).*'
node --test tests/audio_prompts_migration_db.test.js
```
Expected: PASS, exit 0. Also run `npx node-pg-migrate down --ignore-pattern '(?!.*\.js$).*'` and then `up` again to prove that `down` works.

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/1714440610000_audio_prompts.js backend/tests/audio_prompts_migration_db.test.js
git commit -m "feat(audio): audio_prompts table + text provider modality

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `textProvider` — box first, Ollama fallback

**Files:**
- Create: `backend/src/services/textProvider.js`
- Test: `backend/tests/text_provider.test.js`

**Interfaces:**
- Consumes: `aiProviders.loadActiveProviderWithSecret(db, 'text')`, `safeFetch`, `readJsonCapped`, `errorDetail`, `redactUrl` (safeFetch.js), `authHeaders`, `resolveUrl` (providerDiscovery.js).
- Produces:
  - `complete(db, { system, prompt, jsonSchema, temperature, maxTokens }, { fetchImpl, boxOnly }) → Promise<{ ok: true, text, json, model, via, ms } | { ok: false, error, busy, via }>`
  - `listTextModels(provider, { fetchImpl }) → Promise<{ ok: true, models: string[] } | { ok: false, error, status }>`

- [ ] **Step 1: Write the failing tests**

```js
// backend/tests/text_provider.test.js
// Unit: no DB. The fake db and fake fetch CHECK what they are given -- a
// fake that ignores its input is the vacuous-test shape this repo keeps
// shipping.
const test = require('node:test');
const assert = require('node:assert');
const tp = require('../src/services/textProvider');

const BOX = { id: 9, name: 'box', base_url: 'http://box.test:8001', auth_header_name: null, auth_token: 'k', modality: 'text' };
const fakeDb = (provider) => ({
  query: async (sql, params) => {
    assert.match(sql, /modality = \$1/);
    assert.deepEqual(params, ['text'], 'must look up the TEXT provider, not image/audio');
    return { rows: provider ? [provider] : [] };
  },
});
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SCHEMA = { type: 'object', properties: { entity: { type: 'string' } }, required: ['entity'] };
const REQ = { system: 'sys', prompt: 'describe wolf', jsonSchema: SCHEMA, temperature: 0.15, maxTokens: 64 };

function recorder(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), headers: init.headers, body });
    for (const [match, respond] of routes) if (String(url).includes(match)) return respond(body);
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, fetchImpl };
}

test('box answers: via box, schema and auth forwarded', async () => {
  const { calls, fetchImpl } = recorder([['/api/text', () => json(200, { text: '{"entity":"a grey wolf"}', json: { entity: 'a grey wolf' }, model: 'qwen-instruct', ms: 900 })]]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
  assert.deepEqual({ ok: r.ok, via: r.via, model: r.model, json: r.json }, { ok: true, via: 'box', model: 'qwen-instruct', json: { entity: 'a grey wolf' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://box.test:8001/api/text');
  assert.equal(calls[0].headers.Authorization, 'Bearer k');
  assert.deepEqual(calls[0].body, { system: 'sys', prompt: 'describe wolf', max_tokens: 64, temperature: 0.15, json_schema: SCHEMA });
});

test('box json missing but text parses: json recovered from text', async () => {
  const { fetchImpl } = recorder([['/api/text', () => json(200, { text: '{"entity":"x"}', json: null, model: 'm' })]]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
  assert.deepEqual(r.json, { entity: 'x' });
});

for (const status of [409, 503]) {
  test(`box ${status} falls back to Ollama with the same schema`, async () => {
    const { calls, fetchImpl } = recorder([
      ['/api/text', () => json(status, { detail: 'busy' })],
      ['/v1/chat/completions', () => json(200, { choices: [{ message: { content: '{"entity":"a wolf"}' } }] })],
    ]);
    const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.via, 'fallback');
    assert.deepEqual(r.json, { entity: 'a wolf' });
    const fb = calls[1].body;
    assert.deepEqual(fb.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'describe wolf' }]);
    assert.deepEqual(fb.response_format, { type: 'json_schema', json_schema: { name: 'answer', schema: SCHEMA } });
    assert.equal(fb.temperature, 0.15);
  });
}

test('box unreachable falls back', async () => {
  const { fetchImpl } = recorder([
    ['/api/text', () => { throw new Error('ECONNREFUSED'); }],
    ['/v1/chat/completions', () => json(200, { choices: [{ message: { content: '{"entity":"a"}' } }] })],
  ]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
  assert.equal(r.via, 'fallback');
});

test('no text provider: straight to fallback', async () => {
  const { calls, fetchImpl } = recorder([['/v1/chat/completions', () => json(200, { choices: [{ message: { content: '{"entity":"a"}' } }] })]]);
  const r = await tp.complete(fakeDb(null), REQ, { fetchImpl });
  assert.equal(r.via, 'fallback');
  assert.equal(calls.length, 1);
});

test('box 400 is OUR bug: no fallback', async () => {
  const { calls, fetchImpl } = recorder([['/api/text', () => json(400, { detail: 'bad schema' })]]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
  assert.deepEqual({ ok: r.ok, via: r.via, busy: r.busy }, { ok: false, via: 'box', busy: false });
  assert.match(r.error, /400/);
  assert.equal(calls.length, 1);
});

test('boxOnly + 409: busy failure, no fallback call', async () => {
  const { calls, fetchImpl } = recorder([['/api/text', () => json(409, {})]]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl, boxOnly: true });
  assert.deepEqual({ ok: r.ok, busy: r.busy, via: r.via }, { ok: false, busy: true, via: 'box' });
  assert.equal(calls.length, 1);
});

test('boxOnly + no provider: not busy (waiting would never end)', async () => {
  const r = await tp.complete(fakeDb(null), REQ, { fetchImpl: async () => { throw new Error('no call expected'); }, boxOnly: true });
  assert.deepEqual({ ok: r.ok, busy: r.busy }, { ok: false, busy: false });
});

test('both fail: error names both', async () => {
  const { fetchImpl } = recorder([
    ['/api/text', () => json(503, {})],
    ['/v1/chat/completions', () => json(500, {})],
  ]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /503.*fallback.*500/);
});

test('listTextModels maps values', async () => {
  const { calls, fetchImpl } = recorder([['/api/text/models', () => json(200, [{ value: 'qwen', label: 'Qwen', loaded: false }])]]);
  const r = await tp.listTextModels(BOX, { fetchImpl });
  assert.deepEqual(r, { ok: true, models: ['qwen'] });
  assert.equal(calls[0].headers.Authorization, 'Bearer k');
});
```

- [ ] **Step 2: Run and see them fail**

Run: `node --test tests/text_provider.test.js`
Expected: FAIL with `Cannot find module '../src/services/textProvider'`.

- [ ] **Step 3: Implement**

```js
// backend/src/services/textProvider.js
//
// Audio prompt writer (spec 2026-09-30 §3.3). One way to ask a model for
// text: the active 'text' AI provider (the GPU box's /api/text) first, the
// local Ollama the art describer already uses as the fallback.
//
// FALLBACK ONLY WHEN THE BOX COULD NOT ANSWER: no provider, 409/503 (the
// model gateway is switching or the model cannot load -- busy, not broken),
// a transport error or a timeout. Any other 4xx is a request WE built wrong,
// and hiding it behind a CPU answer would bury the bug.
//
// Never throws: every path returns { ok, ... } with `via` saying who
// answered or who failed, so a CPU-written prompt is visible as one.
const aiProviders = require('./aiProviders');
const {
  safeFetch, readJsonCapped, redactUrl, errorDetail,
} = require('./safeFetch');
const { authHeaders, resolveUrl } = require('./providerDiscovery');

const TIMEOUT_MS = () => Number(process.env.TEXT_PROVIDER_TIMEOUT_MS) || 300000;
const FALLBACK_URL = () => process.env.ART_DESCRIBER_URL || 'http://localhost:20434/v1/chat/completions';
const FALLBACK_MODEL = () => process.env.ART_DESCRIBER_MODEL || 'qwen2.5-coder:7b';
const JSON_CAP = 1024 * 1024;
const BUSY_STATUSES = new Set([409, 503]);

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// -> { ok: true, text, json, model, ms } | { ok: false, error, busy, fallbackable }
async function callBox(provider, req, fetchImpl) {
  const url = resolveUrl(provider.base_url, '/api/text');
  const started = Date.now();
  let res;
  try {
    res = await safeFetch(url, {
      method: 'POST',
      headers: { ...authHeaders(provider), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: req.system,
        prompt: req.prompt,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        json_schema: req.jsonSchema || undefined,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    }, { fetchImpl });
  } catch (err) {
    return { ok: false, busy: true, fallbackable: true, error: `could not reach ${redactUrl(url)}: ${err.message}` };
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    const busy = BUSY_STATUSES.has(res.status);
    return {
      ok: false, busy, fallbackable: busy, status: res.status,
      error: `text service answered ${res.status}${detail ? `: ${detail}` : ''}`,
    };
  }
  const read = await readJsonCapped(res, JSON_CAP);
  if (read.error) return { ok: false, busy: false, fallbackable: false, error: `text service did not answer with usable JSON: ${read.error}` };
  const j = read.json || {};
  const text = typeof j.text === 'string' ? j.text : '';
  let json = null;
  if (j.json && typeof j.json === 'object') json = j.json;
  else if (req.jsonSchema) json = parseJson(text);
  return {
    ok: true, text, json, model: j.model || provider.name, ms: Number.isFinite(j.ms) ? j.ms : Date.now() - started,
  };
}

async function callFallback(req, fetchImpl) {
  const started = Date.now();
  const messages = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt });
  const body = {
    model: FALLBACK_MODEL(), messages, temperature: req.temperature, max_tokens: req.maxTokens, stream: false,
  };
  if (req.jsonSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema: req.jsonSchema } };
  let res;
  try {
    res = await fetchImpl(FALLBACK_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    });
  } catch (err) {
    return { ok: false, error: `fallback model unreachable: ${err.message}` };
  }
  if (!res.ok) return { ok: false, error: `fallback model answered ${res.status}` };
  const j = await res.json().catch(() => null);
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  const text = msg ? String(msg.content || '') : '';
  return {
    ok: true, text, json: req.jsonSchema ? parseJson(text) : null, model: FALLBACK_MODEL(), ms: Date.now() - started,
  };
}

async function complete(db, request, { fetchImpl = fetch, boxOnly = false } = {}) {
  const req = {
    system: request.system || '',
    prompt: request.prompt,
    jsonSchema: request.jsonSchema || null,
    temperature: Number.isFinite(request.temperature) ? request.temperature : 0.15,
    maxTokens: request.maxTokens || 256,
  };
  const provider = await aiProviders.loadActiveProviderWithSecret(db, 'text');
  let boxErr = null;
  if (provider) {
    const b = await callBox(provider, req, fetchImpl);
    if (b.ok) return { ...b, via: 'box' };
    if (!b.fallbackable) return { ok: false, error: b.error, busy: false, via: 'box' };
    boxErr = b;
  }
  if (boxOnly) {
    return {
      ok: false, error: boxErr ? boxErr.error : 'no active text provider', busy: Boolean(boxErr && boxErr.busy), via: 'box',
    };
  }
  const f = await callFallback(req, fetchImpl);
  if (f.ok) return { ...f, via: 'fallback' };
  return {
    ok: false, error: boxErr ? `${boxErr.error}; fallback: ${f.error}` : f.error, busy: false, via: 'fallback',
  };
}

async function listTextModels(provider, { fetchImpl = fetch } = {}) {
  const url = resolveUrl(provider.base_url, '/api/text/models');
  let res;
  try {
    res = await safeFetch(url, {
      method: 'GET', headers: { ...authHeaders(provider) }, signal: AbortSignal.timeout(30000),
    }, { fetchImpl });
  } catch (err) {
    return { ok: false, error: `could not reach ${redactUrl(url)}: ${err.message}` };
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    return { ok: false, status: res.status, error: `text service answered ${res.status}${detail ? `: ${detail}` : ''}` };
  }
  const read = await readJsonCapped(res, JSON_CAP);
  if (read.error || !Array.isArray(read.json)) return { ok: false, error: 'models response is not a list' };
  return { ok: true, models: read.json.map((m) => m && m.value).filter((v) => typeof v === 'string') };
}

module.exports = { complete, listTextModels };
```

- [ ] **Step 4: Run and see them pass**

Run: `node --test tests/text_provider.test.js`
Expected: PASS, exit 0. If `safeFetch` rejects `http://box.test:8001` (its URL guard), look at `unsafeUrlReason` in `safeFetch.js` and use a host it accepts (the audio route tests use `http://127.0.0.1:<port>`). Change only the test host, never the guard.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/textProvider.js backend/tests/text_provider.test.js
git commit -m "feat(audio): textProvider -- box /api/text with Ollama fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `'text'` modality in AI Providers (backend + form)

**Files:**
- Modify: `backend/src/services/aiProviders.js:104-108` (validator), `:212-215` (createProvider default)
- Modify: `backend/src/index.js:2818` (refresh-models), `:2850` (test)
- Modify: `frontend/src/games/something2/providerForm.js:126-128`, `:156-165`
- Modify: `frontend/src/games/something2/SettingsAdmin.jsx:60, 91, 99-106, 144-146, 218-229, 252, 262`
- Test: `backend/tests/ai_providers_text_modality_db.test.js`, `frontend/src/games/something2/__tests__/providerFormText.test.js`

**Interfaces:**
- Consumes: `textProvider.listTextModels` (Task 2).
- Produces: a `modality: 'text'` provider row that `loadActiveProviderWithSecret(db, 'text')` returns.

- [ ] **Step 1: Find tests that pin the old error message**

```bash
grep -rn "modality must be" backend/tests frontend/src
```
Every hit is updated in Step 4 to the new message.

- [ ] **Step 2: Write the failing backend test**

```js
// backend/tests/ai_providers_text_modality_db.test.js
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;

test('text modality providers', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const tag = `txt-${process.pid}-${Date.now()}`;
  const seen = [];
  const box = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/text/models') return res.end(JSON.stringify([{ value: 'qwen-instruct', label: 'Qwen', loaded: false }]));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => box.listen(0, '127.0.0.1', r));
  const u = (await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, username, role, token_version", [tag])).rows[0];
  const auth = `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.token_version })}`;
  t.after(async () => {
    box.close();
    try {
      await pool.query('DELETE FROM ai_providers WHERE name = $1', [tag]);
      await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
    } finally { await pool.end(); }
  });

  const created = await request(app).post('/api/ai-providers').set('Authorization', auth)
    .send({ name: tag, base_url: `http://127.0.0.1:${box.address().port}`, modality: 'text', auth_token: 'k' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.modality, 'text');

  const bad = await request(app).post('/api/ai-providers').set('Authorization', auth)
    .send({ name: `${tag}-bad`, base_url: 'http://x', modality: 'video' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /'image', 'audio' or 'text'/);

  const refreshed = await request(app).post(`/api/ai-providers/${created.body.id}/refresh-models`).set('Authorization', auth);
  assert.deepEqual({ ok: refreshed.body.ok, models: refreshed.body.models }, { ok: true, models: ['qwen-instruct'] });
  assert.equal(seen.at(-1).url, '/api/text/models');
  assert.equal(seen.at(-1).auth, 'Bearer k', 'refresh must hit the authenticated text endpoint');

  const tested = await request(app).post(`/api/ai-providers/${created.body.id}/test`).set('Authorization', auth);
  assert.equal(tested.body.ok, true);
  assert.equal(seen.at(-1).url, '/api/text/models', 'test must not certify the unauthenticated root');
  assert.equal(JSON.stringify(tested.body).includes('"k"'), false);
});
```

- [ ] **Step 3: Run and see it fail**

Run: `node --test tests/ai_providers_text_modality_db.test.js`
Expected: FAIL on `created.status` 400 "modality must be 'image' or 'audio'".

- [ ] **Step 4: Implement the backend**

In `aiProviders.js`, replace lines 104-108:
```js
  const modality = has('modality') ? body.modality : undefined;
  if (modality !== undefined && !['image', 'audio', 'text'].includes(modality)) {
    return "modality must be 'image', 'audio' or 'text'";
  }
  // Neither audio nor text has a request template (both have hand-written
  // adapters); only an image provider is template-driven.
  const templateRequired = !partial && modality !== 'audio' && modality !== 'text';
```
In `createProvider`:
```js
// Audio and text profiles have no template, but the column is NOT NULL.
async function createProvider(db, body) {
  const templateless = body.modality === 'audio' || body.modality === 'text';
  const withDefaults = templateless && body.request_template === undefined
    ? { ...body, request_template: {} }
    : body;
```
In `index.js`, add `const textProvider = require('./services/textProvider');` next to the `remoteAudioProvider` require. In `refresh-models`, directly after the audio branch:
```js
    if (provider.modality === 'text') {
      const r = await textProvider.listTextModels(provider);
      if (!r.ok) return res.json({ ok: false, error: r.error, status: r.status ?? null });
      await aiProviders.saveModelsCache(pool, id, r.models);
      return res.json({ ok: true, models: r.models });
    }
```
In `test`, directly after the audio branch:
```js
    // Same reasoning as audio: probe an AUTHENTICATED text endpoint, so a
    // bad token fails here rather than on the first prompt write.
    if (provider.modality === 'text') {
      const startedAt = Date.now();
      const r = await textProvider.listTextModels(provider);
      res.json({
        ok: r.ok, status: r.status ?? null, latency_ms: Date.now() - startedAt, error: r.error ?? null,
      });
      return;
    }
```
Update any test found in Step 1 to the new message.

- [ ] **Step 5: Run and see it pass, plus the provider suites**

Run: `node --test tests/ai_providers_text_modality_db.test.js $(ls tests/*ai_provider* tests/*providers* 2>/dev/null | sort -u)`
Expected: PASS, exit 0.

- [ ] **Step 6: Write the failing frontend test**

```js
// frontend/src/games/something2/__tests__/providerFormText.test.js
import { describe, it, expect } from 'vitest';
import { emptyProviderForm, providerFormToPayload, validateProviderForm } from '../providerForm.js';

describe('text modality provider form', () => {
  const form = { ...emptyProviderForm(), name: 'box text', base_url: 'http://192.168.0.217:8001', modality: 'text', request_template: 'not json' };
  it('sends modality text and no image-only fields', () => {
    const p = providerFormToPayload(form);
    expect(p.modality).toBe('text');
    for (const k of ['request_template', 'models_path', 'models_pointer', 'response_image_pointer', 'sheet_layout']) {
      expect(p).not.toHaveProperty(k);
    }
  });
  it('does not validate the (unused) request template', () => {
    expect(validateProviderForm(form)).toBeNull();
  });
});
```
Check the exported names first with `grep -n "^export function" frontend/src/games/something2/providerForm.js`. If the empty-form factory has another name, use that name.

- [ ] **Step 7: Run and see it fail**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/providerFormText.test.js`
Expected: FAIL (`modality` comes back `'image'`).

- [ ] **Step 8: Implement the frontend**

`providerForm.js` validation:
```js
  // Audio and text providers have no request template -- the server fills {}
  // for one -- so the image-only field below is not part of their validation.
  if (form.modality === 'audio' || form.modality === 'text') return null;
```
`providerFormToPayload`:
```js
  const modality = form.modality === 'audio' || form.modality === 'text' ? form.modality : 'image';
```
(The existing `if (modality === 'image') { ... }` block already scopes the image-only fields.)

`SettingsAdmin.jsx`:
```jsx
  const isAudio = form.modality === 'audio';
  const isText = form.modality === 'text';
  const modalityLabel = isAudio ? 'Audio' : isText ? 'Text' : 'Image';
```
- Badge: `{modalityLabel.toUpperCase()}`.
- Select: add `<option value="text">Text</option>`.
- Fixed-after-creation span: `{modalityLabel} — fixed after creation`.
- Template block: `{isAudio ? (<Hint>…audio…</Hint>) : isText ? (<Hint>Talks to the box's /api/text endpoint (prompt writing). Refresh lists its models; the box's gateway loads them on demand.</Hint>) : (<>…template…</>)}`.
- Model row: `<Label>{isAudio ? 'Styles' : isText ? 'Models' : 'Model'}</Label>`. For `isText`, render `<Hint style={{ margin: 0 }}>{models.length ? `${models.join(', ')} — the box picks and loads it` : 'refresh to list models'}</Hint>` instead of the select.
- The refresh label stays `Refresh models` for text, and the cached-count hint says `model` for text.

- [ ] **Step 9: Run the frontend tests**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/providerFormText.test.js src/games/something2/__tests__/ 2>&1 | tail -5`
Expected: all pass, exit 0.

- [ ] **Step 10: Commit**

```bash
git add backend/src/services/aiProviders.js backend/src/index.js backend/tests/ai_providers_text_modality_db.test.js \
  frontend/src/games/something2/providerForm.js frontend/src/games/something2/SettingsAdmin.jsx \
  frontend/src/games/something2/__tests__/providerFormText.test.js
git commit -m "feat(audio): text modality in AI Providers (refresh/test hit /api/text/models)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `audioPrompts` store

**Files:**
- Create: `backend/src/services/audioPrompts.js`
- Test: `backend/tests/audio_prompts_db.test.js`

**Interfaces:**
- Produces:
  - `MAX_PROMPT_TEXT = 400`
  - `getActive(db, kind, key, slot) → row | null` (row: `{ id, subject_kind, subject_key, slot, style, text, source_input, hint, model, via, created_at }`)
  - `listForSubject(db, kind, key) → { [slot]: { active: row|null, history: row[] } }`
  - `listAllActive(db) → row[]` (every active row, ordered by kind, key, slot)
  - `save(db, kind, key, slot, { style, text, sourceInput, hint, model, via }, { expectActiveId }) → row`. Throws `err.status = 409` when the active row changed underneath (`expectActiveId` mismatch, or a `23505` race).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/audio_prompts_db.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const store = require('../src/services/audioPrompts');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('audioPrompts store', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const key = `ap-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [key]); } finally { await pool.end(); }
  });

  assert.equal(await store.getActive(pool, 'world', key, 'music'), null);

  const a = await store.save(pool, 'world', key, 'music', {
    style: 'village', text: '  calm lute  ', sourceInput: 'ctx-1', model: 'qwen', via: 'box',
  });
  assert.equal(a.text, 'calm lute', 'trimmed');
  assert.deepEqual([a.style, a.source_input, a.model, a.via], ['village', 'ctx-1', 'qwen', 'box']);

  const b = await store.save(pool, 'world', key, 'music', { style: 'village', text: '' }, { expectActiveId: a.id });
  assert.equal(b.text, '', "'' is stored, not turned into null");
  assert.equal(b.source_input, null, 'hand-written row has no source_input');
  assert.equal((await store.getActive(pool, 'world', key, 'music')).id, b.id);

  const long = await store.save(pool, 'world', key, 'music', { text: 'x'.repeat(1200) });
  assert.equal(long.text.length, store.MAX_PROMPT_TEXT);

  await assert.rejects(
    store.save(pool, 'world', key, 'music', { text: 'stale edit' }, { expectActiveId: a.id }),
    (err) => err.status === 409, 'an edit based on a superseded row is refused');

  // Race: two saves with no expectActiveId at the same time -- both may not
  // win, and the loser must be a 409, never a 500.
  const results = await Promise.allSettled([
    store.save(pool, 'world', key, 'ambience', { text: 'one' }),
    store.save(pool, 'world', key, 'ambience', { text: 'two' }),
  ]);
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.status, 409, r.reason.message);
  const active = await pool.query(
    "SELECT count(*)::int AS n FROM audio_prompts WHERE subject_key = $1 AND slot = 'ambience' AND active", [key]);
  assert.equal(active.rows[0].n, 1);

  const bySlot = await store.listForSubject(pool, 'world', key);
  assert.equal(bySlot.music.active.id, long.id);
  assert.equal(bySlot.music.history.length, 3, 'three superseded music rows');
  assert.ok((await store.listAllActive(pool)).some((r) => r.subject_key === key && r.slot === 'music'));
});
```

- [ ] **Step 2: Run and see it fail**

Run: `node --test tests/audio_prompts_db.test.js`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implement**

```js
// backend/src/services/audioPrompts.js
//
// The stored prompt per audio slot (spec 2026-09-30 §4). One ACTIVE row per
// (kind, key, slot); a save deactivates the current row and inserts a new
// one in ONE transaction, so history is kept and the partial unique index
// (audio_prompts_one_active) is the arbiter of a race: the loser gets 23505,
// which becomes a 409 -- two writers to one slot is a conflict to show the
// admin, not a server error.
//
// '' IS A VALUE. A stored empty text means someone cleared the prompt on
// purpose; generation then falls through to its old path. null is never
// stored in `text` (the column is NOT NULL); "no prompt" is "no active row".
const MAX_PROMPT_TEXT = 400;
const COLS = 'id, subject_kind, subject_key, slot, style, text, source_input, hint, model, via, active, created_at';

function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

async function getActive(db, kind, key, slot) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM audio_prompts
      WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3 AND active`, [kind, key, slot]);
  return rows[0] || null;
}

async function listForSubject(db, kind, key) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM audio_prompts WHERE subject_kind = $1 AND subject_key = $2
      ORDER BY slot, created_at DESC, id DESC`, [kind, key]);
  const out = {};
  for (const r of rows) {
    if (!out[r.slot]) out[r.slot] = { active: null, history: [] };
    if (r.active) out[r.slot].active = r; else out[r.slot].history.push(r);
  }
  return out;
}

async function listAllActive(db) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM audio_prompts WHERE active ORDER BY subject_kind, subject_key, slot`);
  return rows;
}

// `expectActiveId`: the active row id the caller's edit was based on (null =
// "I saw no prompt"; undefined = "don't check", used by the batch writer,
// which re-reads right before saving).
async function save(db, kind, key, slot, {
  style = null, text, sourceInput = null, hint = null, model = null, via = null,
}, { expectActiveId } = {}) {
  const body = String(text == null ? '' : text).trim().slice(0, MAX_PROMPT_TEXT);
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const release = client !== db;
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT id FROM audio_prompts
        WHERE subject_kind = $1 AND subject_key = $2 AND slot = $3 AND active FOR UPDATE`, [kind, key, slot]);
    const curId = cur.rows[0] ? String(cur.rows[0].id) : null;
    if (expectActiveId !== undefined && String(expectActiveId ?? '') !== String(curId ?? '')) {
      throw conflict('this prompt was changed by someone else; reload it');
    }
    if (curId) await client.query('UPDATE audio_prompts SET active = false WHERE id = $1', [curId]);
    const { rows } = await client.query(
      `INSERT INTO audio_prompts (subject_kind, subject_key, slot, style, text, source_input, hint, model, via)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLS}`,
      [kind, key, slot, style || null, body, sourceInput, hint || null, model, via]);
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw conflict('this prompt was changed by someone else; reload it');
    throw err;
  } finally {
    if (release) client.release();
  }
}

module.exports = {
  MAX_PROMPT_TEXT, getActive, listForSubject, listAllActive, save,
};
```

- [ ] **Step 4: Run and see it pass**

Run: `node --test tests/audio_prompts_db.test.js`
Expected: PASS, exit 0. Run it three times: the race assertion must hold every time.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/audioPrompts.js backend/tests/audio_prompts_db.test.js
git commit -m "feat(audio): audioPrompts store -- versioned, one active per slot, 409 on conflict

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `audioPromptContext` — what the model is told

**Files:**
- Create: `backend/src/services/audioPromptContext.js`
- Test: `backend/tests/audio_prompt_context.test.js` (pure), `backend/tests/audio_prompt_context_db.test.js`

**Interfaces:**
- Consumes: `SUBJECT_KINDS`, `slotKind`, `cueFor`-equivalent data (`ATTACK_TYPE_PHRASE` must be exported from `audioSubjects.js`; add it to `module.exports`), `SKILLS` from `seeds/data/skills.js`, and `art_prompt_descriptions` active rows.
- Produces:
  - `loadPromptCatalog(db) → Promise<Catalog>`: one set of queries for everything.
  - `buildContext(catalog, kind, key, slot, { cue }) → string | null` (pure; null = unknown subject)
  - `contextFor(db, kind, key, slot, { cue }) → Promise<string|null>` (load + build, for one-off use)
  - `isStale(promptRow, currentContext) → boolean`
  - `stripImageStyling(prompt) → string`

Art `subject_kind` mapping: creature and world_point → `'entity'` keyed by name; item → `'item'` keyed by name; skill → `'skill'` keyed by id.

- [ ] **Step 1: Write the failing pure test**

```js
// backend/tests/audio_prompt_context.test.js
const test = require('node:test');
const assert = require('node:assert');
const { buildContext, isStale, stripImageStyling } = require('../src/services/audioPromptContext');

const CAT = {
  worlds: new Map([['Vale', { biomes: ['Meadow', 'Deep Forest'], level_min: 1, level_max: 10 }]]),
  biomes: new Map([['Meadow', { art_style: 'rolling grass, wildflowers' }]]),
  entities: new Map([
    ['Wolf', { prompt: 'pixel art, a grey timber wolf, single object, solid transparent background' }],
    ['Shrine', { prompt: 'pixel art, a stone waypoint shrine' }],
  ]),
  items: new Map([['arbalest', { category: 'weapon', req_level: 12 }]]),
  skills: new Map([['war_whirlwind', { nameEn: 'Whirlwind', class: 'Warrior', type: 'melee' }]]),
  artDescriptions: new Map([['entity/Wolf', 'lean grey wolf with bared fangs'], ['skill/war_whirlwind', 'spinning greatsword']]),
};

test('stripImageStyling drops styling clauses, keeps the subject', () => {
  assert.equal(stripImageStyling('pixel art, a grey timber wolf, single object, solid transparent background'), 'a grey timber wolf');
  assert.equal(stripImageStyling(''), '');
});

test('world context names biomes and level band', () => {
  assert.equal(buildContext(CAT, 'world', 'Vale', 'music'),
    'world "Vale"; regions: Meadow, Deep Forest; levels 1-10; slot: music');
});

test('biome context carries art_style', () => {
  assert.equal(buildContext(CAT, 'biome', 'Meadow', 'ambience'),
    'biome "Meadow"; looks like: rolling grass, wildflowers; slot: ambience');
});

test('creature prefers the ACTIVE ART DESCRIPTION over the image prompt', () => {
  assert.equal(buildContext(CAT, 'creature', 'Wolf', 'hurt', { cue: 'hit' }),
    'creature "Wolf"; looks like: lean grey wolf with bared fangs; slot: hurt; sound cue: hit');
});

test('world point with NO art description falls back to the stripped entity prompt', () => {
  assert.equal(buildContext(CAT, 'world_point', 'Shrine', 'nearby', { cue: 'waypoint' }),
    'world point "Shrine"; looks like: a stone waypoint shrine; slot: nearby; sound cue: waypoint');
});

test('item and skill carry their catalog fields', () => {
  assert.equal(buildContext(CAT, 'item', 'arbalest', 'use', { cue: 'slash' }),
    'weapon "arbalest"; required level 12; slot: use; sound cue: slash');
  assert.equal(buildContext(CAT, 'skill', 'war_whirlwind', 'use', { cue: 'slash' }),
    'Warrior melee skill "Whirlwind"; looks like: spinning greatsword; slot: use; sound cue: slash');
});

test('attack_type uses the per-slot phrase', () => {
  assert.equal(buildContext(CAT, 'attack_type', 'melee', 'hit', { cue: 'hit' }),
    'melee attack: a blade on a creature; slot: hit; sound cue: hit');
});

test('unknown subject -> null', () => {
  assert.equal(buildContext(CAT, 'creature', 'Nope', 'hurt'), null);
  assert.equal(buildContext(CAT, 'nope', 'x', 'y'), null);
});

test('isStale', () => {
  assert.equal(isStale({ source_input: 'a' }, 'a'), false);
  assert.equal(isStale({ source_input: 'a' }, 'b'), true);
  assert.equal(isStale({ source_input: null }, 'b'), false, 'hand-written is never stale');
  assert.equal(isStale(null, 'b'), false);
  assert.equal(isStale({ source_input: 'a' }, null), false, 'unknown subject is not stale');
});
```

- [ ] **Step 2: Run and see it fail**

Run: `node --test tests/audio_prompt_context.test.js`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implement**

```js
// backend/src/services/audioPromptContext.js
//
// What the prompt-writing model is told about one audio slot (spec
// 2026-09-30 §5). The returned string is ALSO what gets stored as
// audio_prompts.source_input, so "stale" is simply "today's string differs".
//
// LOAD ONCE, BUILD MANY. The slot table flags staleness for ~2,300 rows; one
// query per row would be ~2,300 round-trips. loadPromptCatalog reads every
// table once, and buildContext is pure over that snapshot -- which is also
// what makes every branch testable without a database.
//
// THE ART-DESCRIPTION BRANCH IS THE ONE THAT MATTERS. It is preferred over
// entity_types.prompt, which carries image styling ("pixel art, ... solid
// transparent background") that is noise to a sound prompt. In the art epic a
// branch like this was dead for months because only a fixture reached it --
// the DB test for this file checks it against a real row.
const { SKILLS } = require('../../seeds/data/skills.js');
const { ATTACK_TYPE_PHRASE } = require('./audioSubjects');

const STYLING = /^(pixel art|isometric|single object|.*background|.*sprite|game asset|centered|high detail)$/i;

function stripImageStyling(prompt) {
  return String(prompt || '').split(',').map((s) => s.trim()).filter((s) => s && !STYLING.test(s)).join(', ');
}

const ART_KIND = { creature: 'entity', world_point: 'entity', item: 'item', skill: 'skill' };

async function loadPromptCatalog(db) {
  const [worlds, biomes, entities, items, art] = await Promise.all([
    db.query('SELECT name, biomes, level_min, level_max FROM worlds'),
    db.query('SELECT name, art_style FROM biomes'),
    db.query('SELECT name, prompt FROM entity_types WHERE is_creature OR point_kind IS NOT NULL'),
    db.query("SELECT name, category, req_level FROM item_types WHERE category = 'weapon'"),
    db.query("SELECT subject_kind, subject_key, text FROM art_prompt_descriptions WHERE active AND subject_kind IN ('entity', 'item', 'skill')"),
  ]);
  return {
    worlds: new Map(worlds.rows.map((r) => [r.name, r])),
    biomes: new Map(biomes.rows.map((r) => [r.name, r])),
    entities: new Map(entities.rows.map((r) => [r.name, r])),
    items: new Map(items.rows.map((r) => [r.name, r])),
    skills: new Map(SKILLS.map((s) => [s.id, s])),
    artDescriptions: new Map(art.rows.filter((r) => r.text).map((r) => [`${r.subject_kind}/${r.subject_key}`, r.text])),
  };
}

function looks(catalog, kind, key, fallback) {
  const art = catalog.artDescriptions.get(`${ART_KIND[kind]}/${key}`);
  const text = art || fallback;
  return text ? `; looks like: ${text}` : '';
}

function tail(slot, cue) {
  return `; slot: ${slot}${cue ? `; sound cue: ${cue}` : ''}`;
}

function buildContext(catalog, kind, key, slot, { cue = null } = {}) {
  switch (kind) {
    case 'world': {
      const w = catalog.worlds.get(key);
      if (!w) return null;
      const regions = Array.isArray(w.biomes) && w.biomes.length ? `; regions: ${w.biomes.join(', ')}` : '';
      const levels = w.level_min != null && w.level_max != null ? `; levels ${w.level_min}-${w.level_max}` : '';
      return `world "${key}"${regions}${levels}${tail(slot, cue)}`;
    }
    case 'biome': {
      const b = catalog.biomes.get(key);
      if (!b) return null;
      return `biome "${key}"${b.art_style ? `; looks like: ${b.art_style}` : ''}${tail(slot, cue)}`;
    }
    case 'creature':
    case 'world_point': {
      const e = catalog.entities.get(key);
      if (!e) return null;
      const label = kind === 'creature' ? 'creature' : 'world point';
      return `${label} "${key}"${looks(catalog, kind, key, stripImageStyling(e.prompt))}${tail(slot, cue)}`;
    }
    case 'item': {
      const it = catalog.items.get(key);
      if (!it) return null;
      const lvl = it.req_level != null ? `; required level ${it.req_level}` : '';
      return `${it.category || 'item'} "${key}"${lvl}${looks(catalog, kind, key, '')}${tail(slot, cue)}`;
    }
    case 'skill': {
      const s = catalog.skills.get(key);
      if (!s) return null;
      return `${s.class} ${s.type} skill "${s.nameEn}"${looks(catalog, kind, key, '')}${tail(slot, cue)}`;
    }
    case 'attack_type': {
      const phrases = Object.hasOwn(ATTACK_TYPE_PHRASE, key) ? ATTACK_TYPE_PHRASE[key] : null;
      if (!phrases) return null;
      const phrase = Object.hasOwn(phrases, slot) ? phrases[slot] : phrases.use;
      return `${key} attack: ${phrase}${tail(slot, cue)}`;
    }
    default: return null;
  }
}

async function contextFor(db, kind, key, slot, opts) {
  return buildContext(await loadPromptCatalog(db), kind, key, slot, opts);
}

function isStale(row, current) {
  if (!row || !row.source_input || current == null) return false;
  return row.source_input.trim() !== String(current).trim();
}

module.exports = {
  loadPromptCatalog, buildContext, contextFor, isStale, stripImageStyling,
};
```
In `audioSubjects.js`, add `ATTACK_TYPE_PHRASE` to `module.exports`.

- [ ] **Step 4: Run the pure test**

Run: `node --test tests/audio_prompt_context.test.js`
Expected: PASS. If the item row's real `category` is not `'weapon'` in the fixture's shape, keep the fixture; the DB test below checks real rows.

- [ ] **Step 5: Write the DB test (real catalog rows, real art description)**

```js
// backend/tests/audio_prompt_context_db.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const ctx = require('../src/services/audioPromptContext');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('audioPromptContext against real catalog rows', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const creature = (await pool.query('SELECT name FROM entity_types WHERE is_creature ORDER BY name LIMIT 1')).rows[0];
  assert.ok(creature, 'scratch DB must have seeded catalogs (Task 1 Step 2)');
  const ids = [];
  t.after(async () => {
    try { if (ids.length) await pool.query('DELETE FROM art_prompt_descriptions WHERE id = ANY($1)', [ids]); } finally { await pool.end(); }
  });

  const before = await ctx.contextFor(pool, 'creature', creature.name, 'hurt', { cue: 'hit' });
  assert.ok(before && before.startsWith(`creature "${creature.name}"`), before);
  assert.equal(/pixel art|transparent background/i.test(before), false, `styling leaked: ${before}`);

  // Deactivate any existing active description for the duration? No -- only
  // insert one if none exists, so the shared state is never altered.
  const existing = await pool.query(
    "SELECT text FROM art_prompt_descriptions WHERE subject_kind = 'entity' AND subject_key = $1 AND active", [creature.name]);
  let expected = existing.rows[0] && existing.rows[0].text;
  if (!expected) {
    expected = `ctx-test-${process.pid} mossy hide`;
    ids.push((await pool.query(
      "INSERT INTO art_prompt_descriptions (subject_kind, subject_key, text) VALUES ('entity', $1, $2) RETURNING id",
      [creature.name, expected])).rows[0].id);
  }
  const after = await ctx.contextFor(pool, 'creature', creature.name, 'hurt', { cue: 'hit' });
  assert.ok(after.includes(`looks like: ${expected}`), `art description not used: ${after}`);
  if (ids.length) assert.equal(ctx.isStale({ source_input: before }, after), true, 'a new art description makes the prompt stale');
});
```
Check that the `art_prompt_descriptions` insert matches the table's NOT NULL columns (`\d art_prompt_descriptions`). Add `source_prompt`/`length` if required.

- [ ] **Step 6: Run both**

Run: `node --test tests/audio_prompt_context.test.js tests/audio_prompt_context_db.test.js`
Expected: PASS, exit 0.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/audioPromptContext.js backend/src/services/audioSubjects.js \
  backend/tests/audio_prompt_context.test.js backend/tests/audio_prompt_context_db.test.js
git commit -m "feat(audio): audioPromptContext -- per-slot LLM context from catalog + art descriptions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `audioPromptWriter` — contracts, validation, retry, store

**Files:**
- Create: `backend/src/services/audioPromptWriter.js`
- Test: `backend/tests/audio_prompt_writer.test.js`

**Interfaces:**
- Consumes: `textProvider.complete` (Task 2), `audioPrompts.save/getActive` (Task 4), `audioPromptContext.buildContext/loadPromptCatalog` (Task 5), `slotKind`/`cueFor` (audioSubjects), `rap.listStyles`, `resolveAudioProvider` (audioGeneration).
- Produces:
  - `writeSlotPrompt(db, { kind, key, slot, hint }, { tp, store, catalog, styles, cue, boxOnly }) → { ok: true, row } | { ok: false, error, busy, via }`
  - `loadStyles(db, { rap }) → { music: string[], ambience: string[] }` (empty lists when there is no audio provider)
  - `SYSTEM_MUSIC`, `SYSTEM_SFX` (exported for tests)

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/audio_prompt_writer.test.js
const test = require('node:test');
const assert = require('node:assert');
const w = require('../src/services/audioPromptWriter');

const CAT = {
  worlds: new Map([['Vale', { biomes: ['Meadow'], level_min: 1, level_max: 5 }]]),
  biomes: new Map(), entities: new Map([['Wolf', { prompt: 'a grey wolf' }]]),
  items: new Map(), skills: new Map(), artDescriptions: new Map(),
};
const STYLES = { music: ['medieval_fantasy', 'village'], ambience: ['forest', 'night'] };

function fakeStore() {
  const saved = [];
  return {
    saved,
    save: async (db, kind, key, slot, body) => { saved.push({ kind, key, slot, ...body }); return { id: saved.length, kind, key, slot, ...body }; },
  };
}
function fakeTp(answers) {
  const calls = [];
  return {
    calls,
    complete: async (db, req, opts) => { calls.push({ req, opts }); return answers.shift(); },
  };
}

test('music: schema enum is the box styles; stored with source_input and via', async () => {
  const store = fakeStore();
  const tp = fakeTp([{ ok: true, json: { style: 'village', prompt: 'warm lute over soft drums' }, model: 'q', via: 'box' }]);
  const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music', hint: 'darker' },
    { tp, store, catalog: CAT, styles: STYLES });
  assert.equal(r.ok, true, r.error);
  const req = tp.calls[0].req;
  assert.deepEqual(req.jsonSchema.properties.style.enum, ['medieval_fantasy', 'village']);
  assert.equal(req.system, w.SYSTEM_MUSIC);
  assert.match(req.prompt, /world "Vale"/);
  assert.match(req.prompt, /Admin hint: darker/);
  assert.deepEqual(store.saved[0], {
    kind: 'world', key: 'Vale', slot: 'music', style: 'village', text: 'warm lute over soft drums',
    sourceInput: 'world "Vale"; regions: Meadow; levels 1-5; slot: music', hint: 'darker', model: 'q', via: 'box',
  });
});

test('sfx: entity contract, no style, cue in the context', async () => {
  const store = fakeStore();
  const tp = fakeTp([{ ok: true, json: { entity: 'a snarling grey wolf' }, model: 'q', via: 'fallback' }]);
  const r = await w.writeSlotPrompt({}, { kind: 'creature', key: 'Wolf', slot: 'hurt' },
    { tp, store, catalog: CAT, styles: STYLES, cue: 'hit' });
  assert.equal(r.ok, true, r.error);
  assert.equal(tp.calls[0].req.system, w.SYSTEM_SFX);
  assert.deepEqual(Object.keys(tp.calls[0].req.jsonSchema.properties), ['entity']);
  assert.match(tp.calls[0].req.prompt, /sound cue: hit/);
  assert.equal(store.saved[0].style, null);
  assert.equal(store.saved[0].text, 'a snarling grey wolf');
  assert.equal(store.saved[0].via, 'fallback');
});

for (const [label, bad] of [
  ['json null', { ok: true, json: null, text: 'Sure! here', model: 'q', via: 'box' }],
  ['style not in list', { ok: true, json: { style: 'jazz', prompt: 'x' }, model: 'q', via: 'box' }],
  ['empty prompt', { ok: true, json: { style: 'village', prompt: '   ' }, model: 'q', via: 'box' }],
]) {
  test(`${label}: one retry, then fail WITHOUT storing`, async () => {
    const store = fakeStore();
    const tp = fakeTp([bad, bad]);
    const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music' }, { tp, store, catalog: CAT, styles: STYLES });
    assert.equal(r.ok, false);
    assert.equal(tp.calls.length, 2, 'exactly one retry');
    assert.equal(store.saved.length, 0);
  });
}

test('bad then good: stores the good one', async () => {
  const store = fakeStore();
  const tp = fakeTp([{ ok: true, json: null, model: 'q', via: 'box' }, { ok: true, json: { style: 'village', prompt: 'ok' }, model: 'q', via: 'box' }]);
  const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music' }, { tp, store, catalog: CAT, styles: STYLES });
  assert.equal(r.ok, true);
  assert.equal(store.saved.length, 1);
});

test('provider failure is not retried and carries busy/via', async () => {
  const store = fakeStore();
  const tp = fakeTp([{ ok: false, error: 'text service answered 409', busy: true, via: 'box' }]);
  const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music' }, { tp, store, catalog: CAT, styles: STYLES, boxOnly: true });
  assert.deepEqual({ ok: r.ok, busy: r.busy, via: r.via }, { ok: false, busy: true, via: 'box' });
  assert.equal(tp.calls.length, 1);
  assert.equal(tp.calls[0].opts.boxOnly, true);
});

test('music with no box styles known: refuses rather than guessing', async () => {
  const r = await w.writeSlotPrompt({}, { kind: 'world', key: 'Vale', slot: 'music' },
    { tp: fakeTp([]), store: fakeStore(), catalog: CAT, styles: { music: [], ambience: [] } });
  assert.equal(r.ok, false);
  assert.match(r.error, /no music styles/);
});

test('unknown subject: fails without calling the model', async () => {
  const tp = fakeTp([]);
  const r = await w.writeSlotPrompt({}, { kind: 'creature', key: 'Ghost', slot: 'hurt' }, { tp, store: fakeStore(), catalog: CAT, styles: STYLES });
  assert.equal(r.ok, false);
  assert.equal(tp.calls.length, 0);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `node --test tests/audio_prompt_writer.test.js`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implement**

```js
// backend/src/services/audioPromptWriter.js
//
// Writes ONE audio slot's prompt with the text model and stores it (spec
// 2026-09-30 §5). Two contracts:
//   music/ambience -> { style, prompt }: style constrained by the JSON
//     schema's enum to the box's own styles for that clip kind, and checked
//     again here (a model that ignores the schema is the case to survive).
//   sfx -> { entity }: a short phrase for the SOURCE of the sound, the same
//     shape as the box's own cue defaults ("a steel sword", "an old wooden
//     chest"). The cue already carries the action.
//
// One retry for a malformed answer, none for a provider failure: a busy box
// is the caller's to handle (batch waits or falls back), and retrying it here
// would only double the wait.
const defaultTp = require('./textProvider');
const defaultStore = require('./audioPrompts');
const { buildContext } = require('./audioPromptContext');
const { slotKind } = require('./audioSubjects');
const aiProviders = require('./aiProviders');
const defaultRap = require('./remoteAudioProvider');

const TEMPERATURE = () => {
  const raw = parseFloat(process.env.AUDIO_PROMPT_TEMPERATURE);
  return Number.isFinite(raw) ? raw : 0.15;
};

const SYSTEM_MUSIC = [
  'You write prompts for a music and ambience generator in a medieval fantasy RPG.',
  'Pick ONE style from the allowed list, then write a prompt of at most 40 words:',
  'instruments or sound sources, mood, tempo feel, texture. No lyrics, no vocals,',
  'no artist or song names, no sentences about the game -- only what should be heard.',
  'Ambience is environmental sound (wind, water, birds, crowd), never melodic music.',
  'Answer only with the JSON object.',
].join(' ');

const SYSTEM_SFX = [
  'You write the "entity" phrase for a sound-effect generator in a medieval fantasy RPG.',
  'The sound cue (hit, death, slash, spell, waypoint...) is fixed; describe the SOURCE',
  'of the sound in at most 10 words: what it is made of, how big, what voice it has.',
  'Examples: "a heavy iron mace", "a small bat with papery wings", "an old stone shrine humming".',
  'No verbs about the action, no sentences. Answer only with the JSON object.',
].join(' ');

function schemaFor(clipKind, styles) {
  if (clipKind === 'sfx') {
    return {
      type: 'object', properties: { entity: { type: 'string' } }, required: ['entity'], additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: { style: { type: 'string', enum: styles }, prompt: { type: 'string' } },
    required: ['style', 'prompt'],
    additionalProperties: false,
  };
}

// -> { style, text } | null
function validate(clipKind, json, styles) {
  if (!json || typeof json !== 'object') return null;
  if (clipKind === 'sfx') {
    const text = typeof json.entity === 'string' ? json.entity.trim() : '';
    return text ? { style: null, text } : null;
  }
  const text = typeof json.prompt === 'string' ? json.prompt.trim() : '';
  if (!text || !styles.includes(json.style)) return null;
  return { style: json.style, text };
}

async function loadStyles(db, { rap = defaultRap } = {}) {
  const provider = await aiProviders.loadActiveProviderWithSecret(db, 'audio');
  if (!provider) return { music: [], ambience: [] };
  const r = await rap.listStyles(provider);
  if (!r.ok) return { music: [], ambience: [] };
  return {
    music: r.styles.filter((s) => s.kind === 'music').map((s) => s.value),
    ambience: r.styles.filter((s) => s.kind === 'ambience').map((s) => s.value),
  };
}

async function writeSlotPrompt(db, {
  kind, key, slot, hint = null,
}, {
  tp = defaultTp, store = defaultStore, catalog, styles, cue = null, boxOnly = false,
} = {}) {
  const clipKind = slotKind(kind, slot);
  if (!clipKind) return { ok: false, error: 'unknown subject or slot' };
  const context = buildContext(catalog, kind, key, slot, { cue });
  if (!context) return { ok: false, error: 'unknown subject' };
  const allowed = clipKind === 'sfx' ? [] : (styles && styles[clipKind]) || [];
  if (clipKind !== 'sfx' && !allowed.length) {
    return { ok: false, error: `no ${clipKind} styles known -- add/refresh the audio provider first` };
  }
  const cleanHint = typeof hint === 'string' && hint.trim() ? hint.trim().slice(0, 200) : null;
  const request = {
    system: clipKind === 'sfx' ? SYSTEM_SFX : SYSTEM_MUSIC,
    prompt: [
      `Clip kind: ${clipKind}`,
      clipKind === 'sfx' ? null : `Allowed styles: ${allowed.join(', ')}`,
      `Subject: ${context}`,
      cleanHint ? `Admin hint: ${cleanHint}` : null,
    ].filter(Boolean).join('\n'),
    jsonSchema: schemaFor(clipKind, allowed),
    temperature: TEMPERATURE(),
    maxTokens: clipKind === 'sfx' ? 48 : 160,
  };
  let last = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await tp.complete(db, request, { boxOnly });
    if (!r.ok) return { ok: false, error: r.error, busy: Boolean(r.busy), via: r.via };
    const good = validate(clipKind, r.json, allowed);
    if (good) {
      // eslint-disable-next-line no-await-in-loop
      const row = await store.save(db, kind, key, slot, {
        style: good.style, text: good.text, sourceInput: context, hint: cleanHint, model: r.model, via: r.via,
      });
      return { ok: true, row };
    }
    last = r;
  }
  return {
    ok: false, error: `the model did not return a usable ${clipKind === 'sfx' ? 'entity' : 'style + prompt'} (twice)`, busy: false, via: last && last.via,
  };
}

module.exports = {
  writeSlotPrompt, loadStyles, SYSTEM_MUSIC, SYSTEM_SFX,
};
```

- [ ] **Step 4: Run and see it pass**

Run: `node --test tests/audio_prompt_writer.test.js`
Expected: PASS, exit 0. Note the `sourceInput` expected in the first test comes from Task 5's world format. If that format ever changes, both change together.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/audioPromptWriter.js backend/tests/audio_prompt_writer.test.js
git commit -m "feat(audio): audioPromptWriter -- music/sfx contracts, schema, one retry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Generation uses the stored prompt

**Files:**
- Modify: `backend/src/services/audioGeneration.js:75-84` (music/ambience), `:208-232` (`sfxRequestFor`)
- Test: `backend/tests/audio_generation_prompts_db.test.js`

**Interfaces:**
- Consumes: `audioPrompts.getActive` (Task 4).
- Produces: unchanged signatures. `generateForSlot(db, provider, spec, { rap, lib, prompts })` and `sfxRequestFor(db, provider, target, { prompts })` accept an injectable `prompts` (default `require('./audioPrompts')`).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/audio_generation_prompts_db.test.js
// Precedence: request > stored > propose/entityPhrase. The fake box FAILS on
// an unexpected body, so a precedence bug cannot pass by being ignored.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const assetStore = require('../src/services/assetStore');
const lib = require('../src/services/audioLibrary');
const gen = require('../src/services/audioGeneration');
const prompts = require('../src/services/audioPrompts');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;
const OGG = fs.readFileSync(path.join(__dirname, 'fixtures/audio/tone.ogg'));

test('generation reads the stored prompt', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
    assetStore.__setAssetClient({ bucketExists: async () => true, putObject: async () => {} });
    const tag = `genp-${process.pid}-${Date.now()}`;
    const creature = (await pool.query('SELECT name FROM entity_types WHERE is_creature ORDER BY name LIMIT 1')).rows[0].name;
    const worldId = (await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [tag])).rows[0].id;
    t.after(async () => {
      try {
        await pool.query(`DELETE FROM audio_clips WHERE id IN (SELECT clip_id FROM audio_bindings WHERE subject_key = ANY($1))`, [[tag, creature]]);
        await pool.query('DELETE FROM audio_prompts WHERE subject_key = ANY($1)', [[tag, creature]]);
        await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
      } finally { await pool.end(); }
    });
    // The creature's pre-existing active prompt (if any) must not be clobbered
    // on a shared DB -- this runs on the scratch DB only, but be explicit.
    assert.equal(await prompts.getActive(pool, 'creature', creature, 'hurt'), null, 'scratch DB expected: no creature prompt yet');

    const calls = [];
    const rap = {
      propose: async () => { calls.push('propose'); return { ok: true, style: 'village', slots: {}, prompt: 'proposed' }; },
      generateTrack: async (p, body) => { calls.push(['track', body.style, body.prompt]); return { ok: true, buffer: OGG, durationMs: 2000, loopStartMs: 0, loopEndMs: 2000, prompt: body.prompt, seed: body.seed }; },
      generateSfx: async (p, body) => { calls.push(['sfx', body.entity]); return { ok: true, clips: [{ buffer: OGG, durationMs: 500 }], cached: false, prompt: body.entity, seed: body.seed }; },
    };
    const provider = { id: null, base_url: 'http://x', modality: 'audio', models_cache: ['cue:hit'] };
    const spec = (over) => ({ subjectKind: 'world', subjectKey: tag, slot: 'music', clipKind: 'music', seed: 3, ...over });

    // 1. stored prompt, no request prompt -> stored used, NO propose
    await prompts.save(pool, 'world', tag, 'music', { style: 'medieval_fantasy', text: 'stored lute theme' });
    let r = await gen.generateForSlot(pool, provider, spec(), { rap, lib });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(calls, [['track', 'medieval_fantasy', 'stored lute theme']]);

    // 2. request prompt beats stored
    calls.length = 0;
    r = await gen.generateForSlot(pool, provider, spec({ style: 'tavern', prompt: 'typed' }), { rap, lib });
    assert.deepEqual(calls, [['track', 'tavern', 'typed']]);

    // 3. stored '' (cleared) -> falls through to propose
    calls.length = 0;
    await prompts.save(pool, 'world', tag, 'music', { style: null, text: '' });
    r = await gen.generateForSlot(pool, provider, spec(), { rap, lib });
    assert.deepEqual(calls, ['propose', ['track', 'village', 'proposed']]);

    // 4. sfx: stored text becomes entity, take suffix preserved
    calls.length = 0;
    await prompts.save(pool, 'creature', creature, 'hurt', { text: 'a mossy swamp beast' });
    r = await gen.generateForSlot(pool, provider,
      { subjectKind: 'creature', subjectKey: creature, slot: 'hurt', clipKind: 'sfx', seed: 4, variants: 1 }, { rap, lib });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(calls, [['sfx', 'a mossy swamp beast']], 'take 0 = no suffix');
    calls.length = 0;
    r = await gen.generateForSlot(pool, provider,
      { subjectKind: 'creature', subjectKey: creature, slot: 'hurt', clipKind: 'sfx', seed: 5, variants: 1 }, { rap, lib });
    assert.deepEqual(calls, [['sfx', 'a mossy swamp beast (take 1)']]);

    // 5. sfx cleared '' -> entityPhrase again
    calls.length = 0;
    await prompts.save(pool, 'creature', creature, 'hurt', { text: '' });
    r = await gen.generateForSlot(pool, provider,
      { subjectKind: 'creature', subjectKey: creature, slot: 'hurt', clipKind: 'sfx', seed: 6, variants: 1 }, { rap, lib });
    assert.deepEqual(calls, [['sfx', `${creature.toLowerCase()} (take 2)`]]);
  });
});
```
Check `rap.generateSfx`'s real result shape in `remoteAudioProvider.js:193-222` and adjust the fake's `clips` items to match what `freshVariants`/`storeSfxVariants` read (`buffer`, `durationMs`).

- [ ] **Step 2: Run and see it fail**

Run: `node --test tests/audio_generation_prompts_db.test.js`
Expected: FAIL at case 1. `calls` starts with `'propose'`, because the stored prompt is ignored.

- [ ] **Step 3: Implement**

At the top of `audioGeneration.js`:
```js
const defaultPrompts = require('./audioPrompts');
```
In `generateForSlot`, change the signature to `{ rap = defaultRap, lib = defaultLib, prompts = defaultPrompts } = {}`, pass `prompts` into the sfx branch (`generateSfxForSlot(db, provider, spec, { rap, lib, prompts })`), and replace the propose block:
```js
  // Precedence (spec 2026-09-30 §6): the request's own style/prompt, then the
  // slot's stored prompt, then the box's propose. A stored '' means "cleared
  // on purpose" and falls through.
  if (!style && !prompt) {
    const stored = await prompts.getActive(db, subjectKind, subjectKey, slot);
    if (stored && stored.text) ({ style, prompt } = { style: stored.style, prompt: stored.text });
  }
  if (!style && !prompt) {
    const p = await rap.propose(provider, { context: await contextFor(db, subjectKind, subjectKey, slot), kind: clipKind });
    if (p.ok) ({ style, slots, prompt } = { style: p.style, slots: p.slots, prompt: p.prompt });
  }
```
In `generateSfxForSlot(db, provider, spec, { rap, lib, prompts = defaultPrompts })`, pass it on as `sfxRequestFor(db, provider, {...}, { prompts })`. In `sfxRequestFor`, change the signature to `async function sfxRequestFor(db, provider, { subjectKind, subjectKey, slot, engine }, { prompts = defaultPrompts } = {})` and replace the `phrase:` line:
```js
  // The slot's stored prompt, when there is one, IS the entity text (spec
  // 2026-09-30 §6). Editing it therefore also gets past the box's global
  // (engine, cue, entity) cache. '' = cleared -> the registry phrase.
  const stored = await prompts.getActive(db, subjectKind, subjectKey, slot);
  const phrase = stored && stored.text ? stored.text : subjects.entityPhrase(db, subjectKind, subjectKey, slot);
```
Use `phrase,` in the returned object. Update every other `sfxRequestFor` caller (the pack path, `grep -n sfxRequestFor backend/src`); the default parameter keeps them working unchanged.

- [ ] **Step 4: Run the new test and every audio generation/dispatcher test**

Run: `node --test --test-concurrency=1 tests/audio_generation_prompts_db.test.js tests/audio_generation_db.test.js tests/audio_sfx_generation_db.test.js tests/audio_sfx_dedupe_drain_db.test.js tests/audio_dispatcher_db.test.js`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/audioGeneration.js backend/tests/audio_generation_prompts_db.test.js
git commit -m "feat(audio): generation uses the slot's stored prompt (request > stored > propose)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Admin prompt routes + prompt state in `/admin/subjects`

**Files:**
- Modify: `backend/src/api/audioRoutes.js` (new routes after `/admin/propose`, `promptStates` in `/admin/subjects`)
- Test: `backend/tests/audio_prompt_routes_db.test.js`

**Interfaces:**
- Consumes: Tasks 4-6, `checkSubject`, `cueFor`.
- Produces (all adminGuard'd, under `/api/audio`):
  - `GET /admin/prompts/:kind/:key` → `{ [slot]: { active: row|null, history: row[], stale: bool, currentInput: string|null } }`
  - `PUT /admin/prompts/:kind/:key/:slot` body `{ style?, text, expect_active_id }` → `200 row`; `400` for a bad slot or a style unknown to the active audio provider; `409` on conflict.
  - `POST /admin/prompts/:kind/:key/:slot/write` body `{ hint? }` → `201 row` | `502 { error, via }`
  - `GET /admin/subjects` groups gain `promptStates: { [key]: { [slot]: 'written' | 'stale' | 'cleared' } }` (absent = none).

- [ ] **Step 1: Write the failing test**

```js
// backend/tests/audio_prompt_routes_db.test.js
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const request = require('supertest');
const { Pool } = require('pg');
const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;

test('audio prompt routes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  __setPool(pool);
  const tag = `apr-${process.pid}-${Date.now()}`;
  const seen = [];
  let textStatus = 200;
  const box = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/text') {
        res.statusCode = textStatus;
        if (textStatus !== 200) return res.end('{"detail":"nope"}');
        return res.end(JSON.stringify({ text: '', json: { style: 'village', prompt: 'gentle lute' }, model: 'qwen-instruct', ms: 5 }));
      }
      if (req.url.startsWith('/api/audio/styles')) {
        return res.end(JSON.stringify(req.url.includes('kind=sfx') ? [] : [{ value: 'village', label: 'Village', kind: 'music', slots: {} }]));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => box.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${box.address().port}`;

  // Park any active audio/text providers for the test, restore after.
  const parked = (await pool.query(
    "UPDATE ai_providers SET is_active = false WHERE is_active AND modality IN ('audio', 'text') RETURNING id")).rows.map((r) => r.id);
  const provIds = (await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template, modality, is_active, auth_token, models_cache)
     VALUES ($1, $2, '{}', 'text', true, 'k', NULL), ($3, $2, '{}', 'audio', true, 'k', '["village"]'::jsonb) RETURNING id`,
    [`${tag}-t`, base, `${tag}-a`])).rows.map((r) => r.id);
  const worldId = (await pool.query('INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [tag])).rows[0].id;
  const u = (await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, username, role, token_version", [tag])).rows[0];
  const auth = `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.token_version })}`;
  const pu = (await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id, username, role, token_version", [`${tag}-p`])).rows[0];
  const playerAuth = `Bearer ${signToken({ userId: pu.id, username: pu.username, role: pu.role, tokenVersion: pu.token_version })}`;
  // ONE cleanup hook: node:test runs t.after hooks in registration order, so
  // a second hook registered later would run against a closed pool.
  t.after(async () => {
    box.close();
    try {
      await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [tag]);
      await pool.query('DELETE FROM ai_providers WHERE id = ANY($1)', [provIds]);
      if (parked.length) await pool.query('UPDATE ai_providers SET is_active = true WHERE id = ANY($1)', [parked]);
      await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [[u.id, pu.id]]);
    } finally { await pool.end(); }
  });
  const P = `/api/audio/admin/prompts/world/${encodeURIComponent(tag)}`;

  // write with the model
  const w = await request(app).post(`${P}/music/write`).set('Authorization', auth).send({ hint: 'sleepy' });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  assert.deepEqual([w.body.style, w.body.text, w.body.via, w.body.hint], ['village', 'gentle lute', 'box', 'sleepy']);
  const sent = seen.find((s) => s.url === '/api/text').body;
  assert.match(sent.prompt, new RegExp(`world "${tag}"`));

  // read back: not stale
  let g = await request(app).get(P).set('Authorization', auth);
  assert.equal(g.body.music.active.id, w.body.id);
  assert.equal(g.body.music.stale, false);

  // hand edit with a style the box does not know -> 400
  const badStyle = await request(app).put(`${P}/music`).set('Authorization', auth)
    .send({ style: 'forrest', text: 'x', expect_active_id: w.body.id });
  assert.equal(badStyle.status, 400);
  assert.match(badStyle.body.error, /style/);

  // hand edit ok
  const put = await request(app).put(`${P}/music`).set('Authorization', auth)
    .send({ style: 'village', text: 'my own', expect_active_id: w.body.id });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual([put.body.text, put.body.model, put.body.via, put.body.source_input], ['my own', null, null, null]);

  // stale edit -> 409
  const stale = await request(app).put(`${P}/music`).set('Authorization', auth)
    .send({ style: 'village', text: 'late', expect_active_id: w.body.id });
  assert.equal(stale.status, 409);

  // subjects carries prompt state
  const subj = await request(app).get('/api/audio/admin/subjects').set('Authorization', auth);
  const worldGroup = subj.body.find((gr) => gr.kind === 'world');
  assert.equal(worldGroup.promptStates[tag].music, 'written');

  // model failure -> 502 with via, nothing stored
  textStatus = 400;
  const before = (await pool.query('SELECT count(*)::int n FROM audio_prompts WHERE subject_key = $1', [tag])).rows[0].n;
  const fail = await request(app).post(`${P}/ambience/write`).set('Authorization', auth).send({});
  assert.equal(fail.status, 502);
  assert.equal(fail.body.via, 'box');
  assert.equal((await pool.query('SELECT count(*)::int n FROM audio_prompts WHERE subject_key = $1', [tag])).rows[0].n, before);

  // unknown slot -> 400; non-admin -> 403
  assert.equal((await request(app).put(`${P}/nope`).set('Authorization', auth).send({ text: 'x' })).status, 400);
  assert.equal((await request(app).get(P).set('Authorization', playerAuth)).status, 403);
});
```
Parking the active audio/text providers is safe only on the scratch DB (Global Constraints). If `worlds` needs a non-null `biomes`, check `\d worlds` and add it to the insert.

- [ ] **Step 2: Run and see it fail**

Run: `node --test tests/audio_prompt_routes_db.test.js`
Expected: FAIL, 404 on `/write`.

- [ ] **Step 3: Implement the routes**

In `audioRoutes.js` requires:
```js
const audioPrompts = require('../services/audioPrompts');
const { loadPromptCatalog, buildContext, isStale } = require('../services/audioPromptContext');
const { writeSlotPrompt, loadStyles } = require('../services/audioPromptWriter');
const aiProviders = require('../services/aiProviders');
```
Add a helper above `module.exports`:
```js
// The style a hand edit may save: one the active audio provider reported
// (models_cache holds style values plus "cue:"-prefixed cues). With no
// provider or an empty cache there is nothing to check against, so any
// style is accepted -- refusing would lock editing on a box-less install.
async function unknownStyle(pool, style) {
  if (!style) return false;
  const p = await aiProviders.loadActiveProviderWithSecret(pool, 'audio');
  const known = p && Array.isArray(p.models_cache) ? p.models_cache.filter((m) => !m.startsWith('cue:')) : [];
  return known.length > 0 && !known.includes(style);
}
```
Add these routes after `/admin/propose`:
```js
  // Spec 2026-09-30 §7. Every slot of one subject: active prompt, history,
  // and whether the context the prompt was written from has moved.
  router.get('/admin/prompts/:kind/:key', admin, async (req, res) => {
    const { kind, key } = req.params;
    try {
      const def = SUBJECT_KINDS[kind];
      if (!def || !Object.hasOwn(SUBJECT_KINDS, kind)) return res.status(400).json({ error: 'unknown subject kind' });
      const [bySlot, catalog] = await Promise.all([audioPrompts.listForSubject(pool, kind, key), loadPromptCatalog(pool)]);
      const out = {};
      for (const slot of Object.keys(def.slots)) {
        // eslint-disable-next-line no-await-in-loop
        const cue = slotKind(kind, slot) === 'sfx' ? await cueFor(pool, kind, key, slot) : null;
        const currentInput = buildContext(catalog, kind, key, slot, { cue });
        const entry = bySlot[slot] || { active: null, history: [] };
        out[slot] = { ...entry, currentInput, stale: isStale(entry.active, currentInput) };
      }
      res.json(out);
    } catch (err) { sendError(res, err); }
  });

  router.put('/admin/prompts/:kind/:key/:slot', admin, async (req, res) => {
    const { kind, key, slot } = req.params;
    const b = req.body || {};
    try {
      const { clipKind, error } = await checkSubject(pool, kind, key, slot);
      if (error) return res.status(400).json({ error });
      if (typeof b.text !== 'string') return res.status(400).json({ error: 'text must be a string' });
      const style = clipKind === 'sfx' ? null : (typeof b.style === 'string' && b.style.trim() ? b.style.trim() : null);
      if (await unknownStyle(pool, style)) return res.status(400).json({ error: `style '${style}' is not one the audio provider offers` });
      const row = await audioPrompts.save(pool, kind, key, slot, { style, text: b.text }, {
        expectActiveId: b.expect_active_id === undefined ? undefined : b.expect_active_id,
      });
      res.json(row);
    } catch (err) {
      if (err && err.status === 409) return res.status(409).json({ error: err.message });
      sendError(res, err);
    }
  });

  router.post('/admin/prompts/:kind/:key/:slot/write', admin, async (req, res) => {
    const { kind, key, slot } = req.params;
    try {
      const { clipKind, error } = await checkSubject(pool, kind, key, slot);
      if (error) return res.status(400).json({ error });
      const [catalog, styles] = await Promise.all([
        loadPromptCatalog(pool), clipKind === 'sfx' ? { music: [], ambience: [] } : loadStyles(pool),
      ]);
      const cue = clipKind === 'sfx' ? await cueFor(pool, kind, key, slot) : null;
      const r = await writeSlotPrompt(pool, { kind, key, slot, hint: (req.body || {}).hint }, { catalog, styles, cue });
      if (!r.ok) return res.status(502).json({ error: r.error, via: r.via ?? null });
      res.status(201).json(r.row);
    } catch (err) {
      if (err && err.status === 409) return res.status(409).json({ error: err.message });
      sendError(res, err);
    }
  });
```
Check `cueFor`'s real signature in `audioSubjects.js` (it is async and takes `(db, kind, key, slot)`, per `sfxRequestFor`).

In `/admin/subjects`, before the loop:
```js
      // Prompt coverage (spec 2026-09-30 §7): one read of every active prompt
      // and one catalog snapshot, never a query per slot. Stale needs the cue
      // for sfx slots; those come from the kind's subjectCues, loaded below.
      const [activePrompts, promptCatalog] = await Promise.all([audioPrompts.listAllActive(pool), loadPromptCatalog(pool)]);
```
Inside the loop, after `entry.cues` is set:
```js
        const states = {};
        for (const p of activePrompts) {
          if (p.subject_kind !== kind) continue;
          const cue = entry.cues && entry.cues[p.subject_key] ? entry.cues[p.subject_key][p.slot] || null : null;
          let state = 'written';
          if (!p.text) state = 'cleared';
          else if (isStale(p, buildContext(promptCatalog, kind, p.subject_key, p.slot, { cue }))) state = 'stale';
          (states[p.subject_key] ||= {})[p.slot] = state;
        }
        entry.promptStates = states;
```

- [ ] **Step 4: Run it plus the existing audio route suites**

Run: `node --test --test-concurrency=1 tests/audio_prompt_routes_db.test.js tests/audio_routes_db.test.js tests/audio_slot_table_routes_db.test.js`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/audioRoutes.js backend/tests/audio_prompt_routes_db.test.js
git commit -m "feat(audio): prompt read/save/write routes + promptStates in /admin/subjects

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `make audio-describe`

**Files:**
- Create: `backend/scripts/describe-audio-slots.js`
- Modify: `Makefile` (phony list line 6, target after `art-describe`)
- Test: `backend/tests/describe_audio_slots.test.js` (pure selection + summary), `backend/tests/describe_audio_slots_db.test.js`

**Interfaces:**
- Consumes: Tasks 4-6, `SUBJECT_KINDS`, `slotKind`, `cueFor`.
- Produces: `selectSlots(slots, activeByKey, currentByKey, { kinds, slot, stale, limit }) → { todo, skipped }`, `summarize(results) → { [kind]: { written, failed, box, fallback, duplicates } }`, `run(db, opts, deps) → summary`.

- [ ] **Step 1: Write the failing pure test**

```js
// backend/tests/describe_audio_slots.test.js
const test = require('node:test');
const assert = require('node:assert');
const { selectSlots, summarize } = require('../scripts/describe-audio-slots');

const S = (kind, key, slot) => ({ kind, key, slot, id: `${kind}/${key}/${slot}` });
const slots = [S('world', 'Vale', 'music'), S('world', 'Vale', 'ambience'), S('creature', 'Wolf', 'hurt'), S('creature', 'Bat', 'hurt')];

test('skip active, keep missing; stale only with --stale', () => {
  const active = new Map([['world/Vale/music', { source_input: 'old' }], ['creature/Wolf/hurt', { source_input: 'same' }]]);
  const current = new Map([['world/Vale/music', 'new'], ['creature/Wolf/hurt', 'same']]);
  let r = selectSlots(slots, active, current, {});
  assert.deepEqual(r.todo.map((s) => s.id), ['world/Vale/ambience', 'creature/Bat/hurt']);
  assert.deepEqual(r.skipped, { written: 1, stale: 1 });
  r = selectSlots(slots, active, current, { stale: true });
  assert.deepEqual(r.todo.map((s) => s.id), ['world/Vale/music'], '--stale rewrites stale rows ONLY');
});

test('kinds, slot and limit filter', () => {
  const r = selectSlots(slots, new Map(), new Map(), { kinds: ['creature'], slot: 'hurt', limit: 1 });
  assert.deepEqual(r.todo.map((s) => s.id), ['creature/Wolf/hurt']);
});

test('summary counts duplicates ACROSS subjects', () => {
  const sum = summarize([
    { kind: 'creature', key: 'Wolf', ok: true, via: 'box', text: 'a beast' },
    { kind: 'creature', key: 'Bat', ok: true, via: 'fallback', text: 'A Beast' },
    { kind: 'creature', key: 'Rat', ok: false },
  ]);
  assert.deepEqual(sum.creature, { written: 2, failed: 1, box: 1, fallback: 1, duplicates: 1 });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `node --test tests/describe_audio_slots.test.js`
Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Implement the script**

```js
#!/usr/bin/env node
// Audio prompt writer batch (spec 2026-09-30 §8): write a stored prompt for
// every audio slot that has none.
//
// RESUMABLE WITH NO CURSOR: a slot with an active prompt is skipped, so the
// database is the progress and killing the run is safe (same rule as
// describe-subjects.js). SEQUENTIAL: one text model serves one request at a
// time, and the box's gateway swaps models -- parallel calls only queue.
//
// A BUSY BOX NEVER STOPS THE RUN. Without --box-only a busy box means the
// CPU fallback answers; with it, the run waits and retries the same slot.
// Five consecutive NON-busy failures stop it (the describer is down; writing
// 2,300 identical failures into the log helps nobody).
//
// DUPLICATES ARE REPORTED, NOT FIXED. The art epic measured 12 of 20 skills
// collapsing to one generic weapon; the per-kind duplicate count is how that
// shows up here before a full run is spent on it.
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { SUBJECT_KINDS, slotKind, cueFor } = require('../src/services/audioSubjects');
const audioPrompts = require('../src/services/audioPrompts');
const { loadPromptCatalog, buildContext, isStale } = require('../src/services/audioPromptContext');
const writer = require('../src/services/audioPromptWriter');

const CONSECUTIVE_FAILURE_LIMIT = 5;
const BUSY_WAIT_MS = () => Number(process.env.AUDIO_DESCRIBE_BUSY_WAIT_MS) || 30000;

function selectSlots(slots, activeByKey, currentByKey, {
  kinds = null, slot = null, stale = false, limit = 0,
} = {}) {
  const todo = [];
  const skipped = { written: 0, stale: 0 };
  for (const s of slots) {
    if (kinds && !kinds.includes(s.kind)) continue;
    if (slot && s.slot !== slot) continue;
    const active = activeByKey.get(s.id);
    const isStaleRow = Boolean(active) && isStale(active, currentByKey.get(s.id));
    if (stale) {
      if (isStaleRow) todo.push(s);
    } else if (!active) {
      todo.push(s);
    } else if (isStaleRow) skipped.stale += 1; else skipped.written += 1;
    if (limit && todo.length >= limit) break;
  }
  return { todo, skipped };
}

function summarize(results) {
  const out = {};
  const seen = {};
  for (const r of results) {
    const k = (out[r.kind] ||= { written: 0, failed: 0, box: 0, fallback: 0, duplicates: 0 });
    if (!r.ok) { k.failed += 1; continue; }
    k.written += 1;
    if (r.via === 'box') k.box += 1; else if (r.via === 'fallback') k.fallback += 1;
    const norm = String(r.text || '').trim().toLowerCase();
    const bucket = (seen[r.kind] ||= new Map());
    if (bucket.has(norm)) k.duplicates += 1; else bucket.set(norm, r.key);
  }
  return out;
}

async function allSlots(db) {
  const out = [];
  for (const [kind, def] of Object.entries(SUBJECT_KINDS)) {
    // eslint-disable-next-line no-await-in-loop
    const keys = await def.list(db);
    for (const key of keys) {
      for (const slot of Object.keys(def.slots)) out.push({ kind, key, slot, id: `${kind}/${key}/${slot}` });
    }
  }
  return out;
}

async function run(db, opts, { log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), write = writer.writeSlotPrompt, loadStyles = writer.loadStyles } = {}) {
  const [slots, active, catalog] = await Promise.all([allSlots(db), audioPrompts.listAllActive(db), loadPromptCatalog(db)]);
  const activeByKey = new Map(active.map((p) => [`${p.subject_kind}/${p.subject_key}/${p.slot}`, p]));
  const cues = new Map();
  const currentByKey = new Map();
  for (const s of slots) {
    const cue = slotKind(s.kind, s.slot) === 'sfx' ? await cueFor(db, s.kind, s.key, s.slot) : null; // eslint-disable-line no-await-in-loop
    cues.set(s.id, cue);
    currentByKey.set(s.id, buildContext(catalog, s.kind, s.key, s.slot, { cue }));
  }
  const { todo, skipped } = selectSlots(slots, activeByKey, currentByKey, opts);
  log(`${todo.length} slot(s) to write; skipped ${skipped.written} written, ${skipped.stale} stale`);
  if (opts.dryRun) {
    for (const s of todo) log(`  ${s.id}: ${currentByKey.get(s.id)}`);
    return { dryRun: true, todo: todo.length };
  }
  const styles = await loadStyles(db);
  const results = [];
  let consecutive = 0;
  for (let i = 0; i < todo.length; i += 1) {
    const s = todo[i];
    // eslint-disable-next-line no-await-in-loop
    const r = await write(db, { kind: s.kind, key: s.key, slot: s.slot }, {
      catalog, styles, cue: cues.get(s.id), boxOnly: Boolean(opts.boxOnly),
    });
    if (!r.ok && r.busy && opts.boxOnly) {
      log(`  busy, waiting: ${r.error}`);
      await sleep(BUSY_WAIT_MS()); // eslint-disable-line no-await-in-loop
      i -= 1;
      continue;
    }
    results.push({ kind: s.kind, key: s.key, ok: r.ok, via: r.ok ? r.row.via : r.via, text: r.ok ? r.row.text : null });
    log(`  [${i + 1}/${todo.length}] ${s.id}: ${r.ok ? `${r.row.via} ${r.row.style ? `(${r.row.style}) ` : ''}${r.row.text}` : `FAILED ${r.error}`}`);
    consecutive = r.ok ? 0 : consecutive + 1;
    if (consecutive >= CONSECUTIVE_FAILURE_LIMIT) {
      log(`stopping: ${CONSECUTIVE_FAILURE_LIMIT} failures in a row (last: ${r.error})`);
      break;
    }
  }
  const summary = summarize(results);
  log(JSON.stringify(summary, null, 2));
  return summary;
}

function parseArgs(argv) {
  const get = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    kinds: get('--kind') ? get('--kind').split(',').map((s) => s.trim()) : null,
    slot: get('--slot') || null,
    limit: get('--limit') ? Number(get('--limit')) : 0,
    dryRun: argv.includes('--dry-run'),
    stale: argv.includes('--stale'),
    boxOnly: argv.includes('--box-only'),
  };
}

if (require.main === module) {
  dotenv.config({ path: path.join(__dirname, '../.env') });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  run(pool, parseArgs(process.argv.slice(2)))
    .then(() => pool.end())
    .catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
}

module.exports = {
  selectSlots, summarize, run, parseArgs,
};
```
Check how `describe-subjects.js` loads dotenv, and copy that exact line. The memory notes a dotenv-before-guard trap, so match the existing script.

- [ ] **Step 4: Run the pure test**

Run: `node --test tests/describe_audio_slots.test.js`
Expected: PASS.

- [ ] **Step 5: Write the DB test for `run` (injected writer, real slots)**

```js
// backend/tests/describe_audio_slots_db.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { run } = require('../scripts/describe-audio-slots');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('describe-audio-slots run()', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());
  const writes = [];
  const write = async (db, target, opts) => { writes.push({ target, opts }); return { ok: true, row: { via: 'box', text: `t${writes.length}`, style: null } }; };
  const logs = [];
  const dry = await run(pool, { kinds: ['attack_type'], dryRun: true }, { log: (l) => logs.push(l), write, loadStyles: async () => ({ music: [], ambience: [] }) });
  assert.equal(writes.length, 0, 'dry run writes nothing');
  assert.equal(dry.todo, 6, '3 attack types x 2 slots on a clean scratch DB');

  let busyOnce = true;
  const flaky = async (db, target, opts) => {
    if (busyOnce) { busyOnce = false; return { ok: false, busy: true, error: '409' }; }
    return write(db, target, opts);
  };
  const slept = [];
  const sum = await run(pool, { kinds: ['attack_type'], slot: 'use', boxOnly: true },
    { log: () => {}, write: flaky, sleep: async (ms) => { slept.push(ms); }, loadStyles: async () => ({ music: [], ambience: [] }) });
  assert.equal(slept.length, 1, 'busy under --box-only waits once and retries the SAME slot');
  assert.equal(sum.attack_type.written, 3);
  assert.equal(writes.every((w) => w.opts.boxOnly === true), true);
  assert.ok(writes.some((w) => w.opts.cue === 'slash'), 'cue is passed for sfx slots');
});
```

- [ ] **Step 6: Run it**

Run: `node --test tests/describe_audio_slots_db.test.js`
Expected: PASS. If the scratch DB already has attack_type prompts from a manual run, the count differs. Use a fresh scratch DB and don't loosen the assertion.

- [ ] **Step 7: Makefile target**

Add `audio-describe` to the `.PHONY` list next to `art-describe`, and after the `art-describe` target:
```make
# Audio prompt writer (spec 2026-09-30 §8). Resumable; safe to kill.
#   make audio-describe DRY=1 LIMIT=20 KIND=creature   preview, store nothing
#   make audio-describe KIND=world,biome               some subject kinds
#   make audio-describe SLOT=hurt                      one slot name
#   make audio-describe STALE=1                        rewrite stale prompts only
#   make audio-describe BOX_ONLY=1                     never use the CPU fallback; wait for the box
audio-describe:
	$(COMPOSE) exec -T backend node scripts/describe-audio-slots.js \
		$(if $(KIND),--kind "$(KIND)") $(if $(SLOT),--slot "$(SLOT)") \
		$(if $(LIMIT),--limit "$(LIMIT)") $(if $(DRY),--dry-run) \
		$(if $(STALE),--stale) $(if $(BOX_ONLY),--box-only)
```

- [ ] **Step 8: Commit**

```bash
git add backend/scripts/describe-audio-slots.js backend/tests/describe_audio_slots.test.js backend/tests/describe_audio_slots_db.test.js Makefile
git commit -m "feat(audio): make audio-describe -- resumable batch prompt writer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Prompts in `audio-export` / `audio-seed`

**Files:**
- Modify: `backend/src/services/audioSeed.js` (`exportAudio` ~65-215, `seedAudio` ~224-330)
- Test: `backend/tests/audio_seed_prompts_db.test.js`

**Interfaces:**
- Consumes: `audioPrompts.listAllActive`, `audioPrompts.getActive`, `audioPrompts.save`.
- Produces: `seeds/audio/prompts.json` = `[{ subject_kind, subject_key, slot, style, text, source_input, hint, model, via }]`, sorted by kind/key/slot.

Rule: `prompts.json` is always the **full** active set, whatever `KIND`/`ONLY` says. Filtering it by clip kind would repeat the merge-by-kind overwrite trap from slice 2. Seeding saves a row only when no active row exists or the active `(style, text)` differs, so re-seeding is idempotent and never piles up history.

- [ ] **Step 1: Write the failing test**

Read `exportAudio`/`seedAudio`'s option names first (`sed -n 60,75p;220,235p backend/src/services/audioSeed.js`); the test calls them with a temp `root`.
```js
// backend/tests/audio_seed_prompts_db.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { withAdvisoryLock, AUDIO_CLIPS_LOCK_KEY } = require('./helpers/advisoryLock.js');
const seed = require('../src/services/audioSeed');
const prompts = require('../src/services/audioPrompts');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('prompts.json round trip', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  await withAdvisoryLock(pool, AUDIO_CLIPS_LOCK_KEY, async () => {
    const key = `seedp-${process.pid}-${Date.now()}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-seed-'));
    t.after(async () => {
      fs.rmSync(root, { recursive: true, force: true });
      try { await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [key]); } finally { await pool.end(); }
    });
    await prompts.save(pool, 'world', key, 'music', { style: 'village', text: 'exported lute', sourceInput: 'ctx', model: 'q', via: 'box' });

    await seed.exportAudio({ db: pool, root, kinds: ['sfx'] });
    const file = JSON.parse(fs.readFileSync(path.join(root, 'prompts.json'), 'utf8'));
    assert.ok(file.some((p) => p.subject_key === key && p.text === 'exported lute'), 'KIND=sfx still exports every prompt');

    await pool.query('DELETE FROM audio_prompts WHERE subject_key = $1', [key]);
    await seed.seedAudio({ db: pool, root });
    const row = await prompts.getActive(pool, 'world', key, 'music');
    assert.deepEqual([row.style, row.text, row.via, row.source_input], ['village', 'exported lute', 'box', 'ctx']);

    await seed.seedAudio({ db: pool, root });
    const n = await pool.query('SELECT count(*)::int n FROM audio_prompts WHERE subject_key = $1', [key]);
    assert.equal(n.rows[0].n, 1, 're-seeding an unchanged prompt adds no history');
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `node --test tests/audio_seed_prompts_db.test.js`
Expected: FAIL, `prompts.json` missing (ENOENT).

- [ ] **Step 3: Implement**

In `exportAudio`, just before the final `writeFileSync` calls:
```js
  // Spec 2026-09-30 §4: prompts travel with the audio. ALWAYS the full active
  // set -- a kind/only-filtered prompts.json would overwrite the other kinds'
  // prompts, the merge-by-kind trap slice 2 already hit with bindings.json.
  const promptRows = (await audioPrompts.listAllActive(db)).map((p) => ({
    subject_kind: p.subject_kind, subject_key: p.subject_key, slot: p.slot, style: p.style, text: p.text,
    source_input: p.source_input, hint: p.hint, model: p.model, via: p.via,
  }));
  fs.writeFileSync(path.join(root, 'prompts.json'), `${JSON.stringify(promptRows, null, 2)}\n`);
```
In `seedAudio`, after the bindings are applied:
```js
  // Idempotent: only a missing or different (style, text) becomes a new
  // version, so re-running a seed never piles up history rows.
  const promptsPath = path.join(root, 'prompts.json');
  for (const p of readManifest(promptsPath)) {
    // eslint-disable-next-line no-await-in-loop
    const cur = await audioPrompts.getActive(db, p.subject_kind, p.subject_key, p.slot);
    if (cur && cur.text === p.text && (cur.style || null) === (p.style || null)) continue;
    // eslint-disable-next-line no-await-in-loop
    await audioPrompts.save(db, p.subject_kind, p.subject_key, p.slot, {
      style: p.style, text: p.text, sourceInput: p.source_input, hint: p.hint, model: p.model, via: p.via,
    });
  }
```
Add `const audioPrompts = require('./audioPrompts');` at the top. Use the real names of the `db`/`root` variables in each function.

- [ ] **Step 4: Run it and the existing seed test**

Run: `node --test --test-concurrency=1 tests/audio_seed_prompts_db.test.js tests/audio_seed_db.test.js`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/audioSeed.js backend/tests/audio_seed_prompts_db.test.js
git commit -m "feat(audio): audio-export/seed carry prompts.json (full set, idempotent seed)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Slot table — Prompt column and filter

**Files:**
- Modify: `frontend/src/games/something2/audioSelection.js` (`audioSlotRows`, filters)
- Modify: `frontend/src/games/something2/AudioSlotTable.jsx` (filter select ~236-242, header ~332, row cells ~370-380)
- Test: `frontend/src/games/something2/__tests__/audioPromptSelection.test.js`

**Interfaces:**
- Consumes: `promptStates` from `/admin/subjects` (Task 8).
- Produces: every row gets `prompt: 'none' | 'written' | 'stale' | 'cleared'`; `PROMPT_FILTERS = ['all', 'none', 'written', 'stale']`; the filters object gains `prompt` (URL param `prompt`, default `'all'`).

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/games/something2/__tests__/audioPromptSelection.test.js
import { describe, it, expect } from 'vitest';
import {
  audioSlotRows, applyFilters, filtersFromParams, paramsFromFilters, PROMPT_FILTERS,
} from '../audioSelection.js';

const subjects = [{
  kind: 'world', label: 'Worlds', slots: { music: 'music', ambience: 'ambience' }, subjects: ['Vale'],
  filledSlots: {}, promptStates: { Vale: { music: 'stale' } },
}, {
  kind: 'creature', label: 'Creatures', slots: { hurt: 'sfx' }, subjects: ['Wolf', 'Bat'],
  filledSlots: {}, promptStates: { Wolf: { hurt: 'written' }, Bat: { hurt: 'cleared' } },
}];

describe('prompt state on slot rows', () => {
  const rows = audioSlotRows(subjects);
  it('maps promptStates, defaulting to none', () => {
    expect(rows.map((r) => [r.id, r.prompt])).toEqual([
      ['world/Vale/music', 'stale'], ['world/Vale/ambience', 'none'],
      ['creature/Wolf/hurt', 'written'], ['creature/Bat/hurt', 'cleared'],
    ]);
  });
  it('filters: none includes cleared (both mean "no prompt will be used")', () => {
    const f = (prompt) => applyFilters(rows, { sound: 'all', prompt }).map((r) => r.id);
    expect(f('none')).toEqual(['world/Vale/ambience', 'creature/Bat/hurt']);
    expect(f('written')).toEqual(['creature/Wolf/hurt']);
    expect(f('stale')).toEqual(['world/Vale/music']);
    expect(f('all')).toHaveLength(4);
  });
  it('round-trips the prompt filter through the URL and drops unknown values', () => {
    expect(PROMPT_FILTERS).toEqual(['all', 'none', 'written', 'stale']);
    const p = paramsFromFilters({ kind: 'all', sound: 'missing', search: '', prompt: 'stale' });
    expect(p.get('prompt')).toBe('stale');
    expect(filtersFromParams(p).prompt).toBe('stale');
    expect(filtersFromParams(new URLSearchParams('prompt=bogus')).prompt).toBe('all');
    expect(paramsFromFilters({ kind: 'all', sound: 'missing', search: '', prompt: 'all' }).has('prompt')).toBe(false);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/audioPromptSelection.test.js`
Expected: FAIL (`PROMPT_FILTERS` undefined).

- [ ] **Step 3: Implement `audioSelection.js`**

In `audioSlotRows`, add `const prompts = group.promptStates || {};` next to `filled`, and to the pushed row:
```js
          prompt: (prompts[key] && prompts[key][slot]) || 'none',
```
Filters:
```js
export const PROMPT_FILTERS = Object.freeze(['all', 'none', 'written', 'stale']);
const DEFAULT_FILTERS = Object.freeze({ kind: 'all', sound: 'missing', search: '', prompt: 'all' });
```
`filtersFromParams` adds:
```js
  const prompt = params.get('prompt');
  // ...in the returned object:
    prompt: PROMPT_FILTERS.includes(prompt) ? prompt : DEFAULT_FILTERS.prompt,
```
`paramsFromFilters({ kind, sound, search, prompt })` adds `if (prompt && prompt !== DEFAULT_FILTERS.prompt) p.set('prompt', prompt);`.
`applyFilters(rows, { kind = 'all', sound = 'all', search = '', prompt = 'all' } = {})` adds:
```js
    // 'cleared' counts as none: in both cases generation uses no stored prompt.
    if (prompt === 'none' && !(r.prompt === 'none' || r.prompt === 'cleared')) return false;
    if ((prompt === 'written' || prompt === 'stale') && r.prompt !== prompt) return false;
```

- [ ] **Step 4: Wire the table**

In `AudioSlotTable.jsx`:
- `const { kind, sound, search, prompt } = filtersFromParams(searchParams);` Then pass `prompt` into `applyFilters(rows, { kind, sound, search, prompt })` and add it to that `useMemo` deps.
- Next to the sound `<select>`, add:
```jsx
          <select value={prompt} aria-label="Prompt filter" onChange={(e) => setFilter({ prompt: e.target.value })}>
            <option value="all">Any prompt</option>
            <option value="none">No prompt</option>
            <option value="written">Has prompt</option>
            <option value="stale">Stale prompt</option>
          </select>
```
- In the header, `<th>Sound</th>` becomes `<th>Sound</th><th>Prompt</th>`.
- In the row, after the Sound cell: `<td>{r.prompt === 'none' || r.prompt === 'cleared' ? '—' : r.prompt}</td>`.
- `setFilter` already merges through `pendingParams.current` (the same-tick clobber fix), so no change is needed there. Confirm that it spreads `filtersFromParams(...)`, which now includes `prompt`.

- [ ] **Step 5: Run the frontend tests**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/`
Expected: all pass, exit 0. Existing `audioSelection` tests that `toEqual` whole row objects need `prompt: 'none'` added to the expected rows, because rows gained a field on purpose.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/something2/audioSelection.js frontend/src/games/something2/AudioSlotTable.jsx frontend/src/games/something2/__tests__/
git commit -m "feat(audio): slot table Prompt column + prompt filter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Slot card prompt editor

**Files:**
- Modify: `frontend/src/games/something2/useAudioAdmin.js` (new hooks)
- Modify: `frontend/src/games/something2/AudioSlotCard.jsx` (prompt row for all kinds, Save, Write with model, provenance, stale badge)
- Create: `frontend/src/games/something2/audioPromptDraft.js`
- Test: `frontend/src/games/something2/__tests__/audioPromptDraft.test.js`

**Interfaces:**
- Consumes: `GET/PUT/POST /admin/prompts...` (Task 8); `draftText`, `isDirty` from `artDescriptionDraft.js`.
- Produces:
  - `usePrompts(kind, key)` → `{ prompts: { [slot]: {active, history, stale, currentInput} }, isLoadingPrompts }`
  - `useSavePrompt(kind, key)` → mutation `({ slot, style, text, expectActiveId })`
  - `useWritePrompt(kind, key, slot)` → mutation `({ hint })`, mutationKey `['audio-prompt-write', kind, key, slot]`
  - `provenanceText(active) → string`, `generatePromptFields({ isSfx, styleDraft, textDraft, active })` in `audioPromptDraft.js`

On Generate, the card sends the **typed** values only when they differ from the stored ones. When they match the stored prompt it sends nothing, so the server's stored-prompt path is the one exercised and a stale-vs-fresh mismatch can't happen.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/games/something2/__tests__/audioPromptDraft.test.js
import { describe, it, expect } from 'vitest';
import { provenanceText, generatePromptFields } from '../audioPromptDraft.js';

describe('provenanceText', () => {
  it('names model and route, or a person', () => {
    expect(provenanceText({ model: 'qwen', via: 'box' })).toBe('written by qwen (GPU box)');
    expect(provenanceText({ model: 'qwen2.5-coder:7b', via: 'fallback' })).toBe('written by qwen2.5-coder:7b (CPU fallback)');
    expect(provenanceText({ model: null, via: null, text: 'x' })).toBe('edited by hand');
    expect(provenanceText({ model: null, via: null, text: '' })).toBe('cleared by hand — generation ignores it');
    expect(provenanceText(null)).toBe('no stored prompt');
  });
});

describe('generatePromptFields', () => {
  const active = { style: 'village', text: 'stored lute' };
  it('unchanged draft sends nothing: the server uses the stored prompt', () => {
    expect(generatePromptFields({ isSfx: false, styleDraft: null, textDraft: null, active })).toEqual({});
    expect(generatePromptFields({ isSfx: false, styleDraft: 'village', textDraft: 'stored lute', active })).toEqual({});
  });
  it('edited but unsaved draft is sent explicitly', () => {
    expect(generatePromptFields({ isSfx: false, styleDraft: 'tavern', textDraft: null, active }))
      .toEqual({ style: 'tavern', prompt: 'stored lute' });
  });
  it('sfx never sends style/prompt (entity comes from the stored prompt server-side)', () => {
    expect(generatePromptFields({ isSfx: true, styleDraft: null, textDraft: 'typed', active })).toEqual({});
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/audioPromptDraft.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `audioPromptDraft.js`**

```js
// Pure rules for the audio slot card's prompt editor (spec 2026-09-30 §9).
// Draft semantics are artDescriptionDraft.js's: null = nobody typed, '' =
// cleared on purpose.
import { draftText } from './artDescriptionDraft.js';

export function provenanceText(active) {
  if (!active) return 'no stored prompt';
  if (active.model) return `written by ${active.model} (${active.via === 'fallback' ? 'CPU fallback' : 'GPU box'})`;
  return active.text ? 'edited by hand' : 'cleared by hand — generation ignores it';
}

// What Generate sends for style/prompt. Nothing when the fields show the
// stored prompt -- the server reads it itself (one source of truth). An
// SFX slot never sends them: its stored text travels as the box's `entity`,
// resolved server-side. An UNSAVED sfx edit must be saved first; the card
// disables Generate while an sfx draft is dirty.
export function generatePromptFields({ isSfx, styleDraft, textDraft, active }) {
  if (isSfx) return {};
  const style = draftText(styleDraft, active ? { text: active.style || '' } : null);
  const text = draftText(textDraft, active);
  if (active && style === (active.style || '') && text === (active.text || '')) return {};
  if (!active && !style && !text) return {};
  return { style: style || undefined, prompt: text || undefined };
}
```

- [ ] **Step 4: Run the draft test**

Run: `cd frontend && npx vitest run src/games/something2/__tests__/audioPromptDraft.test.js`
Expected: PASS.

- [ ] **Step 5: Add the hooks to `useAudioAdmin.js`**

```js
const promptsKey = (kind, key) => ['audio-prompts', kind, key];

export function usePrompts(kind, key) {
  const { data, isLoading } = useQuery({
    queryKey: promptsKey(kind, key),
    enabled: Boolean(kind && key),
    queryFn: () => getJson(
      `${API_URL}/api/audio/admin/prompts/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,
      `${kind}/${key}'s prompts`,
    ),
  });
  return { prompts: data || {}, isLoadingPrompts: isLoading };
}

// Both mutations refresh the subject's prompts and the table's prompt column
// (SUBJECTS_KEY carries promptStates).
function usePromptInvalidation(kind, key) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: promptsKey(kind, key) });
    qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
  };
}

export function useSavePrompt(kind, key) {
  const invalidate = usePromptInvalidation(kind, key);
  return useMutation({
    mutationFn: async ({ slot, style, text, expectActiveId }) => {
      const res = await apiFetch(
        `${API_URL}/api/audio/admin/prompts/${encodeURIComponent(kind)}/${encodeURIComponent(key)}/${encodeURIComponent(slot)}`,
        { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ style, text, expect_active_id: expectActiveId ?? null }) },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to save the prompt');
      return json;
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(err.message),
  });
}

export function writePromptMutationKey(kind, key, slot) {
  return ['audio-prompt-write', kind, key, slot];
}

export function useWritePrompt(kind, key, slot) {
  const invalidate = usePromptInvalidation(kind, key);
  return useMutation({
    mutationKey: writePromptMutationKey(kind, key, slot),
    mutationFn: async ({ hint }) => {
      const { res, json } = await post(
        `/api/audio/admin/prompts/${encodeURIComponent(kind)}/${encodeURIComponent(key)}/${encodeURIComponent(slot)}/write`, { hint });
      if (!res.ok) throw new Error(`${json.error || 'Failed to write the prompt'}${json.via ? ` (${json.via})` : ''}`);
      return json;
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(err.message),
  });
}
```

- [ ] **Step 6: Wire `AudioSlotCard.jsx`**

The parent that renders the cards (`AudioAdmin.jsx`/`AudioSlotTable.jsx`, `grep -n "<AudioSlotCard" frontend/src`) calls `usePrompts(subject.kind, subject.key)` once and passes `prompt={prompts[slot]}` to each card, so there's one request per subject rather than one per card.

In the card:
```jsx
import { useIsMutating } from '@tanstack/react-query';
import { draftText, isDirty } from './artDescriptionDraft.js';
import { provenanceText, generatePromptFields } from './audioPromptDraft.js';
import { useSavePrompt, useWritePrompt, writePromptMutationKey } from './useAudioAdmin.js';
// props gain: prompt (the slot's { active, stale, currentInput } or undefined)

  const active = prompt ? prompt.active : null;
  // null = nobody typed (show stored); '' = cleared. Replaces the old
  // useState('') style/prompt pair.
  const [styleDraft, setStyleDraft] = useState(null);
  const [textDraft, setTextDraft] = useState(null);
  const [hint, setHint] = useState('');
  const save = useSavePrompt(subject.kind, subject.key);
  const write = useWritePrompt(subject.kind, subject.key, slot);
  const writing = useIsMutating({ mutationKey: writePromptMutationKey(subject.kind, subject.key, slot) }) > 0;
  const styleShown = draftText(styleDraft, active ? { text: active.style || '' } : null);
  const textShown = draftText(textDraft, active);
  const dirty = isDirty(styleDraft, active ? { text: active.style || '' } : null) || isDirty(textDraft, active);
```
- `onSuggest`: set `setStyleDraft(r.style || '')` and `setTextDraft(r.prompt || '')`. That makes Suggest an unsaved draft.
- `onGenerate` (music/ambience): `generateBody({ subject, slot, ...generatePromptFields({ isSfx, styleDraft, textDraft, active }), proposal })`. Check `generateBody`'s destructuring: it takes `style`/`prompt`, which `generatePromptFields` returns.
- `onSave`: `save.mutate({ slot, style: isSfx ? null : styleShown, text: textShown, expectActiveId: active ? active.id : null }, { onSuccess: () => { setStyleDraft(null); setTextDraft(null); } })`.
- `onWrite`: `write.mutate({ hint }, { onSuccess: () => { setStyleDraft(null); setTextDraft(null); } })`.

Replace the `{!isSfx && (<PromptRow>...)}` block with a prompt row for every non-upload-only slot:
```jsx
      {!uploadOnly && (
        <>
          <PromptRow>
            {!isSfx && (
              <input value={styleShown} onChange={(e) => setStyleDraft(e.target.value)} placeholder="style" aria-label={`Style for ${slot}`} />
            )}
            <input
              value={textShown}
              onChange={(e) => setTextDraft(e.target.value)}
              placeholder={isSfx ? 'sound source, e.g. "a heavy iron mace"' : 'prompt'}
              aria-label={`${isSfx ? 'Sound source' : 'Prompt'} for ${slot}`}
            />
          </PromptRow>
          <Hint>
            {provenanceText(active)}
            {prompt && prompt.stale && (
              <Pill title={`Written from: ${active.source_input}\nNow: ${prompt.currentInput}`}> stale</Pill>
            )}
          </Hint>
          <Controls>
            <Secondary type="button" disabled={!dirty || save.isPending} onClick={onSave}>
              {save.isPending ? 'Saving…' : 'Save prompt'}
            </Secondary>
            <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="hint (optional)" aria-label={`Hint for ${slot}`} />
            <Secondary type="button" disabled={writing} onClick={onWrite}>
              {writing ? <>Writing… <Elapsed />s</> : 'Write with model'}
            </Secondary>
          </Controls>
        </>
      )}
```
If `Pill` is not defined in this file, add `const Pill = styled.span\`font-size: 0.75rem; color: var(--s2-warning, var(--s2-danger));\`;` using only existing `--s2-*` tokens (`grep -n "\-\-s2-warn" frontend/src` to pick a real one). Show `{write.isError && <Err>{write.error.message}</Err>}` and `{save.isError && <Err>{save.error.message}</Err>}` next to the existing errors. For SFX, disable Generate while `dirty` and set `title="Save the prompt first — SFX use the saved prompt"`.

- [ ] **Step 7: Run all frontend tests and the build**

Run: `cd frontend && npx vitest run && npx vite build --logLevel error`
Expected: tests pass, build exit 0.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/games/something2/audioPromptDraft.js frontend/src/games/something2/useAudioAdmin.js \
  frontend/src/games/something2/AudioSlotCard.jsx frontend/src/games/something2/AudioAdmin.jsx \
  frontend/src/games/something2/AudioSlotTable.jsx frontend/src/games/something2/__tests__/audioPromptDraft.test.js
git commit -m "feat(audio): slot card prompt editor -- stored prompt, save, write with model, stale badge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Full suites, browser check, canary (live)

**Files:** none new, except fixes found here (each with its own failing test first).

- [ ] **Step 1: Full backend suite on the scratch DB**

```bash
cd backend
export TEST_DATABASE_URL=$SCRATCH
export DATABASE_URL=$SCRATCH
npm test 2>&1 | tee /tmp/claude-1000/audio-prompts-suite.log; echo "exit ${PIPESTATUS[0]}"
grep -n "^not ok\|testTimeoutFailure" /tmp/claude-1000/audio-prompts-suite.log | head
```
Expected: exit 0 and no `not ok`. For any failure, run the same file on the base commit (`git stash` is forbidden; use a throwaway worktree of `main` against the same scratch DB) before calling it pre-existing.

- [ ] **Step 2: Full frontend suite**

Run: `cd frontend && npx vitest run; echo "exit $?"`
Expected: exit 0.

- [ ] **Step 3: Browser check against the worktree**

Serve the branch without touching the shared vite. Use the verification-vite recipe with `watch: null` and a separate port, pointed at a backend run from the worktree against the scratch DB. Log in as admin, then:
1. In AI Providers, create a Text provider for the Ollama fallback host, or point it at the box once Appendix A lands. Confirm the TEXT badge and that Refresh lists models.
2. On the Audio tab, confirm the Prompt column shows `—` and the "No prompt" filter lists every row.
3. Open a biome's card, click **Write with model**, and wait. The prompt and style fill in, and the provenance line reads `written by … (CPU fallback)`.
4. Edit the text, click **Save prompt**, reload. The edit persists and reads "edited by hand".
5. Open a creature `hurt` card. It has a "Sound source" field. Write it with the model.
6. Change that biome's `art_style` in the scratch DB, then reload. The stale badge shows, and the table filter "Stale prompt" lists the row.
Take a screenshot of each state.

- [ ] **Step 4: Live generation from a stored prompt (needs the audio box)**

On the scratch backend with the real audio provider, generate one biome ambience and one creature `hurt` SFX with the prompt fields left as stored. Check `audio_clips.prompt` for the new clips. The ambience clip's prompt must contain the stored text, and for the SFX, confirm in the backend log or a request capture that the entity was the stored text plus `(take N)`. **If the box ignores our `prompt` when a `style` is also sent**, stop and report. That is a box contract question, not something to paper over here.

- [ ] **Step 5: Canary (needs the user's go-ahead for the full run afterwards)**

```bash
docker compose exec -T backend sh -c 'DATABASE_URL=$SCRATCH node scripts/describe-audio-slots.js --kind creature --limit 20'
```
Run it once per kind: world, biome, creature, item, skill, attack_type and world_point, 20 each. Delete those rows (`DELETE FROM audio_prompts WHERE ...` **on the scratch DB only**) and run again. Report the duplicate counts per kind from both runs, and how many of the 20 matched between runs. Do **not** run the full ~2,300-slot batch on the dev DB. Report the numbers and let the user decide.

- [ ] **Step 6: Whole-branch review, then hand back**

Request the whole-branch review (superpowers:requesting-code-review), fix what it confirms, then use superpowers:finishing-a-development-branch. Don't push without the user asking.

---

## Appendix — box handoff

The box-side `/api/text` contract is Appendix A of the spec. Send it to the box session before Task 13 Step 3 if the browser check should run against the GPU. Tasks 1-12 need only the CPU fallback.
