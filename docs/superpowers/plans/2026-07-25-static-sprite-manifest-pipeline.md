# Static Sprite Manifest Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a committed JSON manifest plus a re-runnable `npm run sprites:gen` command that batch-generates static, 8-facing directional idle sprites (and flat scenery) for the game's heroes, creatures, and props via the existing backend admin API — generate-only, idempotent, with an approve report.

**Architecture:** A thin Node CLI (`backend/scripts/gen-sprites.js`) reads `sprites.manifest.json`, logs in as admin, and drives the existing `/api/sprite-jobs` (directional) and `/api/entity-jobs` (flat) routes — which create the `sprite_sets` rows the existing approve UI keys on, so no backend/client changes are needed. Logic lives in three injectable, unit-tested modules (`spriteManifest.js` pure helpers, `spriteRunnerClient.js` HTTP, `spriteRunner.js` orchestrator); the CLI is glue. A committed `sprites.manifest.lock.json` records per-entity fingerprints for idempotent reruns.

**Tech Stack:** Node 18+ (global `fetch`, `node:crypto`, `node:fs`), CommonJS, `node:test` + `node:assert` for tests (matching `backend/tests/`). No new dependencies.

## Global Constraints

- **CommonJS only** — `require`/`module.exports`, matching `backend/src` and `backend/scripts`. No ESM.
- **No new npm dependencies** — use global `fetch` (as `backend/src/services/spriteGen.js` already does), `node:crypto`, `node:fs`, `node:path`.
- **Generate-only** — the runner never writes to Postgres or MinIO directly. Approval stays a manual admin step. Its only side effect on disk is the lockfile.
- **Injectable seams for tests** — `fetch` is injected into the HTTP client; the client is injected into the orchestrator; `sleep` is injected into the poller. Tests never hit the network or sleep in real time.
- **Entity `name`** is the MinIO folder and the job subject: it must match `/^[A-Za-z0-9_-]{1,64}$/`.
- **Slice 1 = static single frame:** every job is sent with `frames: 1` (creatures → 8 facings × 1 idle; objects → 1 flat frame). No animation, no action dimension.
- **Backend default port** is `3101` (`backend/src/index.js:15`); the runner's `SOMETHING2_API_URL` defaults to `http://localhost:3101`.
- **Test runner:** `cd backend && node --test tests/<file>.test.js` for a single file; `npm test` runs all.

---

### Task 1: Manifest schema + pure helpers (`spriteManifest.js`)

Pure, dependency-light module: parse/validate the manifest, merge `defaults` into each entity, compute a stable fingerprint, select entities by `--only`, and read/write the lockfile. No network, no process, no console — fully unit-testable.

**Files:**
- Create: `backend/scripts/lib/spriteManifest.js`
- Test: `backend/tests/sprite_manifest.test.js`

**Interfaces:**
- Consumes: nothing (leaf module). Uses `node:crypto`, `node:fs`, `node:path`.
- Produces (relied on by Tasks 2–4):
  - `parseManifest(raw: object) -> { version:1, defaults:object, entities: RawEntity[] }` — validates, throws `Error` on bad input.
  - `loadManifest(filePath: string) -> Manifest` — reads + `JSON.parse` + `parseManifest`.
  - `resolveEntity(defaults: object, entity: RawEntity) -> ResolvedEntity` where `ResolvedEntity = { name, kind:'creature'|'object', prompt, seed:number, size:[w,h], backend:string|null, frames:1 }`.
  - `fingerprint(resolved: ResolvedEntity) -> string` (hex sha256 of `kind|prompt|seed|WxH`).
  - `selectEntities(manifest: Manifest, opts:{ only?: string[] }) -> RawEntity[]`.
  - `shouldSkip(resolved: ResolvedEntity, lock: object, force: boolean) -> boolean`.
  - `loadLock(filePath: string) -> object` (`{}` when the file is missing).
  - `saveLock(filePath: string, lock: object) -> void` (pretty JSON + trailing newline).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/sprite_manifest.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const m = require('../scripts/lib/spriteManifest.js');

const DEFAULTS = { backend: 'sd-turbo', size: [128, 160], seed: 0 };

test('parseManifest accepts a valid manifest', () => {
  const parsed = m.parseManifest({
    version: 1,
    defaults: DEFAULTS,
    entities: [{ name: 'Wolf', kind: 'creature', prompt: 'a wolf', seed: 101 }],
  });
  assert.equal(parsed.version, 1);
  assert.equal(parsed.entities.length, 1);
});

test('parseManifest rejects wrong version', () => {
  assert.throws(() => m.parseManifest({ version: 2, entities: [] }), /version/);
});

test('parseManifest rejects an empty entity list', () => {
  assert.throws(() => m.parseManifest({ version: 1, entities: [] }), /at least one/);
});

test('parseManifest rejects a bad kind', () => {
  assert.throws(() => m.parseManifest({
    version: 1, entities: [{ name: 'X', kind: 'tile', prompt: 'p', seed: 1 }],
  }), /kind/);
});

test('parseManifest rejects an unsafe name', () => {
  assert.throws(() => m.parseManifest({
    version: 1, entities: [{ name: '../evil', kind: 'object', prompt: 'p', seed: 1 }],
  }), /name/);
});

