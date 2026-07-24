# Codebase Audit Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a re-runnable audit cycle for something2 — static audit, browser verification, one Plane task per finding, then fix every filed finding.

**Architecture:** A small CommonJS toolkit under `tools/audit/` owns the machine-checkable parts: the finding schema, fingerprint-based deduplication, and idempotent Plane synchronisation. Four skills under `.claude/skills/` own the judgement parts: what to look for, how to drive the browser, how to sync, how to fix. The toolkit is built and unit-tested first, the skills are written second, and the audit itself is then executed *through* them — so the skills are validated by use rather than written as post-hoc prose.

**Tech Stack:** Node 22 (CommonJS, `node --test`, global `fetch`), Plane REST API v1, Chrome DevTools MCP, Postgres 16, Vitest (frontend), pytest (sprite-gen).

## Global Constraints

- **`engine/` is out of scope.** Never audit, modify, or file findings against it.
- **Never push to a remote. Never merge to `main`.** Both require explicit user approval, asked for at the time.
- **Plane requires a browser-like User-Agent.** Cloudflare rejects the default Node/Python UA with HTTP 403 error code 1010. Every request must send `User-Agent: curl/8.5.0`.
- **Plane modules are disabled** in this workspace. Grouping is Epic + Label only.
- **Secrets are never written into skill files, plan files, audit output, or commits.** Credentials are read at runtime from `.env` (`ADMIN_USERNAME`, `ADMIN_PASSWORD`) and from `.mcp.json` (Plane API key).
- **Plane project:** `Something2`, identifier `SOMET`, UUID `5af54080-02ab-4ce8-8473-0b20632e0460`, workspace slug `something2`.
- **Plane Epic work item type UUID:** `14e6dccc-3a38-4276-8820-f3e74922d09e`.
- **Plane Done state UUID:** `e1cbace7-9999-4847-a54b-6d3f248c6dfe`.
- **Audit output directory:** `docs/audits/2026-07-24/`.
- **Severity → Plane priority:** `P0→urgent`, `P1→high`, `P2→medium`, `P3→low`.
- **Severity controls order, not inclusion.** Every finding is filed and fixed; P3 is simply worked last.
- **Every finding must carry a concrete failure scenario** (specific input or state → specific wrong outcome). A finding with no consequence is capped at P3 and may never be filed higher.

## File Structure

**Created — audit toolkit (CommonJS, no dependencies beyond Node builtins):**

| File | Responsibility |
|---|---|
| `tools/audit/lib/config.js` | Plane UUIDs, priority map, surface/lens/severity vocabularies. The only place an id literal appears. |
| `tools/audit/lib/finding.js` | Finding shape: validation and fingerprint derivation. Pure. |
| `tools/audit/lib/store.js` | Read, merge, and write `findings.json`. Owns id assignment and dedupe-on-merge. Pure except file I/O. |
| `tools/audit/lib/plane.js` | Plane REST v1 client. The only place `fetch` and the API key appear. |
| `tools/audit/lib/sync.js` | Reconcile findings against Plane. Pure logic over an injected client, so it is testable without the network. |
| `tools/audit/bin/sync.js` | CLI entry point wiring config + store + client + sync together. |
| `tools/audit/test/finding.test.js` | Unit tests for validation and fingerprinting. |
| `tools/audit/test/store.test.js` | Unit tests for merge, dedupe, id assignment. |
| `tools/audit/test/plane.test.js` | Unit tests for the client against a fake fetch. |
| `tools/audit/test/sync.test.js` | Unit tests for reconcile, including the idempotency property. |
| `tools/audit/package.json` | Declares the test script. No dependencies. |

**Created — skills:**

| File | Responsibility |
|---|---|
| `.claude/skills/audit-static/SKILL.md` | Surface map, six lenses, the verification bar, finding-emission format. |
| `.claude/skills/audit-browser/SKILL.md` | The four browser flows as concrete act/assert scripts, credential handling, flake policy. |
| `.claude/skills/plane-sync/SKILL.md` | How to run the sync tool, bootstrap the epic and label, and interpret its output. |
| `.claude/skills/audit-cycle/SKILL.md` | Orchestrator. Sequences the three, owns phase gates, supports surface scoping. |

**Created — audit artifacts:**

| File | Responsibility |
|---|---|
| `docs/audits/2026-07-24/baseline.md` | Pre-existing test failures and lint state, captured before any change. |
| `docs/audits/2026-07-24/findings.json` | The single source of truth for findings. |
| `docs/audits/2026-07-24/browser-run.md` | Browser suite transcript: what each flow asserted and observed. |

**Modified:**

| File | Change |
|---|---|
| `AGENTS.md` | Add the audit cycle to the project context index. |
| `.gitignore` | Ignore `tools/audit/.cache/` if the sync tool writes one. |

---

### Task 1: Finding schema and fingerprint

The fingerprint is the keystone of the whole cycle: it is what makes the second run of the audit update its tasks instead of duplicating them. It deliberately excludes the line number, so that a fix which shifts code down a file does not resurrect a finding as a new one.

**Files:**
- Create: `tools/audit/package.json`
- Create: `tools/audit/lib/config.js`
- Create: `tools/audit/lib/finding.js`
- Test: `tools/audit/test/finding.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `config.SEVERITIES: string[]`, `config.LENSES: string[]`, `config.SURFACES: string[]`, `config.STATUSES: string[]`
  - `config.PRIORITY_BY_SEVERITY: Record<string,string>`
  - `config.PLANE: { workspace, projectId, epicTypeId, doneStateId, userAgent, baseUrl }`
  - `finding.normalizeClaim(claim: string): string`
  - `finding.fingerprint(f: object): string` — 40-char hex
  - `finding.validate(f: object): string[]` — empty array means valid

- [ ] **Step 1: Create the package manifest**

`tools/audit/package.json`:

```json
{
  "name": "something2-audit",
  "version": "1.0.0",
  "private": true,
  "description": "Audit cycle toolkit: finding schema, dedupe, Plane sync.",
  "scripts": {
    "test": "node --test test/"
  }
}
```

- [ ] **Step 2: Create the config module**

`tools/audit/lib/config.js`:

```js
'use strict';

// Every Plane id literal in this project lives here and nowhere else.
const PLANE = {
  workspace: 'something2',
  projectId: '5af54080-02ab-4ce8-8473-0b20632e0460',
  epicTypeId: '14e6dccc-3a38-4276-8820-f3e74922d09e',
  doneStateId: 'e1cbace7-9999-4847-a54b-6d3f248c6dfe',
  // Cloudflare rejects the default Node UA with a 403 (error code 1010).
  userAgent: 'curl/8.5.0',
  baseUrl: 'https://api.plane.so/api/v1',
};

const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];

const PRIORITY_BY_SEVERITY = {
  P0: 'urgent',
  P1: 'high',
  P2: 'medium',
  P3: 'low',
};

const LENSES = ['dry', 'kiss', 'yagni', 'solid', 'security', 'user-logic'];

const SURFACES = [
  'backend-api',
  'backend-authority',
  'frontend-admin',
  'frontend-game',
  'sprite-gen',
  'infra',
];

const STATUSES = ['open', 'fixed', 'unverified', 'demoted'];

const SOURCES = ['static', 'browser'];

module.exports = {
  PLANE,
  SEVERITIES,
  PRIORITY_BY_SEVERITY,
  LENSES,
  SURFACES,
  STATUSES,
  SOURCES,
};
```

- [ ] **Step 3: Write the failing tests**

`tools/audit/test/finding.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeClaim, fingerprint, validate } = require('../lib/finding.js');

function valid(overrides) {
  return Object.assign({
    id: 'F-001',
    surface: 'backend-api',
    file: 'backend/src/index.js:42',
    lens: 'security',
    severity: 'P0',
    source: 'static',
    claim: 'Route does not check authorization.',
    failure_scenario: 'A player token reaches POST /maps and creates a map.',
    proposed_fix: 'Wrap the route in requireAdmin(pool).',
    verification: 'Call POST /maps with a player token; expect 403.',
    status: 'open',
    plane_id: null,
  }, overrides);
}

test('normalizeClaim collapses case, whitespace and punctuation', () => {
  assert.strictEqual(
    normalizeClaim('  Route  does NOT check\tauthorization!! '),
    'route does not check authorization'
  );
});

test('fingerprint is a 40 char hex string', () => {
  assert.match(fingerprint(valid()), /^[0-9a-f]{40}$/);
});

test('fingerprint is stable across line number changes', () => {
  const a = fingerprint(valid({ file: 'backend/src/index.js:42' }));
  const b = fingerprint(valid({ file: 'backend/src/index.js:915' }));
  assert.strictEqual(a, b);
});

test('fingerprint is stable across cosmetic claim rewording', () => {
  const a = fingerprint(valid({ claim: 'Route does not check authorization.' }));
  const b = fingerprint(valid({ claim: 'route  does not check AUTHORIZATION' }));
  assert.strictEqual(a, b);
});

test('fingerprint differs when the file differs', () => {
  const a = fingerprint(valid({ file: 'backend/src/index.js:42' }));
  const b = fingerprint(valid({ file: 'backend/src/authority/loot.js:42' }));
  assert.notStrictEqual(a, b);
});

test('fingerprint differs when the lens differs', () => {
  assert.notStrictEqual(
    fingerprint(valid({ lens: 'security' })),
    fingerprint(valid({ lens: 'dry' }))
  );
});

test('validate accepts a well formed finding', () => {
  assert.deepStrictEqual(validate(valid()), []);
});

