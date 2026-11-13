'use strict';
// A missing/broken sharp build is an install problem, not 1603 bad images:
// shrinks fail with 'shrinker_unavailable', nothing is logged per row, and a
// batch run stops at the first subject with a run-level error.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SRC = path.join(__dirname, '../src/services');

// Preload that makes require('sharp') throw as if it were not installed.
const NO_SHARP = `
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'sharp') { const e = new Error("Cannot find module 'sharp'"); e.code = 'MODULE_NOT_FOUND'; throw e; }
    return orig.call(this, req, ...rest);
  };
`;

function run(body) {
  return JSON.parse(execFileSync(process.execPath, ['-e', NO_SHARP + body], { encoding: 'utf8' }).trim());
}

test('missing sharp fails every transform with shrinker_unavailable, not bad_image', () => {
  const out = run(`
    const m = require(${JSON.stringify(path.join(SRC, 'imageShrink.js'))});
    const manifest = { cell: [2, 2], frames: { a: [0, 0, 2, 2] } };
    Promise.all([
      m.shrinkImage(Buffer.from('x')),
      m.shrinkSheet(Buffer.from('x'), manifest, { scale: 0.5 }),
      m.shrinkStrip(Buffer.from('x'), 1, { scale: 0.5 }),
    ].map((p) => p.then(() => 'ok', (e) => e instanceof m.ShrinkError ? e.code : 'other:' + e.message)))
      .then((codes) => console.log(JSON.stringify(codes)));
  `);
  assert.deepEqual(out, ['shrinker_unavailable', 'shrinker_unavailable', 'shrinker_unavailable']);
});

test('a run stops at the first subject when sharp is missing and counts no row as failed', () => {
  const out = run(`
    const vpath = require.resolve(${JSON.stringify(path.join(SRC, 'imageVariants.js'))});
    const { ShrinkError } = require(${JSON.stringify(path.join(SRC, 'imageShrink.js'))});
    let calls = 0;
    require.cache[vpath] = { id: vpath, filename: vpath, loaded: true, exports: {
      shrinkSubject: async () => { calls += 1; throw new ShrinkError('shrinker_unavailable', 'sharp failed to load'); },
      undoSubject: async () => { throw new Error('unused'); },
      invalidateServeMap: () => {},
    } };
    const r = require(${JSON.stringify(path.join(SRC, 'imageShrinkRun.js'))});
    const subjects = [1, 2, 3].map((i) => ({ table: 't', key: String(i), column: 'c' }));
    r.startRun(null, null, { op: 'shrink', subjects }).then(() => {
      const wait = () => { const v = r.getRun(); if (v.status === 'running') return setTimeout(wait, 5);
        console.log(JSON.stringify({ calls, status: v.status, done: v.done, failed: v.failed, error: v.error })); };
      wait();
    });
  `);
  assert.equal(out.calls, 1);
  assert.equal(out.status, 'done');
  assert.equal(out.failed, 0);
  assert.match(out.error, /sharp/);
});