test('resolveEntity merges defaults and forces frames:1', () => {
  const r = m.resolveEntity(DEFAULTS, { name: 'Wolf', kind: 'creature', prompt: 'a wolf', seed: 101 });
  assert.deepEqual(r, {
    name: 'Wolf', kind: 'creature', prompt: 'a wolf', seed: 101,
    size: [128, 160], backend: 'sd-turbo', frames: 1,
  });
});

test('fingerprint is stable and sensitive to prompt/seed', () => {
  const a = m.resolveEntity(DEFAULTS, { name: 'Wolf', kind: 'creature', prompt: 'a wolf', seed: 101 });
  const b = m.resolveEntity(DEFAULTS, { name: 'Wolf', kind: 'creature', prompt: 'a wolf', seed: 101 });
  const c = m.resolveEntity(DEFAULTS, { name: 'Wolf', kind: 'creature', prompt: 'a grey wolf', seed: 101 });
  assert.equal(m.fingerprint(a), m.fingerprint(b));
  assert.notEqual(m.fingerprint(a), m.fingerprint(c));
});

test('shouldSkip is true only on an unchanged fingerprint without --force', () => {
  const r = m.resolveEntity(DEFAULTS, { name: 'Wolf', kind: 'creature', prompt: 'a wolf', seed: 101 });
  const lock = { Wolf: { fingerprint: m.fingerprint(r) } };
  assert.equal(m.shouldSkip(r, lock, false), true);
  assert.equal(m.shouldSkip(r, lock, true), false);
  assert.equal(m.shouldSkip(r, {}, false), false);
});

test('selectEntities filters by --only', () => {
  const manifest = m.parseManifest({
    version: 1, defaults: DEFAULTS, entities: [
      { name: 'Wolf', kind: 'creature', prompt: 'a wolf', seed: 101 },
      { name: 'Tree', kind: 'object', prompt: 'a tree', seed: 301 },
    ],
  });
  assert.deepEqual(m.selectEntities(manifest, { only: ['Tree'] }).map((e) => e.name), ['Tree']);
  assert.deepEqual(m.selectEntities(manifest, {}).map((e) => e.name), ['Wolf', 'Tree']);
});

