// SOMET-592: a reconcile merge left a second, stale `claimBatch` and
// `release` in audioJobQueue.js. A later function declaration silently
// replaces an earlier one of the same name (no syntax error in sloppy-mode
// CommonJS), so the phase-aware claim was shadowed and every audio drain
// looped forever, while the file still loaded and most of its tests passed.
//
// This gate reads every backend/src module and fails if one declares the
// same top-level function name twice. "Top-level" is a declaration that
// starts at column 0, which is how this codebase writes module functions;
// nested helpers are indented and never collide this way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const DECL = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function duplicateDeclarations(source) {
  const lines = new Map();
  for (const m of source.matchAll(DECL)) {
    const line = source.slice(0, m.index).split('\n').length;
    lines.set(m[1], [...(lines.get(m[1]) || []), line]);
  }
  return [...lines].filter(([, at]) => at.length > 1).map(([name, at]) => `${name} at lines ${at.join(', ')}`);
}

test('the detector finds a shadowed top-level function (and ignores nested ones)', () => {
  const src = [
    'async function claimBatch(db, n, { phase } = {}) {',
    '  function inner() {}',
    '}',
    'function release(db, ids) {}',
    'async function claimBatch(db, n) {',
    '  function inner() {}',
    '}',
  ].join('\n');
  assert.deepEqual(duplicateDeclarations(src), ['claimBatch at lines 1, 5']);
});

test('no backend/src module declares the same top-level function twice', () => {
  const files = jsFiles(SRC);
  // Anti-vacuity: the walk must actually reach the module that regressed.
  assert.ok(files.some((f) => f.endsWith(path.join('services', 'audioJobQueue.js'))), 'audioJobQueue.js not scanned');
  const found = [];
  for (const f of files) {
    for (const d of duplicateDeclarations(fs.readFileSync(f, 'utf8'))) found.push(`${path.relative(SRC, f)}: ${d}`);
  }
  assert.deepEqual(found, []);
});
