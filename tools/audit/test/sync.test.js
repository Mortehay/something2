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

// Numeric-entity decoder mirroring what Plane's HTML renderer does on read —
// used to assert against the *decoded* form wherever the raw substring would
// legitimately contain characters renderTitle/renderBody now encode.
function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

test('renderTitle carries the finding id, severity, surface and a readable summary as literal characters', () => {
  const title = renderTitle(finding());
  assert.ok(title.includes('F-001'));
  assert.ok(title.includes('P0'));
  assert.ok(title.includes('backend-api'));
  assert.ok(title.includes('authorization'));
});

// Regression coverage for the title-encoding bug: Plane's issue `name` field
// is plain text, not HTML, so it is never decoded on read. A finding whose
// text contains hyphens, apostrophes and parentheses must come through
// renderTitle completely unencoded, or the tracker shows literal "&#45;"
// garbage instead of a readable title.
test('renderTitle emits plain text with no HTML entities, even for hyphens, apostrophes and parentheses', () => {
  const f = finding({
    id: 'F-046',
    surface: 'frontend-game',
    claim: "The Worlds picker's delete-world control (a trash icon) fires without confirmation.",
  });
  const title = renderTitle(f);

  assert.ok(!title.includes('&#'), `title must contain no HTML entities, got: ${title}`);
  assert.ok(title.includes('F-046'));
  assert.ok(title.includes('P0'));
  assert.ok(title.includes('frontend-game'));
  assert.ok(title.includes("The Worlds picker's delete-world control (a trash icon) fires without confirmation."));
});

test('renderBody includes every field a fixer needs', () => {
  const body = renderBody(finding());
  const decoded = decodeEntities(body);
  for (const needle of [
    'backend/src/index.js:42',
    'A player token reaches POST /maps',
    'requireAdmin(pool)',
    'expect 403',
    'security',
  ]) {
    assert.ok(decoded.includes(needle), `decoded body should mention ${needle}`);
  }
});

// Regression coverage for the WAF block established by bisecting F-002: line
// 5 (the Verification field) contains the path-traversal payload `..%2F`
// inside a curl command and alone was enough to trip Cloudflare's 403.
test('renderBody entity-encodes attack-signature text instead of sending it raw', () => {
  const f = finding({
    id: 'F-002',
    verification: 'curl -s "http://localhost:13101/api/tile-jobs/..%2Fcapability"',
  });
  const body = renderBody(f);

  assert.ok(!body.includes('..%2F'), 'raw path-traversal payload must not appear on the wire');
  // '.' -> &#46;, '%' -> &#37;; '2' and 'F' are alphanumeric and stay literal.
  assert.ok(body.includes('&#46;&#46;&#37;2F'), 'the payload should appear entity-encoded instead');
});

test('renderBody round-trips: decoding the entities recovers the original finding text exactly', () => {
  const f = finding({
    id: 'F-002',
    file: 'backend/src/tile-jobs.js:12',
    claim: 'Path traversal via job id: "../../etc/passwd" & <script>alert(1)</script>',
    verification: 'curl -s "http://localhost:13101/api/tile-jobs/..%2Fcapability"',
  });
  const body = renderBody(f);
  const decoded = decodeEntities(body);

  assert.ok(decoded.includes(f.claim), 'decoded body should contain the exact original claim text');
  assert.ok(decoded.includes(f.verification), 'decoded body should contain the exact original verification text');
  assert.ok(decoded.includes(f.file), 'decoded body should contain the exact original file path');
});

test('renderBody keeps the surrounding HTML structure as literal markup', () => {
  const body = renderBody(finding());
  for (const tag of ['<p>', '</p>', '<strong>', '</strong>', '<code>', '</code>', '<em>', '</em>', '&middot;']) {
    assert.ok(body.includes(tag), `body should retain literal ${tag}`);
  }
});