test('loadLock returns {} when the file is missing; saveLock round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-lock-'));
  const p = path.join(dir, 'lock.json');
  assert.deepEqual(m.loadLock(p), {});
  m.saveLock(p, { Wolf: { fingerprint: 'abc' } });
  assert.deepEqual(m.loadLock(p), { Wolf: { fingerprint: 'abc' } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/sprite_manifest.test.js`
Expected: FAIL — `Cannot find module '../scripts/lib/spriteManifest.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/scripts/lib/spriteManifest.js`:

```js
const crypto = require('node:crypto');
const fs = require('node:fs');

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KINDS = new Set(['creature', 'object']);
const MIN_DIM = 8;
const MAX_DIM = 512;

function _requireString(v, field) {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`entity ${field} must be a non-empty string`);
  return v;
}

function _validateSize(size) {
  if (!Array.isArray(size) || size.length !== 2) throw new Error('size must be a [width, height] pair');
  for (const dim of size) {
    if (!Number.isInteger(dim) || dim < MIN_DIM || dim > MAX_DIM) {
      throw new Error(`size dimensions must be integers in [${MIN_DIM}, ${MAX_DIM}] (got ${dim})`);
    }
  }
  return size;
}

function parseManifest(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('manifest must be an object');
  if (raw.version !== 1) throw new Error(`unsupported manifest version (expected 1, got ${raw.version})`);
  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
  if (defaults.size !== undefined) _validateSize(defaults.size);
  if (!Array.isArray(raw.entities) || raw.entities.length === 0) {
    throw new Error('manifest must list at least one entity');
  }
  const seen = new Set();
  for (const e of raw.entities) {
    if (!e || typeof e !== 'object') throw new Error('each entity must be an object');
    if (typeof e.name !== 'string' || !NAME_RE.test(e.name)) {
      throw new Error(`entity name must match ${NAME_RE} (got ${JSON.stringify(e.name)})`);
    }
    if (seen.has(e.name)) throw new Error(`duplicate entity name '${e.name}'`);
    seen.add(e.name);
    if (!KINDS.has(e.kind)) throw new Error(`entity '${e.name}' kind must be 'creature' or 'object'`);
    _requireString(e.prompt, 'prompt');
    if (e.seed !== undefined && !Number.isInteger(e.seed)) throw new Error(`entity '${e.name}' seed must be an integer`);
    if (e.size !== undefined) _validateSize(e.size);
  }
  return { version: 1, defaults, entities: raw.entities };
}

function loadManifest(filePath) {
  return parseManifest(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function resolveEntity(defaults, entity) {
  const size = entity.size || defaults.size || [128, 160];
  const backend = entity.backend !== undefined ? entity.backend : (defaults.backend ?? null);
  const seed = entity.seed !== undefined ? entity.seed : (defaults.seed ?? 0);
  return {
    name: entity.name,
    kind: entity.kind,
    prompt: entity.prompt,
    seed,
    size: [size[0], size[1]],
    backend,
    frames: 1,
  };
}

function fingerprint(resolved) {
  const str = `${resolved.kind}|${resolved.prompt}|${resolved.seed}|${resolved.size[0]}x${resolved.size[1]}`;
  return crypto.createHash('sha256').update(str).digest('hex');
}

function selectEntities(manifest, opts = {}) {
  if (!opts.only || opts.only.length === 0) return manifest.entities;
  const wanted = new Set(opts.only);
  return manifest.entities.filter((e) => wanted.has(e.name));
}

function shouldSkip(resolved, lock, force) {
  if (force) return false;
  const entry = lock[resolved.name];
  return Boolean(entry && entry.fingerprint === fingerprint(resolved));
}

function loadLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function saveLock(filePath, lock) {
  fs.writeFileSync(filePath, `${JSON.stringify(lock, null, 2)}\n`);
}

module.exports = {
  parseManifest, loadManifest, resolveEntity, fingerprint,
  selectEntities, shouldSkip, loadLock, saveLock,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/sprite_manifest.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/lib/spriteManifest.js backend/tests/sprite_manifest.test.js
git commit -m "feat(sprites): manifest parse/validate/fingerprint/lock helpers"
```

---

### Task 2: HTTP client (`spriteRunnerClient.js`)

A thin wrapper over the backend admin API with `fetch` injected so tests use a fake. Covers login, entity-type listing, job start (route chosen by `kind`), and polling to completion.

**Files:**
- Create: `backend/scripts/lib/spriteRunnerClient.js`
- Test: `backend/tests/sprite_runner_client.test.js`

**Interfaces:**
- Consumes: injected `fetch` (defaults to global `fetch`).
- Produces (relied on by Tasks 3–4):
  - `createClient({ baseUrl, fetch?, sleep? }) -> Client`.
  - `Client.login(username, password) -> Promise<string>` (token).
  - `Client.listEntityTypes(token) -> Promise<Array<{id:number, name:string}>>`.
  - `Client.startJob(token, { kind, name, prompt, seed, frames, backend }) -> Promise<{ jobId:string, route:'sprite-jobs'|'entity-jobs' }>`.
  - `Client.pollJob(token, route, jobId, { intervalMs?, timeoutMs? }) -> Promise<{ status:'done'|'error', result?:object, error?:string }>`.

Notes on contract: `startJob` sends body `{ entity_type: name, base_prompt: prompt, seed, frames, backend }` (matching `startGenerationJob` in `backend/src/index.js:892`); `route` is `sprite-jobs` for `kind==='creature'`, `entity-jobs` for `kind==='object'`. `pollJob` GETs `/api/<route>/<jobId>` until `status` is `done` or `error`, throwing on timeout. The job body from sprite-gen carries `result = { atlas_key, manifest_key, frame_keys }` on success (`sprite-gen/app/storage.py:33`).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/sprite_runner_client.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createClient } = require('../scripts/lib/spriteRunnerClient.js');

// A scripted fake fetch: each call shifts the next handler off the queue and
// asserts the request, then returns a Response-like object.
function fakeFetch(handlers) {
  const queue = [...handlers];
  return async (url, init) => {
    const h = queue.shift();
    if (!h) throw new Error(`unexpected fetch to ${url}`);
    return h(url, init || {});
  };
}
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('login posts credentials and returns the token', async () => {
  const fetch = fakeFetch([
    (url, init) => {
      assert.equal(url, 'http://api/api/auth/login');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { username: 'admin', password: 'pw' });
      return jsonResponse(200, { token: 'TKN', user: { role: 'admin' } });
    },
  ]);
  const c = createClient({ baseUrl: 'http://api', fetch });
  assert.equal(await c.login('admin', 'pw'), 'TKN');
});

test('login throws on non-2xx', async () => {
  const fetch = fakeFetch([() => jsonResponse(401, { error: 'bad creds' })]);
  const c = createClient({ baseUrl: 'http://api', fetch });
  await assert.rejects(() => c.login('admin', 'pw'), /login.*401/);
});

test('startJob routes creature to sprite-jobs with the right body', async () => {
  const fetch = fakeFetch([
    (url, init) => {
      assert.equal(url, 'http://api/api/sprite-jobs');
      assert.equal(init.headers.Authorization, 'Bearer TKN');
      assert.deepEqual(JSON.parse(init.body),
        { entity_type: 'Wolf', base_prompt: 'a wolf', seed: 101, frames: 1, backend: 'sd-turbo' });
      return jsonResponse(201, { job_id: 'abc123', recipe: {} });
    },
  ]);
  const c = createClient({ baseUrl: 'http://api', fetch });
  const r = await c.startJob('TKN',
    { kind: 'creature', name: 'Wolf', prompt: 'a wolf', seed: 101, frames: 1, backend: 'sd-turbo' });
  assert.deepEqual(r, { jobId: 'abc123', route: 'sprite-jobs' });
});

