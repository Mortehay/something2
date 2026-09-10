// Cross-boundary guard: no frontend call site may GET a GUARDED route without
// attaching credentials.
//
// Why this exists. `apiFetch` in frontend/src/games/something2/src/js/net/auth.js
// is `fetch` plus 401 bookkeeping -- it does NOT attach the token. Credentials
// come only from an explicit `authHeaders()` in the call's options. Nothing
// enforced the pairing, so the failure mode was: guard a route on the backend,
// every backend test stays green, and the feature 401s in the browser. That
// happened FOUR times in one sitting -- useMapGraph.js and useMapsAdmin.js
// (SOMET-555), then chunkFetcher.js and worldPreviewClient.js (SOMET-559).
//
// The backend half is already covered: auth_protection.test.js walks the router
// and fails on any undeclared unguarded GET. This is the other half -- it walks
// the SAME router for routes that ARE guarded, then reads the frontend sources
// as text and fails if one of them fetches such a route with no authHeaders().
//
// Text, not import: the frontend is a separate ESM package and vitest there runs
// in a node env with no DOM, so the reliable direction is backend-reads-frontend
// (same approach as village_form_defaults.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('./helpers/auth.js');
const { app } = require('../src/index.js');

const FRONTEND_SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

function routerStack() {
  const r = app._router || app.router;
  return (r && r.stack) || [];
}

// Every GET route that carries an auth guard, as its Express path pattern.
function guardedGetPaths() {
  const out = [];
  for (const layer of routerStack()) {
    if (!layer.route || !layer.route.methods.get) continue;
    const guarded = layer.route.stack.some((s) => s.handle && s.handle.isAuthGuard);
    if (guarded && String(layer.route.path).startsWith('/api')) out.push(layer.route.path);
  }
  return out;
}

// Turn an Express path into a matcher for a frontend URL string. The frontend
// writes template literals, so a `:param` segment shows up as `${something}`,
// and the origin prefix (`${API_URL}`, `${API}`, or nothing) varies by file.
function pathMatcher(routePath) {
  const escaped = routePath
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) return '(?:\\$\\{[^}]*\\}|[^/]*)';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  // Anchor the end so /api/worlds does not match /api/worlds/:id/chunk.
  return new RegExp(escaped + '(?:[?`\'"]|$)');
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      out.push(...sourceFiles(p));
    } else if (/\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

// Extract each fetch()/apiFetch() call's argument text by matching parens, so a
// call spanning several lines is read whole rather than one line at a time.
function fetchCalls(source) {
  const calls = [];
  const re = /\b(?:api)?[fF]etch(?:Impl)?\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    calls.push({ text: source.slice(m.index + m[0].length, i - 1), index: m.index });
  }
  return calls;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

// Resolve `fetchImpl(url, ...)` where `url` was built on an earlier line.
// Without this the scanner sees no /api/ literal in the call arguments and
// silently matches nothing -- which is exactly how the first version of this
// test passed while chunkFetcher.js, the hottest guarded route in the app, had
// its credentials stripped. A guard that inspects only the call site goes blind
// the moment a caller hoists its URL into a variable, and that is the common
// style here, not an edge case.
function withResolvedUrlVars(source, callText) {
  const firstArg = callText.split(',')[0].trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(firstArg)) return callText;
  const assign = new RegExp(
    `(?:const|let|var)\\s+${firstArg}\\s*=\\s*(\`[^\`]*\`|['"][^'"]*['"])`,
  ).exec(source);
  return assign ? `${callText} /*${firstArg}=*/ ${assign[1]}` : callText;
}

// A call is only interesting if it is a real call, not prose in a comment that
// happens to mention apiFetch(). Comments are stripped before scanning.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

test('every frontend GET of a guarded route attaches credentials', () => {
  const guarded = guardedGetPaths();
  assert.ok(guarded.length > 0, 'sanity: the router must expose at least one guarded GET');
  const matchers = guarded.map((p) => ({ path: p, re: pathMatcher(p) }));

  const offenders = [];
  for (const file of sourceFiles(FRONTEND_SRC)) {
    const raw = fs.readFileSync(file, 'utf8');
    const source = stripComments(raw);
    for (const call of fetchCalls(source)) {
      // Only GETs: a call with `method:` is a mutation, and those are covered by
      // the mutation half of auth_protection.test.js on the backend side.
      if (/\bmethod\s*:/.test(call.text)) continue;
      if (/authHeaders/.test(call.text)) continue;
      const text = withResolvedUrlVars(source, call.text);
      const hit = matchers.find((m) => m.re.test(text));
      if (!hit) continue;
      offenders.push(
        `${path.relative(FRONTEND_SRC, file)}:${lineOf(source, call.index)} -> GET ${hit.path}`,
      );
    }
  }

  assert.deepEqual(offenders, [],
    'these frontend calls fetch a GUARDED route without authHeaders(), so they 401 in the browser '
    + 'while every backend test stays green:\n  ' + offenders.join('\n  ')
    + '\nFix by passing { headers: authHeaders() } -- apiFetch does NOT attach the token.');
});

test('the scanner resolves each guarded route the frontend actually calls', () => {
  // The anti-vacuity half, and it is per-ROUTE on purpose. A count ("saw at
  // least N") hides exactly the failure this test was born from: the first
  // version of this file matched four credentialed calls and still could not
  // see chunkFetcher.js at all, because that caller hoists its URL into a
  // `const url`. A total stayed healthy while one route was invisible.
  //
  // So: name the routes whose frontend callers are known to send credentials,
  // and require the scanner to SEE each one. If a matcher stops resolving a
  // caller, this says which route went dark instead of quietly passing.
  const EXPECTED_SEEN = [
    '/api/world-graph',            // useMapGraph.js
    '/api/worlds/:id/links',       // useMapsAdmin.js
    '/api/worlds/:id/chunk',       // chunkFetcher.js -- via a hoisted `const url`
    '/api/worlds/:id/preview',     // worldPreviewClient.js
  ];
  const matchers = guardedGetPaths().map((p) => ({ path: p, re: pathMatcher(p) }));
  for (const p of EXPECTED_SEEN) {
    assert.ok(matchers.some((m) => m.path === p),
      `${p} is no longer a guarded GET on the backend -- if the guard was removed on purpose, `
      + 'drop it from EXPECTED_SEEN here too; otherwise a guard has been lost.');
  }

  const seen = new Set();
  for (const file of sourceFiles(FRONTEND_SRC)) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    for (const call of fetchCalls(source)) {
      if (/\bmethod\s*:/.test(call.text)) continue;
      if (!/authHeaders/.test(call.text)) continue;
      const text = withResolvedUrlVars(source, call.text);
      for (const m of matchers) if (m.re.test(text)) seen.add(m.path);
    }
  }

  const blind = EXPECTED_SEEN.filter((p) => !seen.has(p));
  assert.deepEqual(blind, [],
    'the scanner can no longer see the credentialed frontend caller for: ' + blind.join(', ')
    + ' -- the URL matcher has gone blind for these routes, so the guard above would NOT catch '
    + 'their credentials being removed.');
});