test('renderBody still encodes HTML metacharacters in finding text (no injection regression)', () => {
  const f = finding({
    claim: `<script>alert('xss')</script> & "quoted" <img src=x onerror=alert(1)>`,
  });
  const body = renderBody(f);

  assert.ok(!body.includes("<script>alert('xss')</script>"), 'raw script tag must not appear');
  assert.ok(!/<img[^>]*onerror/.test(body), 'raw injected tag must not appear');

  // Every metacharacter contributed by the claim text must be encoded. Pull
  // just the Claim line back out, strip away the legitimate `&#NN;` entities
  // it should be made of, and confirm nothing raw is left — the surrounding
  // template (e.g. `<p>`) legitimately uses '<' and '>', so this must be
  // scoped to the encoded field, not the whole body.
  const claimLine = body.split('\n').find((line) => line.includes('<strong>Claim:</strong>'));
  const claimValue = claimLine.replace('<p><strong>Claim:</strong> ', '').replace('</p>', '');
  const claimValueWithoutEntities = claimValue.replace(/&#\d+;/g, '');
  for (const raw of ['<', '>', '&', '"', "'"]) {
    assert.ok(!claimValueWithoutEntities.includes(raw), `encoded claim field must not contain raw ${JSON.stringify(raw)} outside of an entity`);
  }

  const decoded = decodeEntities(body);
  assert.ok(decoded.includes(f.claim), 'decoded body should recover the exact original (unsafe) claim text');
});

test('renderBody round-trips a non-ASCII / astral character correctly', () => {
  const f = finding({
    claim: 'Unicode check: café, 日本語, and an emoji \u{1F41B} (bug) in the text.',
  });
  const body = renderBody(f);
  const decoded = decodeEntities(body);

  assert.ok(decoded.includes(f.claim), 'astral and multi-byte characters must round-trip exactly');
  assert.ok(!body.includes('\u{1F41B}'), 'the raw emoji character must not appear unencoded on the wire');
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
  assert.strictEqual(client.patches.length, 0);
});

test('reconcile creates a pre-fixed finding directly into the done state', async () => {
  const client = new FakeClient();
  const doc = { version: 1, findings: [finding({ status: 'fixed', plane_id: null })] };

  const result = await reconcile({ doc, client, epicId: 'epic-1', labelIds: [] });

  assert.strictEqual(client.creates.length, 1);
  assert.strictEqual(client.creates[0].state, PLANE.doneStateId);
  assert.deepStrictEqual(result.closed, ['F-001']);
  assert.deepStrictEqual(result.created, []);
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

// Regression coverage for the Cloudflare burst-limit hit during the first
// live sync (F-001 -> SOMET-165, then a 403 block on the very next write).
// reconcile must space out consecutive writes; read-only calls (listLabels,
// done by the caller before reconcile runs) are out of scope here.
function fakeSleepSpy() {
  const calls = [];
  const impl = async (ms) => {
    calls.push(ms);
  };
  impl.calls = calls;
  return impl;
}

test('reconcile waits delayMs between writes but not before the first one', async () => {
  const client = new FakeClient();
  const doc = {
    version: 1,
    findings: [
      finding({ id: 'F-001', fingerprint: 'a'.repeat(40), claim: 'First problem here.' }),
      finding({ id: 'F-002', fingerprint: 'b'.repeat(40), claim: 'Second problem here.' }),
      finding({ id: 'F-003', fingerprint: 'c'.repeat(40), claim: 'Third problem here.' }),
    ],
  };
  const sleepImpl = fakeSleepSpy();

  await reconcile({ doc, client, epicId: 'epic-1', labelIds: [], delayMs: 750, sleepImpl });

  assert.strictEqual(client.creates.length, 3);
  // 3 writes -> 2 gaps, each the full configured delay; no delay before the
  // very first write.
  assert.deepStrictEqual(sleepImpl.calls, [750, 750]);
});

test('reconcile defaults to a conservative delay when none is given', async () => {
  const client = new FakeClient();
  const doc = {
    version: 1,
    findings: [
      finding({ id: 'F-001', fingerprint: 'a'.repeat(40), claim: 'First problem here.' }),
      finding({ id: 'F-002', fingerprint: 'b'.repeat(40), claim: 'Second problem here.' }),
    ],
  };
  const sleepImpl = fakeSleepSpy();

  await reconcile({ doc, client, epicId: 'epic-1', labelIds: [], sleepImpl });

  assert.strictEqual(sleepImpl.calls.length, 1);
  assert.ok(sleepImpl.calls[0] >= 400 && sleepImpl.calls[0] <= 600, `expected 400-600ms, got ${sleepImpl.calls[0]}`);
});

test('reconcile does not sleep when delayMs is 0', async () => {
  const client = new FakeClient();
  const doc = {
    version: 1,
    findings: [
      finding({ id: 'F-001', fingerprint: 'a'.repeat(40), claim: 'First problem here.' }),
      finding({ id: 'F-002', fingerprint: 'b'.repeat(40), claim: 'Second problem here.' }),
    ],
  };
  const sleepImpl = fakeSleepSpy();

  await reconcile({ doc, client, epicId: 'epic-1', labelIds: [], delayMs: 0, sleepImpl });

  assert.deepStrictEqual(sleepImpl.calls, []);
});

test('reconcile does not sleep during a dry run', async () => {
  const client = new FakeClient();
  const doc = {
    version: 1,
    findings: [
      finding({ id: 'F-001', fingerprint: 'a'.repeat(40), claim: 'First problem here.' }),
      finding({ id: 'F-002', fingerprint: 'b'.repeat(40), claim: 'Second problem here.' }),
    ],
  };
  const sleepImpl = fakeSleepSpy();

  await reconcile({ doc, client, epicId: 'epic-1', labelIds: [], dryRun: true, sleepImpl });

  assert.deepStrictEqual(sleepImpl.calls, []);
});

test('reconcile only throttles between writes, not between skipped or unchanged findings', async () => {
  const client = new FakeClient();
  const doc = {
    version: 1,
    findings: [
      finding({ id: 'F-001', fingerprint: 'a'.repeat(40), claim: 'First problem here.', status: 'unverified' }),
      finding({ id: 'F-002', fingerprint: 'b'.repeat(40), claim: 'Second problem here.' }),
    ],
  };
  const sleepImpl = fakeSleepSpy();

  const result = await reconcile({ doc, client, epicId: 'epic-1', labelIds: [], delayMs: 750, sleepImpl });

  assert.deepStrictEqual(result.skipped, ['F-001']);
  assert.strictEqual(client.creates.length, 1);
  assert.deepStrictEqual(sleepImpl.calls, []);
});