test('startJob routes object to entity-jobs', async () => {
  const fetch = fakeFetch([
    (url) => { assert.equal(url, 'http://api/api/entity-jobs'); return jsonResponse(201, { job_id: 'obj9' }); },
  ]);
  const c = createClient({ baseUrl: 'http://api', fetch });
  const r = await c.startJob('TKN',
    { kind: 'object', name: 'Tree', prompt: 'a tree', seed: 301, frames: 1, backend: null });
  assert.equal(r.route, 'entity-jobs');
  assert.equal(r.jobId, 'obj9');
});

test('pollJob returns on done and passes through the result', async () => {
  const fetch = fakeFetch([
    () => jsonResponse(200, { status: 'running', result: null }),
    () => jsonResponse(200, { status: 'done', result: { atlas_key: 'sprites/Wolf/atlas.png' } }),
  ]);
  const c = createClient({ baseUrl: 'http://api', fetch, sleep: async () => {} });
  const out = await c.pollJob('TKN', 'sprite-jobs', 'abc123', { intervalMs: 1, timeoutMs: 10000 });
  assert.equal(out.status, 'done');
  assert.equal(out.result.atlas_key, 'sprites/Wolf/atlas.png');
});

test('pollJob returns on error status', async () => {
  const fetch = fakeFetch([() => jsonResponse(200, { status: 'error', error: 'backend blew up' })]);
  const c = createClient({ baseUrl: 'http://api', fetch, sleep: async () => {} });
  const out = await c.pollJob('TKN', 'sprite-jobs', 'abc123', { intervalMs: 1, timeoutMs: 10000 });
  assert.equal(out.status, 'error');
  assert.equal(out.error, 'backend blew up');
});

