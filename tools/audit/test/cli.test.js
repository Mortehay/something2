'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store.js');
const { parseArgs, syncDocument } = require('../bin/sync.js');

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

function tmpPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-')), 'findings.json');
}

// Fake client that succeeds for the first `failAfter` createIssue calls, then
// throws on the next one — simulating a rate limit or dropped connection
// partway through a large sync.
class FlakyClient {
  constructor(failAfter) {
    this.failAfter = failAfter;
    this.seq = 0;
    this.creates = [];
  }
  async createIssue(body) {
    this.seq += 1;
    if (this.seq > this.failAfter) {
      throw new Error('Plane POST /issues/ failed: 429 rate limited');
    }
    this.creates.push(body);
    return { id: `issue-${this.seq}`, sequence_id: 200 + this.seq };
  }
  async updateIssue(id, patch) {
    return { id };
  }
}

test('parseArgs rejects an unknown flag', () => {
  assert.throws(
    () => parseArgs(['--bogus', 'value', '--findings', 'f.json', '--epic', 'e1']),
    /unknown flag: --bogus/
  );
});

test('parseArgs rejects --findings given with no value', () => {
  assert.throws(
    () => parseArgs(['--epic', 'e1', '--findings']),
    /--findings requires a value/
  );
});

test('parseArgs accepts a well-formed argument list', () => {
  const args = parseArgs(['--findings', 'f.json', '--epic', 'e1', '--dry-run']);
  assert.deepStrictEqual(args, { dryRun: true, findings: 'f.json', epicId: 'e1' });
});

test('parseArgs accepts a well-formed argument list without --dry-run', () => {
  const args = parseArgs(['--findings', 'f.json', '--epic', 'e1']);
  assert.deepStrictEqual(args, { dryRun: false, findings: 'f.json', epicId: 'e1' });
});

// Finding 1 regression test: a mid-sync failure must not lose the progress
// reconcile already made. Before the try/finally fix in syncDocument, the
// on-disk file was untouched on a throw, so a re-run would recreate every
// issue that had already been made in Plane.
test('syncDocument persists plane_ids for findings that succeeded before a later one throws', async () => {
  const p = tmpPath();
  const { doc } = store.merge(store.emptyDoc(), [
    finding({ fingerprint: 'a'.repeat(40), claim: 'First problem here.' }),
    finding({ fingerprint: 'b'.repeat(40), claim: 'Second problem here.' }),
    finding({ fingerprint: 'c'.repeat(40), claim: 'Third problem here.' }),
  ]);
  store.save(p, doc);

  const client = new FlakyClient(2); // succeeds for findings 1 and 2, throws on 3

  await assert.rejects(
    () => syncDocument({
      findingsPath: p,
      client,
      epicId: 'epic-1',
      labelIds: ['label-k'],
      dryRun: false,
    }),
    /429 rate limited/
  );

  const onDisk = store.load(p);
  assert.strictEqual(onDisk.findings[0].plane_id, 'issue-1');
  assert.strictEqual(onDisk.findings[1].plane_id, 'issue-2');
  assert.strictEqual(onDisk.findings[2].plane_id, null);
});

test('syncDocument rejects rather than swallowing the underlying error', async () => {
  const p = tmpPath();
  const { doc } = store.merge(store.emptyDoc(), [finding()]);
  store.save(p, doc);

  const client = new FlakyClient(0); // throws on the very first createIssue

  let threw = false;
  try {
    await syncDocument({ findingsPath: p, client, epicId: 'epic-1', labelIds: [], dryRun: false });
  } catch (error) {
    threw = true;
    assert.match(error.message, /429 rate limited/);
  }
  assert.strictEqual(threw, true, 'syncDocument must reject, not swallow, a reconcile failure');
});

test('a dry run never calls the client, so it cannot leave a partial write behind', async () => {
  const p = tmpPath();
  const { doc } = store.merge(store.emptyDoc(), [finding()]);
  store.save(p, doc);
  const before = fs.readFileSync(p, 'utf8');

  const client = new FlakyClient(0);
  await syncDocument({ findingsPath: p, client, epicId: 'epic-1', labelIds: [], dryRun: true });

  assert.strictEqual(client.seq, 0);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
});