test('validate rejects an unknown severity', () => {
  const errors = validate(valid({ severity: 'P9' }));
  assert.ok(errors.some((e) => e.includes('severity')));
});

test('validate rejects an unknown surface', () => {
  const errors = validate(valid({ surface: 'engine' }));
  assert.ok(errors.some((e) => e.includes('surface')));
});

test('validate requires a non-empty failure_scenario', () => {
  const errors = validate(valid({ failure_scenario: '   ' }));
  assert.ok(errors.some((e) => e.includes('failure_scenario')));
});

test('validate caps a finding with no consequence at P3', () => {
  // The verification bar: severity above P3 demands a failure scenario that
  // names both a trigger and an outcome. A bare structural remark cannot be P0.
  const errors = validate(valid({
    severity: 'P0',
    failure_scenario: 'Violates SRP.',
  }));
  assert.ok(errors.some((e) => e.includes('P3')));
});

test('validate accepts a bare structural remark at P3', () => {
  assert.deepStrictEqual(
    validate(valid({ severity: 'P3', failure_scenario: 'Violates SRP.' })),
    []
  );
});

test('validate rejects a file path without a line number', () => {
  const errors = validate(valid({ file: 'backend/src/index.js' }));
  assert.ok(errors.some((e) => e.includes('file')));
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd tools/audit && node --test test/finding.test.js`
Expected: FAIL — `Cannot find module '../lib/finding.js'`

- [ ] **Step 5: Implement the finding module**

`tools/audit/lib/finding.js`:

```js
'use strict';

const crypto = require('node:crypto');
const { SEVERITIES, LENSES, SURFACES, STATUSES, SOURCES } = require('./config.js');

// A failure scenario earns a severity above P3 only if it describes a trigger
// AND an outcome. This is the machine-checkable half of the verification bar;
// the reviewing agent enforces the rest.
const MIN_SCENARIO_WORDS = 8;

function normalizeClaim(claim) {
  return String(claim || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLine(file) {
  return String(file || '').replace(/:\d+(-\d+)?$/, '');
}

function fingerprint(f) {
  const parts = [f.surface, stripLine(f.file), f.lens, normalizeClaim(f.claim)];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validate(f) {
  const errors = [];

  if (!f || typeof f !== 'object') return ['finding must be an object'];

  if (!/^F-\d{3,}$/.test(f.id || '')) errors.push('id must look like F-001');
  if (!SURFACES.includes(f.surface)) errors.push(`surface must be one of ${SURFACES.join(', ')}`);
  if (!LENSES.includes(f.lens)) errors.push(`lens must be one of ${LENSES.join(', ')}`);
  if (!SEVERITIES.includes(f.severity)) errors.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (!SOURCES.includes(f.source)) errors.push(`source must be one of ${SOURCES.join(', ')}`);
  if (!STATUSES.includes(f.status)) errors.push(`status must be one of ${STATUSES.join(', ')}`);

  if (!/:\d+(-\d+)?$/.test(f.file || '')) {
    errors.push('file must end in a line number, e.g. path/to/file.js:42');
  }

  for (const field of ['claim', 'failure_scenario', 'proposed_fix', 'verification']) {
    if (!nonEmpty(f[field])) errors.push(`${field} must be a non-empty string`);
  }

  if (f.plane_id !== null && typeof f.plane_id !== 'string') {
    errors.push('plane_id must be null or a string');
  }

  const scenarioWords = String(f.failure_scenario || '').trim().split(/\s+/).filter(Boolean).length;
  if (f.severity !== 'P3' && SEVERITIES.includes(f.severity) && scenarioWords < MIN_SCENARIO_WORDS) {
    errors.push(
      `failure_scenario is too thin to justify ${f.severity}; ` +
      'describe a trigger and an outcome, or record this at P3'
    );
  }

  return errors;
}

module.exports = { normalizeClaim, stripLine, fingerprint, validate };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd tools/audit && node --test test/finding.test.js`
Expected: PASS — 12 tests, 0 failures

- [ ] **Step 7: Commit**

```bash
git add tools/audit/package.json tools/audit/lib/config.js tools/audit/lib/finding.js tools/audit/test/finding.test.js
git commit -m "feat(audit): finding schema, fingerprint and verification bar"
```

---

### Task 2: Findings store with merge and dedupe

**Files:**
- Create: `tools/audit/lib/store.js`
- Test: `tools/audit/test/store.test.js`

**Interfaces:**
- Consumes: `finding.fingerprint`, `finding.validate`
- Produces:
  - `store.emptyDoc(): { version: 1, findings: [] }`
  - `store.load(path: string): doc` — returns `emptyDoc()` if the file does not exist
  - `store.save(path: string, doc): void` — atomic, 2-space JSON, trailing newline
  - `store.nextId(doc): string`
  - `store.merge(doc, incoming: object[]): { doc, added: string[], updated: string[] }`

- [ ] **Step 1: Write the failing tests**

`tools/audit/test/store.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store.js');

function incoming(overrides) {
  return Object.assign({
    surface: 'backend-api',
    file: 'backend/src/index.js:42',
    lens: 'security',
    severity: 'P0',
    source: 'static',
    claim: 'Route does not check authorization.',
    failure_scenario: 'A player token reaches POST /maps and successfully creates a map.',
    proposed_fix: 'Wrap the route in requireAdmin(pool).',
    verification: 'Call POST /maps with a player token; expect 403.',
  }, overrides);
}

function tmpPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'findings.json');
}

test('load returns an empty doc when the file is absent', () => {
  const doc = store.load(path.join(os.tmpdir(), 'definitely-absent-findings.json'));
  assert.deepStrictEqual(doc, { version: 1, findings: [] });
});

test('save then load round-trips', () => {
  const p = tmpPath();
  const { doc } = store.merge(store.emptyDoc(), [incoming()]);
  store.save(p, doc);
  assert.deepStrictEqual(store.load(p), doc);
});

test('merge assigns sequential ids', () => {
  const { doc } = store.merge(store.emptyDoc(), [
    incoming({ claim: 'First problem here.' }),
    incoming({ claim: 'Second problem here.' }),
  ]);
  assert.deepStrictEqual(doc.findings.map((f) => f.id), ['F-001', 'F-002']);
});

test('merge sets status open and plane_id null on new findings', () => {
  const { doc } = store.merge(store.emptyDoc(), [incoming()]);
  assert.strictEqual(doc.findings[0].status, 'open');
  assert.strictEqual(doc.findings[0].plane_id, null);
});

test('merge stores the fingerprint', () => {
  const { doc } = store.merge(store.emptyDoc(), [incoming()]);
  assert.match(doc.findings[0].fingerprint, /^[0-9a-f]{40}$/);
});

test('merging the same finding twice does not duplicate it', () => {
  const first = store.merge(store.emptyDoc(), [incoming()]);
  const second = store.merge(first.doc, [incoming()]);
  assert.strictEqual(second.doc.findings.length, 1);
  assert.deepStrictEqual(second.added, []);
  assert.deepStrictEqual(second.updated, ['F-001']);
});

test('re-merge preserves plane_id and status of an existing finding', () => {
  const first = store.merge(store.emptyDoc(), [incoming()]);
  first.doc.findings[0].plane_id = 'uuid-123';
  first.doc.findings[0].status = 'fixed';

  const second = store.merge(first.doc, [incoming({ severity: 'P1' })]);
  assert.strictEqual(second.doc.findings[0].plane_id, 'uuid-123');
  assert.strictEqual(second.doc.findings[0].status, 'fixed');
  assert.strictEqual(second.doc.findings[0].severity, 'P1');
});

test('merge treats a line number change as the same finding', () => {
  const first = store.merge(store.emptyDoc(), [incoming({ file: 'backend/src/index.js:42' })]);
  const second = store.merge(first.doc, [incoming({ file: 'backend/src/index.js:915' })]);
  assert.strictEqual(second.doc.findings.length, 1);
  assert.strictEqual(second.doc.findings[0].file, 'backend/src/index.js:915');
});

test('merge rejects an invalid finding with a descriptive error', () => {
  assert.throws(
    () => store.merge(store.emptyDoc(), [incoming({ severity: 'P9' })]),
    /severity/
  );
});

test('nextId continues past the highest existing id', () => {
  const doc = { version: 1, findings: [{ id: 'F-007' }, { id: 'F-003' }] };
  assert.strictEqual(store.nextId(doc), 'F-008');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd tools/audit && node --test test/store.test.js`
Expected: FAIL — `Cannot find module '../lib/store.js'`

- [ ] **Step 3: Implement the store**

`tools/audit/lib/store.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fingerprint, validate } = require('./finding.js');

// Fields a re-audit is allowed to overwrite. Everything else — id, plane_id,
// status — belongs to the lifecycle, not to the observation, and survives.
const MUTABLE = [
  'file',
  'severity',
  'source',
  'claim',
  'failure_scenario',
  'proposed_fix',
  'verification',
];

function emptyDoc() {
  return { version: 1, findings: [] };
}

function load(file) {
  if (!fs.existsSync(file)) return emptyDoc();
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function save(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function nextId(doc) {
  const highest = doc.findings.reduce((max, f) => {
    const n = Number.parseInt(String(f.id).slice(2), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `F-${String(highest + 1).padStart(3, '0')}`;
}

function merge(doc, incoming) {
  const next = { version: doc.version || 1, findings: doc.findings.slice() };
  const byFingerprint = new Map(next.findings.map((f) => [f.fingerprint, f]));
  const added = [];
  const updated = [];

  for (const raw of incoming) {
    const fp = fingerprint(raw);
    const existing = byFingerprint.get(fp);

    if (existing) {
      for (const field of MUTABLE) {
        if (raw[field] !== undefined) existing[field] = raw[field];
      }
      const errors = validate(existing);
      if (errors.length) throw new Error(`${existing.id}: ${errors.join('; ')}`);
      updated.push(existing.id);
      continue;
    }

    const created = Object.assign({}, raw, {
      id: nextId(next),
      fingerprint: fp,
      status: 'open',
      plane_id: null,
    });
    const errors = validate(created);
    if (errors.length) throw new Error(`${created.id}: ${errors.join('; ')}`);
    next.findings.push(created);
    byFingerprint.set(fp, created);
    added.push(created.id);
  }

  return { doc: next, added, updated };
}

module.exports = { emptyDoc, load, save, nextId, merge, MUTABLE };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/audit && node --test test/store.test.js`
Expected: PASS — 10 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add tools/audit/lib/store.js tools/audit/test/store.test.js
git commit -m "feat(audit): findings store with fingerprint dedupe"
```

---

### Task 3: Plane REST client

The client is deliberately thin and takes an injected `fetchImpl`, so every behaviour below is tested without touching the network. Note the `User-Agent` header — omitting it is the single most likely cause of an unexplained 403.

**Files:**
- Create: `tools/audit/lib/plane.js`
- Test: `tools/audit/test/plane.test.js`

**Interfaces:**
- Consumes: `config.PLANE`
- Produces: `class PlaneClient` with
  - `constructor({ apiKey, fetchImpl })`
  - `async listLabels(): Promise<Array<{id, name}>>`
  - `async createLabel({ name, description, color }): Promise<{id, name}>`
  - `async createIssue({ name, description_html, priority, labels, parent, type_id }): Promise<{id, sequence_id}>`
  - `async updateIssue(id, patch): Promise<object>`
  - `async listIssues({ labelId }): Promise<Array<object>>` — follows pagination
  - `async deleteIssue(id): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`tools/audit/test/plane.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PlaneClient } = require('../lib/plane.js');

function fakeFetch(responses) {
  const calls = [];
  const queue = responses.slice();
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return {
      ok: next.status < 400,
      status: next.status,
      text: async () => JSON.stringify(next.body),
    };
  };
  impl.calls = calls;
  return impl;
}

test('sends the API key and a browser-like user agent', async () => {
  const impl = fakeFetch([{ status: 200, body: { results: [] } }]);
  const client = new PlaneClient({ apiKey: 'plane_api_secret', fetchImpl: impl });

  await client.listLabels();

  const headers = impl.calls[0].options.headers;
  assert.strictEqual(headers['X-API-Key'], 'plane_api_secret');
  assert.strictEqual(headers['User-Agent'], 'curl/8.5.0');
});

test('listLabels returns the results array', async () => {
  const impl = fakeFetch([{ status: 200, body: { results: [{ id: 'l1', name: 'K' }] } }]);
  const client = new PlaneClient({ apiKey: 'k', fetchImpl: impl });

  assert.deepStrictEqual(await client.listLabels(), [{ id: 'l1', name: 'K' }]);
});

test('listIssues follows pagination until next_cursor is absent', async () => {
  const impl = fakeFetch([
    { status: 200, body: { results: [{ id: 'i1' }], next_cursor: 'c2', next_page_results: true } },
    { status: 200, body: { results: [{ id: 'i2' }], next_page_results: false } },
  ]);
  const client = new PlaneClient({ apiKey: 'k', fetchImpl: impl });

  const issues = await client.listIssues({});
  assert.deepStrictEqual(issues.map((i) => i.id), ['i1', 'i2']);
  assert.strictEqual(impl.calls.length, 2);
  assert.ok(impl.calls[1].url.includes('cursor=c2'));
});

test('createIssue posts the body and returns the created issue', async () => {
  const impl = fakeFetch([{ status: 201, body: { id: 'i9', sequence_id: 200 } }]);
  const client = new PlaneClient({ apiKey: 'k', fetchImpl: impl });

  const created = await client.createIssue({
    name: 'Fix authz',
    description_html: '<p>body</p>',
    priority: 'urgent',
    labels: ['l1'],
    parent: 'epic-1',
  });

  assert.deepStrictEqual(created, { id: 'i9', sequence_id: 200 });
  const sent = JSON.parse(impl.calls[0].options.body);
  assert.strictEqual(sent.name, 'Fix authz');
  assert.strictEqual(sent.parent, 'epic-1');
  assert.strictEqual(impl.calls[0].options.method, 'POST');
});

test('updateIssue issues a PATCH', async () => {
  const impl = fakeFetch([{ status: 200, body: { id: 'i9' } }]);
  const client = new PlaneClient({ apiKey: 'k', fetchImpl: impl });

  await client.updateIssue('i9', { priority: 'high' });
  assert.strictEqual(impl.calls[0].options.method, 'PATCH');
  assert.deepStrictEqual(JSON.parse(impl.calls[0].options.body), { priority: 'high' });
});

test('a non-ok response raises an error naming the status and body', async () => {
  const impl = fakeFetch([{ status: 403, body: { error: 'forbidden' } }]);
  const client = new PlaneClient({ apiKey: 'k', fetchImpl: impl });

  await assert.rejects(() => client.listLabels(), /403.*forbidden/s);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd tools/audit && node --test test/plane.test.js`
Expected: FAIL — `Cannot find module '../lib/plane.js'`

- [ ] **Step 3: Implement the client**

`tools/audit/lib/plane.js`:

```js
'use strict';

const { PLANE } = require('./config.js');

class PlaneClient {
  constructor({ apiKey, fetchImpl = globalThis.fetch, plane = PLANE }) {
    if (!apiKey) throw new Error('PlaneClient requires an apiKey');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.plane = plane;
    this.projectRoot =
      `${plane.baseUrl}/workspaces/${plane.workspace}/projects/${plane.projectId}`;
  }

  async request(pathname, { method = 'GET', body } = {}) {
    const url = pathname.startsWith('http') ? pathname : `${this.projectRoot}${pathname}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
        // Cloudflare 403s the default Node UA. Do not remove.
        'User-Agent': this.plane.userAgent,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Plane ${method} ${url} failed: ${response.status} ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async paginate(pathname) {
    const out = [];
    let cursor = null;
    do {
      const sep = pathname.includes('?') ? '&' : '?';
      const page = await this.request(cursor ? `${pathname}${sep}cursor=${cursor}` : pathname);
      out.push(...(page.results || []));
      cursor = page.next_page_results ? page.next_cursor : null;
    } while (cursor);
    return out;
  }

  listLabels() {
    return this.paginate('/labels/');
  }

  createLabel({ name, description = '', color = '#64748b' }) {
    return this.request('/labels/', { method: 'POST', body: { name, description, color } });
  }

  listIssues({ labelId } = {}) {
    return this.paginate(labelId ? `/issues/?labels=${labelId}` : '/issues/');
  }

  createIssue(body) {
    return this.request('/issues/', { method: 'POST', body });
  }

  updateIssue(id, patch) {
    return this.request(`/issues/${id}/`, { method: 'PATCH', body: patch });
  }

  async deleteIssue(id) {
    await this.request(`/issues/${id}/`, { method: 'DELETE' });
  }
}

module.exports = { PlaneClient };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/audit && node --test test/plane.test.js`
Expected: PASS — 6 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add tools/audit/lib/plane.js tools/audit/test/plane.test.js
git commit -m "feat(audit): Plane REST client with pagination and UA workaround"
```

---

### Task 4: Idempotent reconcile

This is where the "file everything, never duplicate" promise is kept. The critical test is the idempotency property: running sync twice against an unchanged findings file must create nothing on the second pass.

**Files:**
- Create: `tools/audit/lib/sync.js`
- Test: `tools/audit/test/sync.test.js`

**Interfaces:**
- Consumes: `config.PRIORITY_BY_SEVERITY`, `config.PLANE.doneStateId`
- Produces:
  - `sync.renderTitle(f): string`
  - `sync.renderBody(f): string` — HTML
  - `sync.reconcile({ doc, client, epicId, labelIds, dryRun }): Promise<{ created, updated, closed, skipped }>` — mutates `doc.findings[].plane_id` in place

- [ ] **Step 1: Write the failing tests**

`tools/audit/test/sync.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renderTitle, renderBody, reconcile } = require('../lib/sync.js');
const { PLANE } = require('../lib/config.js');

function finding(overrides) {
  return Object.assign({
    id: 'F-001',
    surface: 'backend-api',
    file: 'backend/src/index.js:42',
    lens: 'security',
    severity: 'P0',
    source: 'static',
    claim: 'Route does not check authorization.',
    failure_scenario: 'A player token reaches POST /maps and successfully creates a map.',
    proposed_fix: 'Wrap the route in requireAdmin(pool).',
    verification: 'Call POST /maps with a player token; expect 403.',
    fingerprint: 'a'.repeat(40),
    status: 'open',
    plane_id: null,
  }, overrides);
}

class FakeClient {
  constructor() {
    this.issues = new Map();
    this.creates = [];
    this.patches = [];
    this.seq = 0;
  }
  async createIssue(body) {
    this.seq += 1;
    const id = `issue-${this.seq}`;
    this.issues.set(id, Object.assign({ id }, body));
    this.creates.push(body);
    return { id, sequence_id: 200 + this.seq };
  }
  async updateIssue(id, patch) {
    this.patches.push({ id, patch });
    Object.assign(this.issues.get(id) || {}, patch);
    return { id };
  }
}

test('renderTitle carries the finding id, severity and a summary', () => {
  const title = renderTitle(finding());
  assert.ok(title.includes('F-001'));
  assert.ok(title.includes('P0'));
  assert.ok(title.includes('authorization'));
});

test('renderBody includes every field a fixer needs', () => {
  const body = renderBody(finding());
  for (const needle of [
    'backend/src/index.js:42',
    'A player token reaches POST /maps',
    'requireAdmin(pool)',
    'expect 403',
    'security',
  ]) {
    assert.ok(body.includes(needle), `body should mention ${needle}`);
  }
});

test('reconcile creates an issue for a finding with no plane_id', async () => {
  const client = new FakeClient();
  const doc = { version: 1, findings: [finding()] };

  const result = await reconcile({ doc, client, epicId: 'epic-1', labelIds: ['label-k'] });

  assert.deepStrictEqual(result.created, ['F-001']);
  assert.strictEqual(client.creates.length, 1);
  assert.strictEqual(client.creates[0].parent, 'epic-1');
  assert.deepStrictEqual(client.creates[0].labels, ['label-k']);
  assert.strictEqual(client.creates[0].priority, 'urgent');
});

test('reconcile writes the plane_id back into the finding', async () => {
  const client = new FakeClient();
  const doc = { version: 1, findings: [finding()] };

  await reconcile({ doc, client, epicId: 'epic-1', labelIds: [] });
  assert.strictEqual(doc.findings[0].plane_id, 'issue-1');
});

test('reconcile is idempotent: a second run creates nothing', async () => {
  const client = new FakeClient();
  const doc = { version: 1, findings: [finding()] };

  await reconcile({ doc, client, epicId: 'epic-1', labelIds: [] });
  const second = await reconcile({ doc, client, epicId: 'epic-1', labelIds: [] });

  assert.strictEqual(client.creates.length, 1);
  assert.deepStrictEqual(second.created, []);
});

test('reconcile patches an issue whose severity changed', async () => {
  const client = new FakeClient();
  const doc = { version: 1, findings: [finding()] };

  await reconcile({ doc, client, epicId: 'epic-1', labelIds: [] });
  doc.findings[0].severity = 'P2';
  const second = await reconcile({ doc, client, epicId: 'epic-1', labelIds: [] });

  assert.deepStrictEqual(second.updated, ['F-001']);
  assert.strictEqual(client.patches.at(-1).patch.priority, 'medium');
});

test('reconcile closes an issue whose finding is fixed', async () => {
  const client = new FakeClient();
  const doc = { version: 1, findings: [finding()] };

  await reconcile({ doc, client, epicId: 'epic-1', labelIds: [] });
  doc.findings[0].status = 'fixed';
  const second = await reconcile({ doc, client, epicId: 'epic-1', labelIds: [] });

  assert.deepStrictEqual(second.closed, ['F-001']);
  assert.strictEqual(client.patches.at(-1).patch.state, PLANE.doneStateId);
});

test('reconcile never files an unverified finding', async () => {
  const client = new FakeClient();
  const doc = { version: 1, findings: [finding({ status: 'unverified' })] };

  const result = await reconcile({ doc, client, epicId: 'epic-1', labelIds: [] });

  assert.strictEqual(client.creates.length, 0);
  assert.deepStrictEqual(result.skipped, ['F-001']);
  assert.strictEqual(doc.findings[0].plane_id, null);
});

test('dryRun reports the work without performing it', async () => {
  const client = new FakeClient();
  const doc = { version: 1, findings: [finding()] };

  const result = await reconcile({ doc, client, epicId: 'epic-1', labelIds: [], dryRun: true });

  assert.deepStrictEqual(result.created, ['F-001']);
  assert.strictEqual(client.creates.length, 0);
  assert.strictEqual(doc.findings[0].plane_id, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd tools/audit && node --test test/sync.test.js`
Expected: FAIL — `Cannot find module '../lib/sync.js'`

- [ ] **Step 3: Implement reconcile**

`tools/audit/lib/sync.js`:

```js
'use strict';

const { PRIORITY_BY_SEVERITY, PLANE } = require('./config.js');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function summarize(claim) {
  const trimmed = String(claim).trim().replace(/\s+/g, ' ');
  return trimmed.length <= 90 ? trimmed : `${trimmed.slice(0, 87)}...`;
}

function renderTitle(f) {
  return `[${f.id}] ${f.severity} ${f.surface}: ${summarize(f.claim)}`;
}

function renderBody(f) {
  return [
    `<p><strong>Location:</strong> <code>${escapeHtml(f.file)}</code></p>`,
    `<p><strong>Lens:</strong> ${escapeHtml(f.lens)} &middot; <strong>Source:</strong> ${escapeHtml(f.source)}</p>`,
    `<p><strong>Claim:</strong> ${escapeHtml(f.claim)}</p>`,
    `<p><strong>Failure scenario:</strong> ${escapeHtml(f.failure_scenario)}</p>`,
    `<p><strong>Proposed fix:</strong> ${escapeHtml(f.proposed_fix)}</p>`,
    `<p><strong>Verification:</strong> ${escapeHtml(f.verification)}</p>`,
    `<p><em>Audit finding ${escapeHtml(f.id)} &middot; fingerprint ${escapeHtml(f.fingerprint)}</em></p>`,
  ].join('\n');
}

// The rendered snapshot decides whether an existing issue has drifted. Storing
// it on the finding avoids a read of every issue on every run.
function snapshot(f) {
  return `${renderTitle(f)}||${renderBody(f)}||${PRIORITY_BY_SEVERITY[f.severity]}||${f.status}`;
}

async function reconcile({ doc, client, epicId, labelIds = [], dryRun = false }) {
  const created = [];
  const updated = [];
  const closed = [];
  const skipped = [];

  for (const f of doc.findings) {
    if (f.status === 'unverified') {
      skipped.push(f.id);
      continue;
    }

    if (!f.plane_id) {
      created.push(f.id);
      if (dryRun) continue;
      const issue = await client.createIssue({
        name: renderTitle(f),
        description_html: renderBody(f),
        priority: PRIORITY_BY_SEVERITY[f.severity],
        labels: labelIds,
        parent: epicId,
      });
      f.plane_id = issue.id;
      f.plane_key = issue.sequence_id ? `SOMET-${issue.sequence_id}` : undefined;
      f.synced_snapshot = snapshot(f);
      continue;
    }

    const current = snapshot(f);
    if (current === f.synced_snapshot) continue;

    const patch = {
      name: renderTitle(f),
      description_html: renderBody(f),
      priority: PRIORITY_BY_SEVERITY[f.severity],
    };
    if (f.status === 'fixed') {
      patch.state = PLANE.doneStateId;
      closed.push(f.id);
    } else {
      updated.push(f.id);
    }

    if (dryRun) continue;
    await client.updateIssue(f.plane_id, patch);
    f.synced_snapshot = current;
  }

  return { created, updated, closed, skipped };
}

module.exports = { renderTitle, renderBody, snapshot, reconcile };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/audit && node --test test/sync.test.js`
Expected: PASS — 9 tests, 0 failures

- [ ] **Step 5: Run the whole toolkit suite**

Run: `cd tools/audit && npm test`
Expected: PASS — 37 tests total, 0 failures

- [ ] **Step 6: Commit**

```bash
git add tools/audit/lib/sync.js tools/audit/test/sync.test.js
git commit -m "feat(audit): idempotent Plane reconcile"
```

---

### Task 5: Sync CLI

**Files:**
- Create: `tools/audit/bin/sync.js`
- Modify: `tools/audit/package.json` (add the `sync` script)

**Interfaces:**
- Consumes: `store.load`, `store.save`, `PlaneClient`, `sync.reconcile`
- Produces: CLI `node tools/audit/bin/sync.js --findings <path> [--dry-run]`, exit code 0 on success and 1 on failure.

- [ ] **Step 1: Write the CLI**

`tools/audit/bin/sync.js`:

```js
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/store.js');
const { PlaneClient } = require('../lib/plane.js');
const { reconcile } = require('../lib/sync.js');

const EPIC_LABEL = 'K · Audit & hardening';

function readApiKey() {
  if (process.env.PLANE_API_KEY) return process.env.PLANE_API_KEY;
  const mcpPath = path.resolve(__dirname, '../../../.mcp.json');
  const match = fs.readFileSync(mcpPath, 'utf8').match(/plane_api_[A-Za-z0-9]+/);
  if (!match) throw new Error('no Plane API key in PLANE_API_KEY or .mcp.json');
  return match[0];
}

function parseArgs(argv) {
  const args = { dryRun: false, findings: null, epicId: process.env.AUDIT_EPIC_ID || null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--findings') args.findings = argv[++i];
    else if (argv[i] === '--epic') args.epicId = argv[++i];
  }
  if (!args.findings) throw new Error('usage: sync.js --findings <path> [--epic <uuid>] [--dry-run]');
  if (!args.epicId) throw new Error('no epic id: pass --epic <uuid> or set AUDIT_EPIC_ID');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new PlaneClient({ apiKey: readApiKey() });

  const labels = await client.listLabels();
  const label = labels.find((l) => l.name === EPIC_LABEL);
  if (!label) throw new Error(`label "${EPIC_LABEL}" does not exist; run the bootstrap step first`);

  const doc = store.load(args.findings);
  const result = await reconcile({
    doc,
    client,
    epicId: args.epicId,
    labelIds: [label.id],
    dryRun: args.dryRun,
  });

  if (!args.dryRun) store.save(args.findings, doc);

  console.log(JSON.stringify({
    dryRun: args.dryRun,
    created: result.created.length,
    updated: result.updated.length,
    closed: result.closed.length,
    skipped: result.skipped.length,
    total: doc.findings.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
```

- [ ] **Step 2: Add the script to the manifest**

Replace the `scripts` block in `tools/audit/package.json`:

```json
  "scripts": {
    "test": "node --test test/",
    "sync": "node bin/sync.js"
  },
```

- [ ] **Step 3: Verify the CLI fails cleanly with no arguments**

Run: `cd tools/audit && node bin/sync.js`
Expected: exit code 1, stderr `usage: sync.js --findings <path> [--epic <uuid>] [--dry-run]`

- [ ] **Step 4: Commit**

```bash
git add tools/audit/bin/sync.js tools/audit/package.json
git commit -m "feat(audit): sync CLI"
```

---

### Task 6: Plane bootstrap and parent/type probe

The REST API's support for setting `parent` to an epic-typed work item is the one assumption in this plan that has not been verified against the live service. This task proves it before ninety tasks depend on it, and records the fallback if it fails.

**Files:**
- Create: `docs/audits/2026-07-24/plane-bootstrap.md`

**Interfaces:**
- Consumes: `PlaneClient`, Plane MCP tools.
- Produces: the epic UUID and label UUID, recorded in `plane-bootstrap.md` and used as `--epic` by every later sync.

- [ ] **Step 1: Create the label**

Use the Plane MCP tool `create_label`:
- `project_id`: `5af54080-02ab-4ce8-8473-0b20632e0460`
- `name`: `K · Audit & hardening`
- `description`: `Cross-cutting audit: DRY/KISS/YAGNI/SOLID, security, and user-logic failures across backend, frontend, sprite-gen and infra.`
- `color`: `#f97316`

Record the returned label UUID.

- [ ] **Step 2: Create the epic**

Use the Plane MCP tool `create_work_item`:
- `project_id`: `5af54080-02ab-4ce8-8473-0b20632e0460`
- `type_id`: `14e6dccc-3a38-4276-8820-f3e74922d09e`
- `name`: `K · Codebase audit & hardening`
- `description_html`: a one-paragraph summary linking to `docs/superpowers/specs/2026-07-24-codebase-audit-cycle-design.md`

Record the returned epic UUID.

- [ ] **Step 3: Probe that a REST-created issue can parent to the epic**

```bash
cd tools/audit && node -e "
const { PlaneClient } = require('./lib/plane.js');
const fs = require('fs');
const key = fs.readFileSync('../../.mcp.json','utf8').match(/plane_api_[A-Za-z0-9]+/)[0];
const client = new PlaneClient({ apiKey: key });
(async () => {
  const issue = await client.createIssue({
    name: '[PROBE] delete me',
    description_html: '<p>parent/label probe</p>',
    priority: 'low',
    labels: [process.env.LABEL_ID],
    parent: process.env.EPIC_ID,
  });
  console.log('created', issue.id, issue.sequence_id);
})();
"
```

Run with `EPIC_ID` and `LABEL_ID` set from steps 1 and 2.
Expected: prints `created <uuid> <number>`.

- [ ] **Step 4: Verify the probe landed under the epic**

Use the Plane MCP tool `list_work_items` with `pql: 'childOf("SOMET-<epic sequence id>")'`.
Expected: the probe issue appears in the results with the `K ·` label attached.

**If it does not appear as a child:** REST `parent` does not accept an epic-typed parent. Record this in `plane-bootstrap.md` and change Task 9 to create issues via the MCP `create_work_item` tool (which accepts `parent`) instead of the CLI, keeping `reconcile` as the driver of *what* to create. The finding schema, fingerprint, and idempotency logic are unaffected either way.

- [ ] **Step 5: Delete the probe**

```bash
cd tools/audit && node -e "
const { PlaneClient } = require('./lib/plane.js');
const fs = require('fs');
const key = fs.readFileSync('../../.mcp.json','utf8').match(/plane_api_[A-Za-z0-9]+/)[0];
new PlaneClient({ apiKey: key }).deleteIssue(process.env.PROBE_ID).then(() => console.log('deleted'));
"
```

Expected: prints `deleted`.

- [ ] **Step 6: Record the ids and commit**

Write `docs/audits/2026-07-24/plane-bootstrap.md` containing the epic UUID, the epic's `SOMET-NNN` identifier, the label UUID, and the probe result (whether REST parenting works).

```bash
git add docs/audits/2026-07-24/plane-bootstrap.md
git commit -m "chore(audit): bootstrap Plane epic K and audit label"
```

---

### Task 7: audit-static skill

**Files:**
- Create: `.claude/skills/audit-static/SKILL.md`

**Interfaces:**
- Consumes: `tools/audit/lib/config.js` vocabularies, `tools/audit/lib/store.js` for emission.
- Produces: a skill that, given a surface name, emits validated findings into `docs/audits/2026-07-24/findings.json`.

- [ ] **Step 1: Write the skill**

`.claude/skills/audit-static/SKILL.md`:

````markdown
---
name: audit-static
description: Use when auditing a something2 code surface against DRY, KISS, YAGNI, SOLID, security, and user-logic-failure lenses, and emitting findings into the audit findings file.
---

# Static Audit

Audit one surface at a time against six lenses. Emit findings that a fixer can act
on without re-deriving your reasoning.

## Surfaces

| Name | Path | Dominant risk |
|---|---|---|
| `backend-api` | `backend/src` excluding `authority/` | authorization gaps, input validation, SQL construction |
| `backend-authority` | `backend/src/authority` | trusting client-supplied values, duplicate/race exploits |
| `frontend-admin` | `frontend/src` excluding `games/*/src/js` | duplicated CRUD, missing error states, stale cache |
| `frontend-game` | `frontend/src/games/something2/src/js` | god objects, coupling, per-frame cost |
| `sprite-gen` | `sprite-gen/app` | path traversal, resource exhaustion, unbounded jobs |
| `infra` | `compose/`, `Makefile`, `.env`, `backend/migrations` | secret handling, exposed ports, migration ordering |

`engine/` is out of scope. It is paused and outdated. Never audit it.

## Lenses

Apply all six to the surface. For each, the question is not "is this principle
violated" but "what breaks because of it".

- **dry** — logic duplicated across call sites. Only report it where the copies have
  already drifted or where a change would have to be made in every copy to be
  correct. Two similar-looking functions that serve different purposes are not a
  DRY violation.
- **kiss** — complexity with no payer. A layer of indirection nobody uses, a
  configuration knob nobody sets, control flow that is harder to follow than the
  problem is hard.
- **yagni** — code kept alive for a use case that never arrived. Dead parameters,
  unreachable branches, abstractions with exactly one implementation and no second
  one in prospect.
- **solid** — responsibilities that should be separable and are not, in a way that
  blocks a change someone actually wants to make. A file being long is not itself a
  finding; a file being long *because* two unrelated concerns are interleaved is.
- **security** — authorization, authentication, input validation, injection,
  secrets, and trust boundaries. In `backend-authority`, the standing question is
  "what happens if the client lies about this value".
- **user-logic** — the flow is individually correct and collectively wrong. Missing
  error states, unreachable recovery, state that desynchronises between screens,
  operations that are not idempotent under retry.

## The verification bar

**Every finding must state a concrete failure scenario: a specific input or state
producing a specific wrong outcome.**

A finding whose entire content is "this violates the single-responsibility
principle", with no consequence attached, is recorded at `P3` and never higher.
This is enforced mechanically — `validate()` rejects a thin `failure_scenario` on
any finding above P3 — but the mechanism only catches the laziest cases. Hold the
line yourself.

This project has already shipped twelve vacuous tests: assertions that could not
fail. An audit that files unfalsifiable findings is the same failure wearing a
different hat, and it is worse than filing nothing, because it looks like progress.

Before emitting a finding, ask: *if someone disputed this, what would I show them?*
If the answer is "the code, and my opinion of it", it is P3.

## Severity

| | Meaning |
|---|---|
| `P0` | Security hole, data loss, or crash reachable by a user. |
| `P1` | A user flow produces a wrong result or dead-ends. |
| `P2` | Structural problem with a demonstrated cost. |
| `P3` | Structural observation with no demonstrated consequence. |

Severity controls order, not inclusion. P3 findings are filed and fixed like any
other; they are simply worked last.

Do not claim `P0` for something you have not traced to a reachable entry point. If
you believe a gap is exploitable but have not proven it, file it at your honest
severity and set `verification` to the browser check that would prove it — the
browser phase will confirm or demote it.

## Emitting findings

Append to `docs/audits/2026-07-24/findings.json` via the store, which assigns ids,
computes fingerprints, and rejects invalid findings:

```js
const store = require('./tools/audit/lib/store.js');
const path = 'docs/audits/2026-07-24/findings.json';
const { doc, added, updated } = store.merge(store.load(path), [
  {
    surface: 'backend-api',
    file: 'backend/src/index.js:412',
    lens: 'security',
    severity: 'P0',
    source: 'static',
    claim: 'DELETE /maps/:id has no admin guard.',
    failure_scenario: 'A logged-in player calls DELETE /maps/3 and the map is removed for everyone on it.',
    proposed_fix: 'Wrap the route in requireAdmin(pool), matching POST /maps.',
    verification: 'Call DELETE /maps/:id with a player token; expect 403 and the map still present.',
  },
]);
store.save(path, doc);
console.log({ added, updated });
```

`merge` throws on an invalid finding. A throw is the schema telling you the finding
is not yet good enough to file — fix the finding, not the schema.

## Procedure

1. Read the surface. For a large surface, read it in coherent chunks (a module, a
   route group, a system) rather than file-by-file — most findings live between
   files, not inside one.
2. For each lens, sweep the surface and note candidates.
3. For each candidate, construct the failure scenario. Candidates that cannot get
   one are either P3 or dropped.
4. Emit via `store.merge`. Re-running on a surface updates its existing findings
   rather than duplicating them.
5. Commit `findings.json` with a message naming the surface and the count.

## Scoping

Invoked with a surface name, audit only that surface. Invoked with no argument,
audit all six in the table order.
````

- [ ] **Step 2: Smoke-test the skill on one small file**

Invoke `audit-static` scoped to `backend/src/auth/middleware.js` only. Confirm that:
- it emits at least one finding or explicitly reports none,
- `node -e "require('./tools/audit/lib/store.js').load('docs/audits/2026-07-24/findings.json')"` parses,
- every emitted finding passes `validate()`.

Run: `cd tools/audit && node -e "
const store = require('./lib/store.js');
const { validate } = require('./lib/finding.js');
const doc = store.load('../../docs/audits/2026-07-24/findings.json');
const bad = doc.findings.filter((f) => validate(f).length);
console.log('findings:', doc.findings.length, 'invalid:', bad.length);
process.exit(bad.length ? 1 : 0);
"`
Expected: exit code 0, `invalid: 0`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/audit-static/SKILL.md docs/audits/2026-07-24/findings.json
git commit -m "feat(audit): audit-static skill"
```

---

### Task 8: audit-browser skill

**Files:**
- Create: `.claude/skills/audit-browser/SKILL.md`

**Interfaces:**
- Consumes: Chrome DevTools MCP tools, `.env` credentials, `store.merge`.
- Produces: a skill that runs the four flows and emits `source: 'browser'` findings, plus `docs/audits/2026-07-24/browser-run.md`.

- [ ] **Step 1: Write the skill**

`.claude/skills/audit-browser/SKILL.md`:

````markdown
---
name: audit-browser
description: Use when verifying something2 in a real browser via Chrome DevTools MCP — running the four audit flows, confirming or demoting static findings, and emitting browser-sourced findings.
---

# Browser Audit

Drive the running stack through four flows and assert on what actually happens.
This phase exists because static review reliably misses the class of bug that only
appears when screens, sockets, and the database interact.

## Preconditions

Check before starting. If any fails, **abort the phase** — do not file connection
errors as findings.

| | Check |
|---|---|
| Frontend | `curl -sf -o /dev/null http://localhost:15173` |
| Backend | `curl -sf -o /dev/null http://localhost:13101/health \|\| curl -sf -o /dev/null http://localhost:13101` |
| Containers | `docker ps --filter name=something2 --format '{{.Names}}'` lists frontend, backend, db, redis |

## Credentials

Admin credentials are `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env`. Read them
at runtime:

```bash
grep -E '^ADMIN_(USERNAME|PASSWORD)=' .env
```

**Never** write a credential into a finding, a commit, a screenshot description, or
this skill file. Player accounts are registered fresh through the UI.

## Test data policy

The suite has free rein on the dev database, including editing and deleting
existing records, in order to reach real-world states such as deleting a map that
has live players on it. Hand-built dev content may be destroyed; the Phase 0
`pg_dump` is the only recovery path. Confirm that dump exists before Flow B.

## Flow A — auth and authorization

Positive: register a new account, log in, hit `/me`, log out, `logout-all`.

Negative — each of these is a P0 finding if it succeeds:

| Attack | Expected |
|---|---|
| Player token against an admin-only route | `403` |
| `{"role": "admin"}` in the register body | account created as `player` |
| JWT with the signature byte-flipped | `401` |
| JWT with `exp` in the past | `401` |
| Token reused after `logout-all` | `401` |
| Login with a wrong password | `401`, and no token issued |
| Login attempted 20 times in a row | rate limited, not 20 × `401` |

Drive the negative set with `evaluate_script` issuing `fetch` from the page origin,
so cookies and headers match a real client.

## Flow B — admin CRUD

For each of Maps, Tile types, Entity types, Item types:

1. Create with valid input → appears in the list without a manual reload.
2. Create with a duplicate name → a visible error, not a silent failure or a crash.
3. Create with empty required fields → validation blocks it client-side AND the API
   rejects it if called directly.
4. Create with a 10 000-character name → rejected, not truncated silently or 500.
5. Edit → the change is visible in the list and survives a reload.
6. Delete → gone from the list, and any dependent view degrades gracefully rather
   than crashing.
7. Asset upload and sprite-generation trigger → the job is accepted, the UI reflects
   its state, and a failure surfaces as an error rather than a spinner forever.

Watch `list_console_messages` after every step. An uncaught exception during a
normal CRUD operation is at least P1.

## Flow C — game loop

1. Enter the game. Assert the canvas renders and no console errors accumulate.
2. Move in all four directions. Assert the camera follows and position persists.
3. Walk into a wall. Assert collision holds and the player does not tunnel.
4. Take a doorway to another map. Assert the transition completes, tile defs match
   the destination, and the return trip works.
5. Cross a chunk seam. Assert no visual gap and no duplicate entities.
6. Kill the socket (`evaluate_script` closing the WebSocket). Assert the client
   reconnects and state resynchronises rather than silently freezing.
7. Open a second page as a second account on the same map. Assert each sees the
   other move.

## Flow D — combat, items, economy

1. Attack a creature. Assert damage applies and the VFX renders.
2. Die. Assert respawn works and inventory survives per the design.
3. Kill a creature, assert loot drops, pick it up, assert inventory gains exactly one.
4. Equip and unequip. Assert stats change and survive a reload.
5. Buy from a merchant with sufficient gold. Assert gold decreases by the price.
6. Buy with insufficient gold → rejected server-side.

Abuse cases — each is a P0 if it succeeds:

| Attack | Expected |
|---|---|
| Buy with `quantity: -5` | rejected; gold does not increase |
| Sell with a client-supplied price | server price wins |
| Two simultaneous pickups of one drop | exactly one inventory gain |
| Buy an item the merchant does not stock | rejected |
| Equip an item not in inventory | rejected |

## Arbitrating static findings

For every finding already in `findings.json` with `source: 'static'` whose
`verification` names a browser check, run that check.

- Confirmed → leave the severity, append `confirmed in browser` to `verification`.
- Blocked upstream → set `status: 'demoted'`, `severity: 'P3'`, and record in
  `verification` what actually blocked it.

This is the safeguard against an audit that inflates its own severity counts. Use
it honestly: a static P0 that turns out to be unreachable is a *good* outcome to
report, not a loss.

## Flake policy

If a browser assertion fails, retry it once. If the second attempt does not
reproduce, mark the finding `status: 'unverified'` and do not file it. `reconcile`
skips unverified findings by design. An unreproducible finding in the tracker is
worse than no finding.

## Output

- Emit browser findings through `store.merge` with `source: 'browser'`, exactly as
  `audit-static` does.
- Write `docs/audits/2026-07-24/browser-run.md`: per flow, what was asserted, what
  was observed, and which static findings were confirmed or demoted.
- Commit both.
````

- [ ] **Step 2: Smoke-test the preconditions block**

Run: `curl -sf -o /dev/null http://localhost:15173 && echo frontend-ok; docker ps --filter name=something2 --format '{{.Names}}'`
Expected: `frontend-ok` and a list including `something2-frontend-1`, `something2-backend-1`, `something2-db-1`, `something2-redis-1`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/audit-browser/SKILL.md
git commit -m "feat(audit): audit-browser skill"
```

---

### Task 9: plane-sync skill

**Files:**
- Create: `.claude/skills/plane-sync/SKILL.md`

**Interfaces:**
- Consumes: `tools/audit/bin/sync.js`, `docs/audits/2026-07-24/plane-bootstrap.md`.
- Produces: a skill that syncs findings to Plane and closes tasks as findings are fixed.

- [ ] **Step 1: Write the skill**

`.claude/skills/plane-sync/SKILL.md`:

````markdown
---
name: plane-sync
description: Use when pushing something2 audit findings into Plane as work items, or closing Plane tasks as findings are fixed. Idempotent by fingerprint.
---

# Plane Sync

Mirror `findings.json` into Plane. One finding, one task, forever — re-running the
audit updates its tasks instead of duplicating them.

## Constants

- Project `Something2` / `SOMET`, UUID `5af54080-02ab-4ce8-8473-0b20632e0460`
- Workspace slug `something2`
- Epic and label UUIDs: read from `docs/audits/2026-07-24/plane-bootstrap.md`
- Priority map: `P0→urgent`, `P1→high`, `P2→medium`, `P3→low`
- Done state: `e1cbace7-9999-4847-a54b-6d3f248c6dfe`

Two operational facts that cost time when forgotten:

- **Cloudflare rejects the default Node/Python User-Agent** with a 403 carrying
  error code 1010. The client sends `curl/8.5.0`. If you write an ad-hoc request,
  send one too.
- **The modules feature is disabled** in this workspace. Grouping is Epic + Label.
  Do not try to create a module.

## Running a sync

Always dry-run first. The dry run is how you catch a bad merge before it becomes
ninety wrong tasks:

```bash
cd tools/audit
node bin/sync.js --findings ../../docs/audits/2026-07-24/findings.json \
  --epic "$AUDIT_EPIC_ID" --dry-run
```

Read the counts. `created` on a first run should equal the number of findings with
status other than `unverified`. `created` on any later run should be zero unless
new findings were genuinely added.

Then run for real by dropping `--dry-run`. The tool writes `plane_id` back into
`findings.json`; **commit that file afterwards** — it is what makes the next sync
idempotent.

## Closing a task

Set the finding's `status` to `fixed` in `findings.json`, then sync. `reconcile`
patches the issue to the Done state. Do not close tasks by hand in the Plane UI —
`findings.json` is the source of truth, and a hand-closed task will be reopened in
spirit by the next sync's drift check.

## Recovering from a partial sync

A sync interrupted mid-run leaves some findings with a `plane_id` and some without.
This is safe: re-run it. Findings that already have an id are skipped or patched;
findings without one are created.

If the API returns a 403 with `1010`, the User-Agent is wrong. If it returns 401,
the key in `.mcp.json` has rotated.

## Never

- Never file a finding with `status: 'unverified'`. `reconcile` already skips them.
- Never edit a task's title or body in the Plane UI; the drift check will overwrite it.
- Never commit the API key.
````

- [ ] **Step 2: Verify the dry-run path works end to end**

With an empty findings file:

```bash
cd tools/audit
echo '{"version":1,"findings":[]}' > /tmp/empty-findings.json
node bin/sync.js --findings /tmp/empty-findings.json --epic "$AUDIT_EPIC_ID" --dry-run
```

Expected: JSON output with `"created": 0, "total": 0` and exit code 0. This proves
the API key is readable, the label exists, and the network path works.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/plane-sync/SKILL.md
git commit -m "feat(audit): plane-sync skill"
```

---

### Task 10: audit-cycle orchestrator skill

**Files:**
- Create: `.claude/skills/audit-cycle/SKILL.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: the three skills above.
- Produces: `/audit-cycle [surface]` — the full loop with phase gates.

- [ ] **Step 1: Write the orchestrator skill**

`.claude/skills/audit-cycle/SKILL.md`:

````markdown
---
name: audit-cycle
description: Use when running or re-running the full something2 audit — baseline, static audit, browser verification, Plane sync, and the fix loop. Accepts an optional surface name to scope the run.
---

# Audit Cycle

Sequences `audit-static`, `audit-browser`, and `plane-sync`, and owns the gates
between them. This skill holds no audit logic of its own — if you find yourself
adding a lens or a flow here, it belongs in the skill that owns that phase.

## Phases

```
0  baseline      → stack health, test/lint baseline, DB snapshot
1  static audit  → audit-static, per surface
2  browser suite → audit-browser, four flows, arbitrates phase 1
3  plane sync    → plane-sync, dry-run then real
4  fix loop      → branch audit-hardening, one commit per task, P0→P3
```

## Gates

Do not cross a gate until its condition holds. Each exists because skipping it
produces work that has to be redone.

| Gate | Condition |
|---|---|
| 0 → 1 | `baseline.md` exists and records every currently-failing test by name. Without it, a pre-existing failure gets blamed on a fix. |
| 1 → 2 | Every finding passes `validate()`. Run the validator; do not eyeball it. |
| 2 → 3 | Every static finding whose `verification` names a browser check has been run and is confirmed or demoted. |
| 3 → 4 | A second `--dry-run` sync reports `created: 0`. If it does not, the file was mutated after the real sync and the tracker is already drifting. |

## Phase 0 — baseline

```bash
cd backend && npm test 2>&1 | tail -30
cd ../frontend && npm test 2>&1 | tail -30
cd ../frontend && npm run lint 2>&1 | tail -30
docker exec something2-sprite-gen-1 pytest -q 2>&1 | tail -20
```

Record every failure by name in `docs/audits/2026-07-24/baseline.md`. Then snapshot
the database:

```bash
docker exec something2-db-1 pg_dump -U postgres game_db > "$SCRATCHPAD/game_db-pre-audit.sql"
```

The browser phase has free rein on this database. The dump is the only recovery
path for hand-built dev content.

## Phase 1 — static audit

Invoke `audit-static` once per surface, committing after each. Six surfaces:
`backend-api`, `backend-authority`, `frontend-admin`, `frontend-game`,
`sprite-gen`, `infra`.

Validate before leaving the phase:

```bash
cd tools/audit && node -e "
const store = require('./lib/store.js');
const { validate } = require('./lib/finding.js');
const doc = store.load('../../docs/audits/2026-07-24/findings.json');
const bad = doc.findings.filter((f) => validate(f).length);
for (const f of bad) console.log(f.id, validate(f).join('; '));
console.log('findings:', doc.findings.length, 'invalid:', bad.length);
process.exit(bad.length ? 1 : 0);
"
```

## Phase 2 — browser suite

Invoke `audit-browser`. Abort the phase rather than filing findings if the stack is
not responding.

## Phase 3 — Plane sync

Invoke `plane-sync`. Dry-run, read the counts, then run for real, then commit
`findings.json` with its new `plane_id` values.

## Phase 4 — fix loop

See the fix loop section of the implementation plan at
`docs/superpowers/plans/2026-07-24-codebase-audit-cycle.md`. In short: branch
`audit-hardening`, work P0 → P3, one commit per Plane task, failing test first
where testable, full suite green before crossing a severity band.

## Scoping

`/audit-cycle backend-api` runs phases 1 and 3 for that surface only, skipping the
baseline and the browser suite. Use it after fixing a surface to confirm the
findings closed.

`/audit-cycle` with no argument runs everything.

## Re-running later

The cycle is designed to be re-run against a changed codebase. Fingerprints are
computed from surface, file basename, lens, and normalised claim — deliberately not
the line number — so a fix that shifts code does not resurrect its own finding as a
new one. Re-running produces: new findings created, changed findings patched, fixed
findings closed.
````

- [ ] **Step 2: Add the cycle to the agent index**

In `AGENTS.md`, under `## Project context`, add:

```markdown
- [docs/superpowers/specs/2026-07-24-codebase-audit-cycle-design.md](docs/superpowers/specs/2026-07-24-codebase-audit-cycle-design.md) — the audit cycle; re-run it with the `audit-cycle` skill
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/audit-cycle/SKILL.md AGENTS.md
git commit -m "feat(audit): audit-cycle orchestrator skill"
```

---

### Task 11: Execute Phase 0 — baseline

**Files:**
- Create: `docs/audits/2026-07-24/baseline.md`

**Interfaces:**
- Consumes: `audit-cycle` Phase 0.
- Produces: `baseline.md`, and a database dump in the scratchpad.

- [ ] **Step 1: Capture the test and lint baseline**

Run each of the four commands in the Phase 0 block of the `audit-cycle` skill.
Record in `baseline.md`, per suite: the command, the pass/fail counts, and the full
name of every failing test.

- [ ] **Step 2: Snapshot the database**

Run the `pg_dump` command from the Phase 0 block. Verify the dump is non-trivial:

Run: `wc -c "$SCRATCHPAD/game_db-pre-audit.sql"`
Expected: a byte count well above 1000

- [ ] **Step 3: Record the environment**

Append to `baseline.md`: `git rev-parse HEAD`, `node -v`, and the output of
`docker ps --filter name=something2 --format '{{.Names}}\t{{.Status}}'`.

- [ ] **Step 4: Commit**

```bash
git add docs/audits/2026-07-24/baseline.md
git commit -m "chore(audit): capture pre-audit baseline"
```

---

### Task 12: Execute Phase 1 — static audit

This is investigative work, not code generation. It has no TDD cycle; its
deliverable is a validated findings file and its gate is the validator.

**Files:**
- Modify: `docs/audits/2026-07-24/findings.json`

**Interfaces:**
- Consumes: `audit-static` skill.
- Produces: findings for all six surfaces, all passing `validate()`.

- [ ] **Step 1: Audit `backend-api`**

Invoke `audit-static` for `backend-api`. Commit: `chore(audit): findings for backend-api (N)`.

- [ ] **Step 2: Audit `backend-authority`**

Invoke `audit-static` for `backend-authority`. The standing question for this
surface is "what happens if the client lies about this value". Commit.

- [ ] **Step 3: Audit `frontend-admin`**

Invoke `audit-static` for `frontend-admin`. The four admin panels
(`EntityTypesAdmin.jsx`, `ItemTypesAdmin.jsx`, `TileTypesAdmin.jsx`,
`MapsAdmin.jsx`) total ~2 800 lines and are the most likely home for drifted
duplication — check whether their CRUD paths have already diverged in behaviour
before reporting them as one DRY finding. Commit.

- [ ] **Step 4: Audit `frontend-game`**

Invoke `audit-static` for `frontend-game`. `RenderSystem.js` (943 lines) and
`Game.js` (881 lines) are the largest files in the project; report their size only
where you can name a change it blocks. Commit.

- [ ] **Step 5: Audit `sprite-gen`**

Invoke `audit-static` for `sprite-gen`. Commit.

- [ ] **Step 6: Audit `infra`**

Invoke `audit-static` for `infra`. Include: whether `.env` is git-ignored and
whether any secret has ever been committed (`git log --all -p -- .env | head`),
which ports are bound to `0.0.0.0` versus `127.0.0.1`, and migration timestamp
ordering across branches. Commit.

- [ ] **Step 7: Run the Phase 1 → 2 gate**

Run the validator from the `audit-cycle` skill's Phase 1 section.
Expected: exit code 0, `invalid: 0`

- [ ] **Step 8: Report the finding distribution**

Run: `cd tools/audit && node -e "
const doc = require('./lib/store.js').load('../../docs/audits/2026-07-24/findings.json');
const by = (k) => doc.findings.reduce((a, f) => ((a[f[k]] = (a[f[k]] || 0) + 1), a), {});
console.log('total', doc.findings.length);
console.log('severity', by('severity'));
console.log('surface', by('surface'));
console.log('lens', by('lens'));
"`
Expected: a distribution printed. Report it to the user before proceeding — a run
where every finding is P0, or where one lens produced none at all, indicates a
miscalibrated pass rather than a remarkable codebase.

---

### Task 13: Execute Phase 2 — browser suite

**Files:**
- Create: `docs/audits/2026-07-24/browser-run.md`
- Modify: `docs/audits/2026-07-24/findings.json`

**Interfaces:**
- Consumes: `audit-browser` skill.
- Produces: browser findings, plus confirmations and demotions of static findings.

- [ ] **Step 1: Verify preconditions**

Run the three precondition checks from the `audit-browser` skill. If any fails,
bring the stack up with `make up` and retry. If it still fails, stop and report —
do not file connection errors as findings.

- [ ] **Step 2: Verify the database dump exists**

Run: `ls -l "$SCRATCHPAD/game_db-pre-audit.sql"`
Expected: the file from Task 11 exists. This phase can destroy dev content; do not
start without it.

- [ ] **Step 3: Run Flow A — auth and authorization**

Execute every positive and negative case in the skill's Flow A table. Record each
result in `browser-run.md`.

- [ ] **Step 4: Run Flow B — admin CRUD**

Execute all seven checks against each of the four admin panels.

- [ ] **Step 5: Run Flow C — game loop**

Execute all seven checks.

- [ ] **Step 6: Run Flow D — combat, items, economy**

Execute the six positive checks and all five abuse cases.

- [ ] **Step 7: Arbitrate the static findings**

For every `source: 'static'` finding whose `verification` names a browser check,
run it and mark the finding confirmed or demoted per the skill.

- [ ] **Step 8: Run the validator and commit**

Run the Phase 1 gate validator again — browser findings must pass it too.
Expected: exit code 0, `invalid: 0`

```bash
git add docs/audits/2026-07-24/findings.json docs/audits/2026-07-24/browser-run.md
git commit -m "chore(audit): browser verification pass"
```

- [ ] **Step 9: Report confirmations and demotions**

Report to the user: how many static findings were confirmed, how many demoted, and
how many new findings the browser found that static review missed. That last number
is the measure of whether this phase earned its cost.

---

### Task 14: Execute Phase 3 — Plane sync

**Files:**
- Modify: `docs/audits/2026-07-24/findings.json`

**Interfaces:**
- Consumes: `plane-sync` skill, epic id from Task 6.
- Produces: one Plane task per finding under epic `K`, with `plane_id` written back.

- [ ] **Step 1: Dry run**

```bash
cd tools/audit
node bin/sync.js --findings ../../docs/audits/2026-07-24/findings.json \
  --epic "$AUDIT_EPIC_ID" --dry-run
```

Expected: `created` equals the count of findings whose status is not `unverified`;
`updated`, `closed` are 0.

- [ ] **Step 2: Report the plan and confirm**

Report the counts to the user before creating tasks. Creating ninety tasks in the
wrong project is tedious to undo.

- [ ] **Step 3: Real sync**

```bash
cd tools/audit
node bin/sync.js --findings ../../docs/audits/2026-07-24/findings.json \
  --epic "$AUDIT_EPIC_ID"
```

Expected: the same `created` count as the dry run.

- [ ] **Step 4: Verify idempotency — the Phase 3 → 4 gate**

```bash
cd tools/audit
node bin/sync.js --findings ../../docs/audits/2026-07-24/findings.json \
  --epic "$AUDIT_EPIC_ID" --dry-run
```

Expected: `"created": 0, "updated": 0, "closed": 0`

If `created` is non-zero, the write-back failed; do not run the real sync again or
every task will be duplicated. Investigate first.

- [ ] **Step 5: Verify in Plane**

Use the Plane MCP tool `list_work_items` with `pql: 'childOf("SOMET-<epic id>")'`.
Expected: the child count equals the created count, and priorities are distributed
across urgent/high/medium/low rather than all landing on one value.

- [ ] **Step 6: Commit**

```bash
git add docs/audits/2026-07-24/findings.json
git commit -m "chore(audit): sync findings to Plane epic K"
```

---

### Task 15: Execute Phase 4 — fix loop

The fix loop cannot be enumerated in advance: its tasks are the findings, which do
not exist until Task 12 and Task 13 run. What follows is the procedure each task
follows, plus the ordering and the gates.

**Files:**
- Modify: whatever the finding names.
- Modify: `docs/audits/2026-07-24/findings.json` (status transitions)

**Interfaces:**
- Consumes: Plane epic `K` children, `findings.json`.
- Produces: one commit per finding on `audit-hardening`, each Plane task closed.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b audit-hardening
```

- [ ] **Step 2: Order the work**

Work strictly P0 → P1 → P2 → P3. Within a band, group by surface so related edits
land together. List the current band's tasks before starting it:

```bash
cd tools/audit && node -e "
const doc = require('./lib/store.js').load('../../docs/audits/2026-07-24/findings.json');
const band = process.argv[1];
for (const f of doc.findings.filter((x) => x.severity === band && x.status === 'open')) {
  console.log(f.id, f.plane_key || '', f.surface, '-', f.claim);
}
" P0
```

- [ ] **Step 3: Fix one finding (repeat per finding)**

For each finding in the current band:

1. Read the finding's `failure_scenario` and `proposed_fix`.
2. Where the failure is unit-testable, write a test that reproduces it and run it to
   confirm it fails. A fix without a failing test first is a fix you cannot prove
   worked.
3. Apply the fix. Prefer the `proposed_fix`; if it turns out to be wrong, fix the
   problem correctly and update the finding's `proposed_fix` to match reality.
4. Run the targeted tests.
5. For any finding whose failure scenario is a UI or flow behaviour, re-run its
   browser check from `audit-browser`.
6. Set the finding's `status` to `fixed` in `findings.json`.
7. Commit:

```bash
git add <changed files> docs/audits/2026-07-24/findings.json
git commit -m "fix(<scope>): <summary> [SOMET-NNN]"
```

8. Sync to close the Plane task:

```bash
cd tools/audit && node bin/sync.js \
  --findings ../../docs/audits/2026-07-24/findings.json --epic "$AUDIT_EPIC_ID"
```

- [ ] **Step 4: Handle a fix that breaks a test**

Revert that single commit, set the finding's `status` back to `open`, record what
broke in the finding's `verification` field, and move to the next finding. One bad
fix does not stall the loop.

```bash
git revert --no-edit HEAD
```

- [ ] **Step 5: Gate each severity band**

Before starting the next band, run the full suite:

```bash
cd backend && npm test && cd ../frontend && npm test && npm run lint
```

Expected: no failures beyond those recorded in `baseline.md`. Compare against that
file explicitly — do not rely on memory of what was already broken.

- [ ] **Step 6: Report at each band boundary**

Report to the user: findings fixed, findings reverted, tests added, and any finding
whose `proposed_fix` turned out to be wrong. Do not merge or push. When the last
band is done, ask how they want the branch integrated.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: Phase 0 → Task 11; Phase 1 →
Tasks 7 and 12; Phase 2 → Tasks 8 and 13; Phase 3 → Tasks 1–6, 9, 14; Phase 4
(skills) → Tasks 7–10; Phase 5 (fix loop) → Task 15. The finding record, severity
scale, verification bar, fingerprint idempotency, flake policy, and error handling
each appear in the task that implements them.

**Two deliberate departures from the spec, both recorded here:**

1. **Build order is inverted.** The spec numbers the skills as Phase 4; this plan
   builds them in Tasks 7–10, *before* the audit executes in Tasks 12–14. Writing a
   skill after doing the work by hand produces untested prose; writing it first
   means the audit run is itself the skill's test.

2. **Task 6 is new.** The spec assumes REST issue creation can parent to an
   epic-typed work item. That is unverified against the live API, and ninety tasks
   depend on it, so it gets a probe with a recorded fallback.

**Placeholder scan.** No TBD, TODO, or "similar to Task N" references. Every code
step contains complete code. The one genuinely unenumerable part — which findings
exist — is structural, not a placeholder: Task 15 gives the per-finding procedure
in full, and the findings themselves are produced by Tasks 12 and 13.

**Type consistency.** `fingerprint`, `validate`, `normalizeClaim`, `stripLine`
(finding.js); `emptyDoc`, `load`, `save`, `nextId`, `merge`, `MUTABLE` (store.js);
`PlaneClient` with `request`, `paginate`, `listLabels`, `createLabel`, `listIssues`,
`createIssue`, `updateIssue`, `deleteIssue` (plane.js); `renderTitle`, `renderBody`,
`snapshot`, `reconcile` (sync.js). Every name used in a later task is defined in an
earlier one. `config.js` exports `PLANE`, `SEVERITIES`, `PRIORITY_BY_SEVERITY`,
`LENSES`, `SURFACES`, `STATUSES`, `SOURCES` — all consumed as named.