test('pollJob throws on timeout', async () => {
  const fetch = fakeFetch(Array.from({ length: 50 }, () => () => jsonResponse(200, { status: 'running' })));
  let clock = 0;
  const c = createClient({ baseUrl: 'http://api', fetch, sleep: async (ms) => { clock += ms; }, now: () => clock });
  await assert.rejects(
    () => c.pollJob('TKN', 'sprite-jobs', 'abc123', { intervalMs: 100, timeoutMs: 300 }),
    /timed out/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/sprite_runner_client.test.js`
Expected: FAIL — `Cannot find module '../scripts/lib/spriteRunnerClient.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/scripts/lib/spriteRunnerClient.js`:

```js
const ROUTE_FOR_KIND = { creature: 'sprite-jobs', object: 'entity-jobs' };

function createClient({ baseUrl, fetch = globalThis.fetch, sleep = defaultSleep, now = Date.now }) {
  const url = (p) => `${baseUrl}${p}`;

  async function login(username, password) {
    const res = await fetch(url('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`login failed (${res.status})`);
    const body = await res.json();
    return body.token;
  }

  async function listEntityTypes(token) {
    const res = await fetch(url('/api/entity-types'), { headers: auth(token) });
    if (!res.ok) throw new Error(`listEntityTypes failed (${res.status})`);
    return res.json();
  }

  async function startJob(token, { kind, name, prompt, seed, frames, backend }) {
    const route = ROUTE_FOR_KIND[kind];
    if (!route) throw new Error(`unsupported kind '${kind}'`);
    const res = await fetch(url(`/api/${route}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(token) },
      body: JSON.stringify({ entity_type: name, base_prompt: prompt, seed, frames, backend }),
    });
    if (!res.ok) throw new Error(`startJob(${name}) failed (${res.status})`);
    const body = await res.json();
    return { jobId: body.job_id, route };
  }

  async function pollJob(token, route, jobId, { intervalMs = 5000, timeoutMs = 30 * 60 * 1000 } = {}) {
    const start = now();
    for (;;) {
      const res = await fetch(url(`/api/${route}/${jobId}`), { headers: auth(token) });
      if (!res.ok) throw new Error(`pollJob(${jobId}) failed (${res.status})`);
      const job = await res.json();
      if (job.status === 'done' || job.status === 'error') return job;
      if (now() - start > timeoutMs) throw new Error(`pollJob(${jobId}) timed out after ${timeoutMs}ms`);
      await sleep(intervalMs);
    }
  }

  return { login, listEntityTypes, startJob, pollJob };
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createClient };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/sprite_runner_client.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/lib/spriteRunnerClient.js backend/tests/sprite_runner_client.test.js
git commit -m "feat(sprites): admin-API client for the sprite batch runner"
```

---

### Task 3: Orchestrator (`spriteRunner.js`)

Pure orchestration over an injected client: for each selected entity decide skip / dry-run / generate, poll, update the lock, and build a structured report. No fs, argv, or console — the CLI (Task 4) supplies those.

**Files:**
- Create: `backend/scripts/lib/spriteRunner.js`
- Test: `backend/tests/sprite_runner.test.js`

**Interfaces:**
- Consumes: `resolveEntity`, `fingerprint`, `shouldSkip` from `spriteManifest.js` (Task 1); a `Client` shape from `spriteRunnerClient.js` (Task 2) — but only `startJob` and `pollJob` are called here (an object with those two methods is enough, so tests pass a fake).
- Produces (relied on by Task 4):
  - `runGeneration({ entities, defaults, lock, client, token, nameToId, force, dryRun }) -> Promise<{ report: ReportRow[], lock: object }>`.
  - `ReportRow = { name, kind, status:'generated'|'skipped'|'planned'|'failed', atlasKey?, manifestKey?, jobId?, entityTypeId?|null, error? }`.
  - The returned `lock` is a new object (input not mutated); generated entities get `{ fingerprint, atlas_key, job_id }`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/sprite_runner.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { runGeneration } = require('../scripts/lib/spriteRunner.js');
const { fingerprint, resolveEntity } = require('../scripts/lib/spriteManifest.js');

const DEFAULTS = { backend: 'sd-turbo', size: [128, 160], seed: 0 };
const WOLF = { name: 'Wolf', kind: 'creature', prompt: 'a wolf', seed: 101 };
const TREE = { name: 'Tree', kind: 'object', prompt: 'a tree', seed: 301 };

function fakeClient(script) {
  return {
    calls: [],
    async startJob(token, spec) {
      this.calls.push(spec.name);
      const s = script[spec.name];
      if (s.startThrows) throw new Error('start failed');
      return { jobId: `${spec.name}-job`, route: spec.kind === 'creature' ? 'sprite-jobs' : 'entity-jobs' };
    },
    async pollJob(token, route, jobId) {
      return script[jobId.replace('-job', '')].poll;
    },
  };
}

test('generates a fresh entity and records it in the lock + report', async () => {
  const client = fakeClient({ Wolf: { poll: { status: 'done', result: { atlas_key: 'sprites/Wolf/atlas.png', manifest_key: 'sprites/Wolf/atlas.json' } } } });
  const { report, lock } = await runGeneration({
    entities: [WOLF], defaults: DEFAULTS, lock: {}, client, token: 'T',
    nameToId: { Wolf: 7 }, force: false, dryRun: false,
  });
  assert.equal(report[0].status, 'generated');
  assert.equal(report[0].atlasKey, 'sprites/Wolf/atlas.png');
  assert.equal(report[0].entityTypeId, 7);
  assert.equal(lock.Wolf.fingerprint, fingerprint(resolveEntity(DEFAULTS, WOLF)));
  assert.equal(lock.Wolf.atlas_key, 'sprites/Wolf/atlas.png');
});

test('skips an entity whose fingerprint is unchanged', async () => {
  const preLock = { Wolf: { fingerprint: fingerprint(resolveEntity(DEFAULTS, WOLF)) } };
  const client = fakeClient({});
  const { report } = await runGeneration({
    entities: [WOLF], defaults: DEFAULTS, lock: preLock, client, token: 'T',
    nameToId: {}, force: false, dryRun: false,
  });
  assert.equal(report[0].status, 'skipped');
  assert.deepEqual(client.calls, []);
});

test('--force regenerates even when unchanged', async () => {
  const preLock = { Wolf: { fingerprint: fingerprint(resolveEntity(DEFAULTS, WOLF)) } };
  const client = fakeClient({ Wolf: { poll: { status: 'done', result: { atlas_key: 'k', manifest_key: 'm' } } } });
  const { report } = await runGeneration({
    entities: [WOLF], defaults: DEFAULTS, lock: preLock, client, token: 'T',
    nameToId: { Wolf: 7 }, force: true, dryRun: false,
  });
  assert.equal(report[0].status, 'generated');
  assert.deepEqual(client.calls, ['Wolf']);
});

test('--dry-run plans without calling the client', async () => {
  const client = fakeClient({});
  const { report, lock } = await runGeneration({
    entities: [WOLF, TREE], defaults: DEFAULTS, lock: {}, client, token: 'T',
    nameToId: { Wolf: 7 }, force: false, dryRun: true,
  });
  assert.deepEqual(report.map((r) => r.status), ['planned', 'planned']);
  assert.deepEqual(client.calls, []);
  assert.deepEqual(lock, {});
});

test('a job error is reported and does not update the lock', async () => {
  const client = fakeClient({ Wolf: { poll: { status: 'error', error: 'boom' } } });
  const { report, lock } = await runGeneration({
    entities: [WOLF], defaults: DEFAULTS, lock: {}, client, token: 'T',
    nameToId: { Wolf: 7 }, force: false, dryRun: false,
  });
  assert.equal(report[0].status, 'failed');
  assert.equal(report[0].error, 'boom');
  assert.deepEqual(lock, {});
});

test('entityTypeId is null for names with no matching row (heroes)', async () => {
  const hero = { name: 'hero_knight', kind: 'creature', prompt: 'a knight', seed: 201 };
  const client = fakeClient({ hero_knight: { poll: { status: 'done', result: { atlas_key: 'k', manifest_key: 'm' } } } });
  const { report } = await runGeneration({
    entities: [hero], defaults: DEFAULTS, lock: {}, client, token: 'T',
    nameToId: {}, force: false, dryRun: false,
  });
  assert.equal(report[0].entityTypeId, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test tests/sprite_runner.test.js`
Expected: FAIL — `Cannot find module '../scripts/lib/spriteRunner.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/scripts/lib/spriteRunner.js`:

