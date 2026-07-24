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
