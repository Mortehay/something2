'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWatcher, WATCHED_SCRIPTS } = require('./watcher');

const SCRIPTS = path.join('compose', 'orangepi', 'scripts');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-watcher-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fill = (root) => {
    fs.mkdirSync(path.join(root, SCRIPTS), { recursive: true });
    for (const name of WATCHED_SCRIPTS) fs.writeFileSync(path.join(root, SCRIPTS, name), `${name}\n`);
    return root;
  };
  const root = fill(path.join(dir, 'main'));
  const pin = fill(path.join(dir, 'pin'));
  const unitFile = path.join(dir, 'reconcile.service');
  const unit = (workdir) => fs.writeFileSync(unitFile, `[Service]\nType=oneshot\nWorkingDirectory=${workdir}\nExecStart=/usr/bin/env bash x\n`);
  return { root, pin, unitFile, unit };
}

test('no timer installed: nothing to warn about', (t) => {
  const f = fixture(t);
  assert.deepEqual(readWatcher({ root: f.root, unitFile: f.unitFile }), { installed: false, stale: false, files: [] });
});

test('a pin with the same scripts is not stale, whatever commit it sits on', (t) => {
  const f = fixture(t);
  f.unit(f.pin);
  assert.deepEqual(readWatcher({ root: f.root, unitFile: f.unitFile }), { installed: true, stale: false, files: [] });
});

test('a pin whose reconciler differs is stale and names the file', (t) => {
  const f = fixture(t);
  f.unit(f.pin);
  fs.writeFileSync(path.join(f.pin, SCRIPTS, 'reconcile-url.sh'), 'older\n');
  assert.deepEqual(readWatcher({ root: f.root, unitFile: f.unitFile }), { installed: true, stale: true, files: ['reconcile-url.sh'] });
});

test('a timer pointing at a directory that is gone is stale, not healthy', (t) => {
  const f = fixture(t);
  f.unit(path.join(f.pin, 'gone'));
  const w = readWatcher({ root: f.root, unitFile: f.unitFile });
  assert.equal(w.installed, true);
  assert.equal(w.stale, true);
  assert.deepEqual(w.files, WATCHED_SCRIPTS);
});

test('a unit with no working directory cannot be vouched for', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.unitFile, '[Service]\nType=oneshot\n');
  const w = readWatcher({ root: f.root, unitFile: f.unitFile });
  assert.equal(w.installed, true);
  assert.equal(w.stale, true);
});
