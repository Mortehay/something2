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
