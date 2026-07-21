process.env.JWT_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { signToken } = require('../src/auth/tokens.js');
const { requireAuth, requireAdmin } = require('../src/auth/middleware.js');

function fakePool(rows) {
  return { query: async () => ({ rows }) };
}

// A pool whose query always rejects — models a transient DB failure (pool
// exhaustion, statement timeout, a DB restart) during the token_version lookup.
function failingPool() {
  return { query: async () => { throw new Error('connection terminated'); } };
}

function fakeReq(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

function fakeRes() {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('requireAuth rejects a missing token with 401', async () => {
  const mw = requireAuth(fakePool([{ token_version: 1, role: 'player' }]));
  const req = fakeReq(null);
  const res = fakeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('requireAuth rejects a valid token with a stale token_version', async () => {
  const token = signToken({ userId: 5, username: 'stale', role: 'player', tokenVersion: 1 });
  // DB row says the account's token_version has since moved to 2 (e.g. password change).
  const mw = requireAuth(fakePool([{ token_version: 2, role: 'player' }]));
  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('requireAuth responds 500 on a DB error instead of letting the rejection escape', async () => {
  // Express 4.x does not catch async middleware rejections; an unguarded pool
  // failure here would become an unhandledRejection and crash the process,
  // taking the co-hosted WS authority down. The guard must convert it to a 500.
  const token = signToken({ userId: 5, username: 'x', role: 'player', tokenVersion: 1 });
  const mw = requireAuth(failingPool());
  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  let threw = false;
  try {
    await mw(req, res, () => { nextCalled = true; });
  } catch {
    threw = true; // this is the crash path — the middleware rejected
  }
  assert.equal(threw, false, 'the middleware must not reject — that is the process-crash path');
  assert.equal(res.statusCode, 500);
  assert.equal(nextCalled, false, 'a failed auth check must not fall through to the handler');
});

test('requireAuth attaches req.user and calls next() when token_version matches', async () => {
  const token = signToken({ userId: 5, username: 'fresh', role: 'player', tokenVersion: 2 });
  const mw = requireAuth(fakePool([{ token_version: 2, role: 'player' }]));
  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
  assert.deepEqual(req.user, { id: 5, username: 'fresh', role: 'player' });
});

test('requireAdmin rejects a valid current-version player token with 403', async () => {
  const token = signToken({ userId: 5, username: 'p', role: 'player', tokenVersion: 1 });
  const mw = requireAdmin(fakePool([{ token_version: 1, role: 'player' }]));
  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('requireAdmin allows a valid current-version admin token', async () => {
  const token = signToken({ userId: 9, username: 'a', role: 'admin', tokenVersion: 1 });
  const mw = requireAdmin(fakePool([{ token_version: 1, role: 'admin' }]));
  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, { id: 9, username: 'a', role: 'admin' });
});

test('requireAdmin also rejects a missing token with 401', async () => {
  const mw = requireAdmin(fakePool([{ token_version: 1, role: 'admin' }]));
  const req = fakeReq(null);
  const res = fakeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('requireAdmin also rejects a stale-version admin token with 401 (not 403)', async () => {
  const token = signToken({ userId: 9, username: 'a', role: 'admin', tokenVersion: 1 });
  const mw = requireAdmin(fakePool([{ token_version: 2, role: 'admin' }]));
  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('requireAuth and requireAdmin are findable in an Express route stack by marker', () => {
  const express = require('express');
  const app = express();
  const pool = fakePool([{ token_version: 1, role: 'admin' }]);
  app.get('/protected', requireAuth(pool), (req, res) => res.end());
  app.get('/admin-only', requireAdmin(pool), (req, res) => res.end());

  const protectedLayer = app._router.stack.find((l) => l.route && l.route.path === '/protected');
  const adminLayer = app._router.stack.find((l) => l.route && l.route.path === '/admin-only');

  const protectedGuard = protectedLayer.route.stack[0].handle;
  const adminGuard = adminLayer.route.stack[0].handle;

  assert.equal(protectedGuard.isAuthGuard, true, 'requireAuth handler carries an isAuthGuard marker');
  assert.equal(adminGuard.isAuthGuard, true, 'requireAdmin handler carries an isAuthGuard marker');
  assert.equal(adminGuard.isAdminGuard, true, 'requireAdmin handler additionally carries an isAdminGuard marker');
});