```js
const { resolveEntity, fingerprint, shouldSkip } = require('./spriteManifest.js');

async function runGeneration({ entities, defaults, lock, client, token, nameToId, force, dryRun, poll = {} }) {
  const report = [];
  const nextLock = { ...lock };

  for (const raw of entities) {
    const resolved = resolveEntity(defaults, raw);
    const entityTypeId = Object.prototype.hasOwnProperty.call(nameToId, resolved.name)
      ? nameToId[resolved.name] : null;
    const base = { name: resolved.name, kind: resolved.kind, entityTypeId };

    if (shouldSkip(resolved, lock, force)) {
      report.push({ ...base, status: 'skipped' });
      continue;
    }
    if (dryRun) {
      report.push({ ...base, status: 'planned' });
      continue;
    }

    try {
      const { jobId, route } = await client.startJob(token, {
        kind: resolved.kind, name: resolved.name, prompt: resolved.prompt,
        seed: resolved.seed, frames: resolved.frames, backend: resolved.backend,
      });
      const job = await client.pollJob(token, route, jobId, poll);
      if (job.status === 'error') {
        report.push({ ...base, status: 'failed', jobId, error: job.error || 'unknown error' });
        continue;
      }
      const result = job.result || {};
      nextLock[resolved.name] = {
        fingerprint: fingerprint(resolved),
        atlas_key: result.atlas_key,
        job_id: jobId,
      };
      report.push({
        ...base, status: 'generated', jobId,
        atlasKey: result.atlas_key, manifestKey: result.manifest_key,
      });
    } catch (err) {
      report.push({ ...base, status: 'failed', error: err.message });
    }
  }

  return { report, lock: nextLock };
}

module.exports = { runGeneration };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test tests/sprite_runner.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/lib/spriteRunner.js backend/tests/sprite_runner.test.js
git commit -m "feat(sprites): batch orchestrator with skip/force/dry-run + report"
```

---

### Task 4: CLI glue, manifest content, and docs

Wire the modules into an executable command, ship the full-roster manifest, register the npm script, and document usage. The CLI is thin glue (fs/argv/env/console + real client); the tested logic lives in Tasks 1–3, so this task is verified by a manual `--dry-run` smoke run rather than new unit tests.

**Files:**
- Create: `backend/scripts/gen-sprites.js`
- Create: `sprites.manifest.json` (repo root)
- Create: `sprites.manifest.lock.json` (repo root, initial `{}`)
- Modify: `backend/package.json:7-13` (add `sprites:gen` script)
- Create: `sprite-gen/README-sprites-manifest.md` (usage + approve workflow)

**Interfaces:**
- Consumes: `loadManifest`, `selectEntities`, `loadLock`, `saveLock` (Task 1); `createClient` (Task 2); `runGeneration` (Task 3).
- Produces: an executable run via `npm run sprites:gen`. No exported API.

- [ ] **Step 1: Create the manifest** — `sprites.manifest.json` (repo root):

```json
{
  "version": 1,
  "defaults": { "backend": "sd-turbo", "size": [128, 160], "seed": 0 },
  "entities": [
    { "name": "Wolf", "kind": "creature", "seed": 101, "prompt": "a grey forest wolf, isometric game sprite, transparent background" },
    { "name": "Slime", "kind": "creature", "seed": 102, "prompt": "a translucent green slime blob, isometric game sprite, transparent background" },
    { "name": "Skeleton", "kind": "creature", "seed": 103, "prompt": "an undead skeleton warrior, isometric game sprite, transparent background" },
    { "name": "Bat", "kind": "creature", "seed": 104, "prompt": "a small brown cave bat, isometric game sprite, transparent background" },
    { "name": "Zombie", "kind": "creature", "seed": 105, "prompt": "a rotting green zombie, isometric game sprite, transparent background" },
    { "name": "Leech", "kind": "creature", "seed": 106, "prompt": "a fat dark-red leech, isometric game sprite, transparent background" },
    { "name": "VillageGuard", "kind": "creature", "seed": 107, "prompt": "a village guard in chainmail with a spear, isometric game sprite, transparent background" },
    { "name": "Boar", "kind": "creature", "seed": 108, "prompt": "a wild brown boar with tusks, isometric game sprite, transparent background" },
    { "name": "Rabbit", "kind": "creature", "seed": 109, "prompt": "a small grey rabbit, isometric game sprite, transparent background" },
    { "name": "Gargoyle", "kind": "creature", "seed": 110, "prompt": "a stone gargoyle with wings, isometric game sprite, transparent background" },
    { "name": "Fox", "kind": "creature", "seed": 111, "prompt": "a red fox, isometric game sprite, transparent background" },
    { "name": "Hornet", "kind": "creature", "seed": 112, "prompt": "a large yellow-and-black hornet, isometric game sprite, transparent background" },
    { "name": "hero_knight", "kind": "creature", "seed": 201, "prompt": "a human knight in plate armour with a sword, isometric game sprite, transparent background" },
    { "name": "hero_mage", "kind": "creature", "seed": 202, "prompt": "a human mage in a blue robe with a staff, isometric game sprite, transparent background" },
    { "name": "hero_ranger", "kind": "creature", "seed": 203, "prompt": "a human ranger in green leather with a bow, isometric game sprite, transparent background" },
    { "name": "hero_rogue", "kind": "creature", "seed": 204, "prompt": "a hooded human rogue with daggers, isometric game sprite, transparent background" },
    { "name": "hero_paladin", "kind": "creature", "seed": 205, "prompt": "a human paladin in golden armour with a warhammer, isometric game sprite, transparent background" },
    { "name": "hero_barbarian", "kind": "creature", "seed": 206, "prompt": "a muscular human barbarian with a greataxe, isometric game sprite, transparent background" },
    { "name": "hero_cleric", "kind": "creature", "seed": 207, "prompt": "a human cleric in white-and-gold robes with a mace, isometric game sprite, transparent background" },
    { "name": "hero_druid", "kind": "creature", "seed": 208, "prompt": "a human druid in brown robes with a wooden staff, isometric game sprite, transparent background" },
    { "name": "hero_warlock", "kind": "creature", "seed": 209, "prompt": "a human warlock in dark robes with glowing eyes, isometric game sprite, transparent background" },
    { "name": "hero_monk", "kind": "creature", "seed": 210, "prompt": "a human monk in simple orange robes, bare-handed, isometric game sprite, transparent background" },
    { "name": "Tree", "kind": "object", "seed": 301, "prompt": "a tall broadleaf tree with a thick trunk" },
    { "name": "Bush", "kind": "object", "seed": 302, "prompt": "a round leafy green bush" },
    { "name": "IceRock", "kind": "object", "seed": 303, "prompt": "a jagged pale blue ice boulder" },
    { "name": "Stone", "kind": "object", "seed": 304, "prompt": "a mossy grey boulder" },
    { "name": "Boulder", "kind": "object", "seed": 305, "prompt": "a large cracked granite boulder" }
  ]
}
```

