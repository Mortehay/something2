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

// Every test gets its own temp dir, tracked here and removed in `after()` —
// otherwise every run of this suite leaks a directory under the OS temp dir
// forever.
const tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  tmpDirs.push(dir);
  return dir;
}

function tmpPath() {
  return path.join(tmpDir(), 'findings.json');
}

test.after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load returns an empty doc when the file is absent', () => {
  // A path inside a temp dir we control (and never write to), not a fixed
  // shared path under os.tmpdir() — a fixed path flips this test to failing
  // if anything else on the machine ever creates a file at that name.
  const missing = path.join(tmpDir(), 'definitely-absent-findings.json');
  const doc = store.load(missing);
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

test('setStatus sets a valid status on the matching finding', () => {
  const { doc } = store.merge(store.emptyDoc(), [incoming()]);
  const id = doc.findings[0].id;
  store.setStatus(doc, id, 'fixed');
  assert.strictEqual(doc.findings[0].status, 'fixed');
});

test('setStatus rejects an unknown status', () => {
  const { doc } = store.merge(store.emptyDoc(), [incoming()]);
  const id = doc.findings[0].id;
  assert.throws(() => store.setStatus(doc, id, 'not-a-real-status'), /status/);
});

test('setStatus throws on an unknown id', () => {
  const { doc } = store.merge(store.emptyDoc(), [incoming()]);
  assert.throws(() => store.setStatus(doc, 'F-999', 'fixed'), /F-999/);
});

test('merge still does not change status; setStatus remains the only path', () => {
  const first = store.merge(store.emptyDoc(), [incoming()]);
  const id = first.doc.findings[0].id;
  store.setStatus(first.doc, id, 'fixed');

  const second = store.merge(first.doc, [incoming({ status: 'demoted', severity: 'P1' })]);
  assert.strictEqual(second.doc.findings[0].status, 'fixed');
  assert.strictEqual(second.doc.findings[0].severity, 'P1');
});

// Regression coverage for the fingerprint-wording gap: fingerprint's claim
// component is otherwise-verbatim (see finding.js's normalizeClaim), so an
// LLM-driven re-audit describing the same defect in different words gets a
// different fingerprint and merge treats it as brand new. Loosening the
// fingerprint to catch this would risk merging genuinely distinct findings
// (semantic matching is out of scope), so instead `merge` warns rather than
// silently filing a second Plane issue for the same defect.
test('merge reports a near-duplicate in suspected when a new finding shares surface+file+lens with an existing one', () => {
  const first = store.merge(store.emptyDoc(), [
    incoming({ claim: 'DELETE /maps/:id has no admin guard.' }),
  ]);
  assert.deepStrictEqual(first.suspected, []);

  const second = store.merge(first.doc, [
    incoming({ claim: 'DELETE /maps/:id lacks an authorization check.' }),
  ]);

  // Still adds the finding rather than blocking the merge.
  assert.strictEqual(second.doc.findings.length, 2);
  assert.deepStrictEqual(second.added, ['F-002']);
  assert.strictEqual(second.suspected.length, 1);
  assert.deepStrictEqual(second.suspected[0], { newId: 'F-002', existingId: 'F-001' });
});

test('merge does not report a near-duplicate when surface, file, or lens differ', () => {
  const first = store.merge(store.emptyDoc(), [
    incoming({ claim: 'DELETE /maps/:id has no admin guard.' }),
  ]);

  const differentFile = store.merge(first.doc, [
    incoming({ file: 'backend/src/other.js:9', claim: 'Different route, different bug.' }),
  ]);
  assert.deepStrictEqual(differentFile.suspected, []);

  const differentLens = store.merge(first.doc, [
    incoming({ lens: 'dry', claim: 'Duplicated validation logic here.' }),
  ]);
  assert.deepStrictEqual(differentLens.suspected, []);

  const differentSurface = store.merge(first.doc, [
    incoming({ surface: 'frontend-admin', claim: 'Unrelated admin UI issue.' }),
  ]);
  assert.deepStrictEqual(differentSurface.suspected, []);
});

test('merge treats a line-number-only change as the same finding, not a suspected duplicate', () => {
  const first = store.merge(store.emptyDoc(), [incoming({ file: 'backend/src/index.js:42' })]);
  const second = store.merge(first.doc, [incoming({ file: 'backend/src/index.js:915' })]);
  assert.deepStrictEqual(second.suspected, []);
  assert.deepStrictEqual(second.added, []);
});

test('merge returns a document independent of the input; does not mutate the input', () => {
  const before = store.merge(store.emptyDoc(), [incoming({ severity: 'P0' })]).doc;
  const beforeSeverity = before.findings[0].severity;
  const beforeFinding = before.findings[0];

  const after = store.merge(before, [incoming({ severity: 'P1' })]).doc;
  const afterSeverity = after.findings[0].severity;

  // The returned document should have the new severity.
  assert.strictEqual(afterSeverity, 'P1');

  // The original input document's finding should NOT have changed.
  assert.strictEqual(before.findings[0].severity, beforeSeverity);
  assert.strictEqual(before.findings[0].severity, 'P0');

  // The objects should be different (not the same reference).
  assert.notStrictEqual(before.findings[0], after.findings[0]);
});
