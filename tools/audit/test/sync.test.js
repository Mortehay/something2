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