- [ ] **Step 2: Create the initial lockfile** — `sprites.manifest.lock.json` (repo root):

```json
{}
```

- [ ] **Step 3: Add the npm script** — edit `backend/package.json` scripts block to add `sprites:gen`:

```json
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js --inspect",
    "migrate": "node-pg-migrate",
    "migrate:up": "node-pg-migrate up",
    "test": "node --test",
    "sprites:gen": "node scripts/gen-sprites.js"
  },
```

- [ ] **Step 4: Write the CLI** — `backend/scripts/gen-sprites.js`:

```js
#!/usr/bin/env node
const path = require('node:path');
const { loadManifest, selectEntities, loadLock, saveLock } = require('./lib/spriteManifest.js');
const { createClient } = require('./lib/spriteRunnerClient.js');
const { runGeneration } = require('./lib/spriteRunner.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const opts = { only: null, force: false, dryRun: false,
    manifest: path.join(REPO_ROOT, 'sprites.manifest.json'),
    lock: path.join(REPO_ROOT, 'sprites.manifest.lock.json') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--only') opts.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--manifest') opts.manifest = path.resolve(argv[++i]);
    else if (a === '--lock') opts.lock = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

function printReport(report) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${pad('ENTITY', 16)}${pad('KIND', 10)}${pad('STATUS', 12)}ATLAS / ERROR`);
  for (const r of report) {
    const tail = r.status === 'failed' ? (r.error || '') : (r.atlasKey || '');
    console.log(`${pad(r.name, 16)}${pad(r.kind, 10)}${pad(r.status, 12)}${tail}`);
  }
  const approvable = report.filter((r) => r.status === 'generated' && r.entityTypeId != null);
  if (approvable.length) {
    console.log('\nApprove these onto their entity types (admin token required):');
    for (const r of approvable) {
      const payload = JSON.stringify({
        atlas_key: r.atlasKey, manifest_key: r.manifestKey, job_id: r.jobId, animated: true, frames: 1,
      });
      console.log(`  curl -sS -X POST "$SOMETHING2_API_URL/api/entity-types/${r.entityTypeId}/sprite" \\`);
      console.log(`    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\`);
      console.log(`    -d '${payload}'`);
    }
  }
  const heroes = report.filter((r) => r.status === 'generated' && r.entityTypeId == null);
  if (heroes.length) {
    console.log(`\nGenerated (no entity_types row; awaiting the hero picker, Slice 3): ${heroes.map((r) => r.name).join(', ')}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.SOMETHING2_API_URL || 'http://localhost:3101';
  const manifest = loadManifest(opts.manifest);
  const lock = loadLock(opts.lock);
  const entities = selectEntities(manifest, { only: opts.only });
  if (entities.length === 0) throw new Error('no entities selected (check --only names)');

  const client = createClient({ baseUrl });
  let token = null;
  let nameToId = {};
  if (!opts.dryRun) {
    token = await client.login(requireEnv('SOMETHING2_ADMIN_USER'), requireEnv('SOMETHING2_ADMIN_PASSWORD'));
    const types = await client.listEntityTypes(token);
    nameToId = Object.fromEntries(types.map((t) => [t.name, t.id]));
  }

  console.log(`Running ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'} against ${baseUrl}${opts.dryRun ? ' (dry-run)' : ''}...`);
  const { report, lock: nextLock } = await runGeneration({
    entities, defaults: manifest.defaults, lock, client, token, nameToId,
    force: opts.force, dryRun: opts.dryRun,
    poll: { intervalMs: 5000, timeoutMs: 30 * 60 * 1000 },
  });
  if (!opts.dryRun) saveLock(opts.lock, nextLock);
  printReport(report);
  if (report.some((r) => r.status === 'failed')) process.exitCode = 1;
}

main().catch((err) => { console.error(`gen-sprites: ${err.message}`); process.exitCode = 1; });
```

- [ ] **Step 5: Write usage docs** — `sprite-gen/README-sprites-manifest.md`:

````markdown
# Batch sprite generation from a manifest (Sprites epic, Slice 1)

Generates static, 8-facing directional idle sprites (creatures/heroes) and flat
scenery from `sprites.manifest.json`, driving the existing backend admin API.
Generate-only: it produces + stores atlases in MinIO and prints an approve
report. It does **not** modify the DB.

## Prerequisites
- The full stack running (backend on `:3101`, sprite-gen, MinIO) — e.g. `docker compose up`.
- An admin user. Set:
  - `SOMETHING2_API_URL` (default `http://localhost:3101`)
  - `SOMETHING2_ADMIN_USER`, `SOMETHING2_ADMIN_PASSWORD`

## Run
```bash
cd backend
npm run sprites:gen -- --dry-run              # plan only, no generation
npm run sprites:gen                            # generate everything not already current
npm run sprites:gen -- --only Wolf,hero_knight # a subset
npm run sprites:gen -- --force --only Wolf     # regenerate even if unchanged
```

`sprites.manifest.lock.json` records a fingerprint per entity; unchanged entries
are skipped on rerun. Editing a `prompt`/`seed`/`size` changes the fingerprint
and re-generates that entity next run.

## Approve
The run prints a ready-to-paste `curl` for each generated entity that maps to an
`entity_types` row (get `$TOKEN` from the login response or the admin UI). Heroes
have no row yet and are stored only — the hero picker (Slice 3) will consume them.
Approval uses `animated: true, frames: 1` so the single idle frame renders
directionally (`<dir>/0`) rather than as a fixed south-facing static.
````

- [ ] **Step 6: Verify the whole plan's unit tests still pass**

Run: `cd backend && node --test tests/sprite_manifest.test.js tests/sprite_runner_client.test.js tests/sprite_runner.test.js`
Expected: PASS (all three files).

- [ ] **Step 7: Smoke-test the CLI against the manifest (no network)**

Run: `cd backend && npm run sprites:gen -- --dry-run`
Expected: prints `Running 27 entities against http://localhost:3101 (dry-run)...` then a report table with every entity at status `planned`, and no error. (Confirms manifest parses, arg parsing works, and 27 entities resolve.)

- [ ] **Step 8: Commit**

```bash
git add sprites.manifest.json sprites.manifest.lock.json backend/scripts/gen-sprites.js \
  backend/package.json sprite-gen/README-sprites-manifest.md
git commit -m "feat(sprites): manifest-driven batch generation CLI (npm run sprites:gen)"
```

---

## Self-Review

**Spec coverage:**
- Manifest JSON with `name`/`kind`/`prompt`/`seed` + `defaults` → Task 1 (schema/validation) + Task 4 (content). ✓
- Re-runnable command reading the manifest → Task 4 (`npm run sprites:gen`). ✓
- Idempotent rerun via committed lockfile → Task 1 (`shouldSkip`/lock helpers) + Task 3 (lock update) + Task 4 (lock file). ✓
- Static 8-facing directional (creature) + flat (object) → `frames:1` forced in Task 1, route split in Task 2. ✓
- Generate-only, approve via existing UI → Task 2 routes through `/api/sprite-jobs`/`/api/entity-jobs` (creates `sprite_sets` rows); Task 4 prints the approve `curl`. ✓
- Full roster (10 heroes, 12 creatures, 5 scenery = 27) → Task 4 manifest. ✓
- Docs/skill note → Task 4 README. ✓
- Directional-static renders via animated path (`animated:true, frames:1`) → Task 4 approve payload + README note. ✓

**Deferred (per spec, not this plan):** client action dimension (Slice 2), hero picker (Slice 3), action-animation generation (Slice 4), any client-side change. The spec's "verify the 1-frame animated path renders directional idle without flicker" is a browser check performed at approval time, not a code task here — called out in the README.

**Placeholder scan:** no TBD/TODO; every code step contains complete, runnable code. ✓

**Type consistency:** `runGeneration` signature, `ReportRow` fields (`atlasKey`/`manifestKey`/`entityTypeId`), client `startJob`/`pollJob` return shapes, and `resolveEntity` output are used identically across Tasks 1–4. Approve payload uses `atlas_key`/`manifest_key`/`job_id` matching `backend/src/index.js:956`. ✓

**Manual verification note:** Steps 6–7 verify code without a live stack; a real end-to-end run (Step of the operator, not the plan) needs the stack up and is documented in the README. The first real generation should use `--only Wolf` to validate one creature end-to-end before the full ~3-hour batch.
