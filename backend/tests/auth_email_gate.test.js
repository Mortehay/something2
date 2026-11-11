const test = require('node:test');
const assert = require('node:assert');

// Set the secret before requiring the app / signing any token.
require('./helpers/auth.js');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');
const { signToken, emailGateActive, isEmailGated } = require('../src/auth/tokens.js');

// The gate is driven by env (SMTP_* or EMAIL_GATE_FORCE). Every test starts
// from a clean slate and restores whatever the process had, so a forced gate
// can never leak into a later test (or another file's fake pool, which does
// not answer email_verified_at).
const GATE_ENV = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_GATE_FORCE'];
let savedEnv;
test.beforeEach(() => {
  savedEnv = {};
  for (const k of GATE_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
test.afterEach(() => {
  for (const k of GATE_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const OLD_LOOKUP = 'SELECT token_version, role FROM users WHERE id = $1';

// In-memory users table. Answers the inactive lookup, the gated lookup and
// /me's email read; everything else (the routes behind the guard) gets an
// empty result. Every SQL string is recorded so a test can prove which
// lookup actually ran.
function gatePool(users) {
  const seen = [];
  const byId = (id) => users.find((u) => u.id === Number(id));
  return {
    seen,
    query: async (sql, params) => {
      seen.push(sql);
      if (sql === OLD_LOOKUP) {
        const u = byId(params[0]);
        return { rows: u ? [{ token_version: u.token_version, role: u.role }] : [] };
      }
      if (/SELECT token_version, role, email_verified_at FROM users WHERE id = \$1/.test(sql)) {
        const u = byId(params[0]);
        return { rows: u ? [{ token_version: u.token_version, role: u.role, email_verified_at: u.email_verified_at }] : [] };
      }
      if (/SELECT email, email_verified_at FROM users WHERE id = \$1/.test(sql)) {
        const u = byId(params[0]);
        return { rows: u ? [{ email: u.email, email_verified_at: u.email_verified_at }] : [] };
      }
      return { rows: [] };
    },
  };
}

const UNVERIFIED = { id: 41, username: 'unv', role: 'player', token_version: 1, email: 'unv@example.com', email_verified_at: null };
const VERIFIED = { id: 42, username: 'ver', role: 'player', token_version: 1, email: 'ver@example.com', email_verified_at: new Date('2026-11-01T00:00:00Z') };
const NO_EMAIL = { id: 43, username: 'old', role: 'player', token_version: 1, email: null, email_verified_at: null };
const UNVERIFIED_ADMIN = { id: 44, username: 'boss', role: 'admin', token_version: 1, email: null, email_verified_at: null };

function bearer(u) {
  return `Bearer ${signToken({ userId: u.id, username: u.username, role: u.role, tokenVersion: u.token_version })}`;
}

// ---------------------------------------------------------------------------
// The switch itself.
// ---------------------------------------------------------------------------

test('emailGateActive: SMTP fully configured or EMAIL_GATE_FORCE=1, nothing else', () => {
  assert.equal(emailGateActive({}), false);
  assert.equal(emailGateActive({ SMTP_HOST: 'h', SMTP_USER: 'u' }), false, 'partial SMTP is not configured');
  assert.equal(emailGateActive({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }), true);
  assert.equal(emailGateActive({ EMAIL_GATE_FORCE: '1' }), true);
  assert.equal(emailGateActive({ EMAIL_GATE_FORCE: 'true' }), false, 'only the exact value 1 forces it');
});

test('isEmailGated is true only for an explicit emailVerified:false', () => {
  assert.equal(isEmailGated({ id: 1, emailVerified: false }), true);
  assert.equal(isEmailGated({ id: 1, emailVerified: true }), false);
  assert.equal(isEmailGated({ id: 1 }), false, 'inactive gate leaves the field absent: not gated');
});

// ---------------------------------------------------------------------------
// HTTP guard behaviour.
// ---------------------------------------------------------------------------

test('gate active: an unverified account is refused by a normal route with 403 email_not_verified', async () => {
  process.env.EMAIL_GATE_FORCE = '1';
  __setPool(gatePool([UNVERIFIED]));
  const res = await request(app).get('/api/characters').set('Authorization', bearer(UNVERIFIED));
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'email_not_verified' });
});

test('gate active: an account with no email at all is refused the same way', async () => {
  process.env.EMAIL_GATE_FORCE = '1';
  __setPool(gatePool([NO_EMAIL]));
  const res = await request(app).get('/api/characters').set('Authorization', bearer(NO_EMAIL));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'email_not_verified');
});

test('gate active: admins are gated too (admin route answers email_not_verified, not a role error)', async () => {
  process.env.EMAIL_GATE_FORCE = '1';
  __setPool(gatePool([UNVERIFIED_ADMIN]));
  const res = await request(app).post('/api/auth/admin/users/1/role')
    .set('Authorization', bearer(UNVERIFIED_ADMIN)).send({ role: 'player' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'email_not_verified');
});

test('gate active by SMTP config (no force flag) refuses the unverified account too', async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_USER = 'u';
  process.env.SMTP_PASS = 'p';
  __setPool(gatePool([UNVERIFIED]));
  const res = await request(app).get('/api/characters').set('Authorization', bearer(UNVERIFIED));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'email_not_verified');
});

test('gate active: a verified account gets through the guard', async () => {
  process.env.EMAIL_GATE_FORCE = '1';
  const pool = gatePool([VERIFIED]);
  __setPool(pool);
  const res = await request(app).get('/api/characters').set('Authorization', bearer(VERIFIED));
  assert.notEqual(res.status, 403, JSON.stringify(res.body));
  assert.notEqual(res.status, 401, JSON.stringify(res.body));
  assert.ok(pool.seen.some((s) => /email_verified_at FROM users/.test(s)), 'the gated lookup must have run');
});

test('gate active: /me answers an unverified account with its email state', async () => {
  process.env.EMAIL_GATE_FORCE = '1';
  __setPool(gatePool([UNVERIFIED]));
  const res = await request(app).get('/api/auth/me').set('Authorization', bearer(UNVERIFIED));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, {
    id: UNVERIFIED.id, username: 'unv', role: 'player',
    email: 'unv@example.com', emailVerified: false, emailRequired: true,
  });
});

test('gate active: /me reports a verified account as verified', async () => {
  process.env.EMAIL_GATE_FORCE = '1';
  __setPool(gatePool([VERIFIED]));
  const res = await request(app).get('/api/auth/me').set('Authorization', bearer(VERIFIED));
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'ver@example.com');
  assert.equal(res.body.emailVerified, true);
  assert.equal(res.body.emailRequired, true);
});

test('gate active: logout-all still works for an unverified account', async () => {
  process.env.EMAIL_GATE_FORCE = '1';
  const pool = gatePool([UNVERIFIED]);
  __setPool(pool);
  const res = await request(app).post('/api/auth/logout-all').set('Authorization', bearer(UNVERIFIED));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(pool.seen.some((s) => /UPDATE users SET token_version/.test(s)));
});

test('gate inactive: an unverified account gets through, and only the old lookup SQL runs', async () => {
  const pool = gatePool([UNVERIFIED]);
  __setPool(pool);
  const res = await request(app).get('/api/characters').set('Authorization', bearer(UNVERIFIED));
  assert.notEqual(res.status, 403, JSON.stringify(res.body));
  assert.notEqual(res.status, 401, JSON.stringify(res.body));
  const userLookups = pool.seen.filter((s) => /FROM users/i.test(s));
  assert.ok(userLookups.length >= 1, 'the guard lookup must have run');
  assert.deepEqual([...new Set(userLookups)], [OLD_LOOKUP]);
});

test('gate inactive: /me reports emailRequired:false and the row email state', async () => {
  __setPool(gatePool([UNVERIFIED]));
  const res = await request(app).get('/api/auth/me').set('Authorization', bearer(UNVERIFIED));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    id: UNVERIFIED.id, username: 'unv', role: 'player',
    email: 'unv@example.com', emailVerified: false, emailRequired: false,
  });
});

// ---------------------------------------------------------------------------
// Route-stack walk: the allowlist is exactly the guards that opt out.
// ---------------------------------------------------------------------------

const ALLOWLIST = ['/api/auth/me', '/api/auth/logout-all', '/api/auth/email', '/api/auth/email/resend'];
// Task 6 creates the email routes; until then only these exist. Asserted below
// so a walk that misses /api/auth entirely cannot pass vacuously.
const ALLOWLIST_EXISTING_NOW = ['/api/auth/me', '/api/auth/logout-all'];

// Express 4 mount regexps look like /^\/api\/auth\/?(?=\/|$)/i. Recover the
// literal prefix; refuse anything with a parameter or other regex syntax left
// so a mount we cannot read fails loudly instead of being skipped.
function mountPrefix(layer) {
  if (layer.regexp.fast_slash) return '';
  const src = layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/');
  assert.ok(!/[()[\]*+?^$|\\]/.test(src), `cannot read mount path from ${layer.regexp}`);
  return src;
}

// Every auth guard reachable from the app, at any depth, with the full path
// it guards: route-level handlers and router.use(...) guards alike.
function collectGuards(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const full = prefix + layer.route.path;
      for (const h of layer.route.stack) {
        if (h.handle && h.handle.isAuthGuard) out.push({ path: full, kind: 'route', guard: h.handle });
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      collectGuards(layer.handle.stack, prefix + mountPrefix(layer), out);
    } else if (layer.handle && layer.handle.isAuthGuard) {
      out.push({ path: prefix + (layer.regexp.fast_slash ? '' : mountPrefix(layer)) + '/*', kind: 'use', guard: layer.handle });
    }
  }
  return out;
}

test('route stack: only allowlisted paths carry an allowsUnverified guard, and they all do', () => {
  const guards = collectGuards(app._router.stack, '', []);
  // Vacuity guard: the real surface has well over a hundred guarded routes,
  // including router-level guards on the sprite-admin / seed-export mounts.
  assert.ok(guards.length >= 100, `expected the full guarded surface, found ${guards.length}`);
  assert.ok(guards.some((g) => g.kind === 'use'), 'router-level guards must be walked too');

  const leaking = guards.filter((g) => g.guard.allowsUnverified && !ALLOWLIST.includes(g.path))
    .map((g) => g.path);
  assert.deepEqual(leaking, [], `guards that let unverified accounts through outside the allowlist: ${leaking.join(', ')}`);

  for (const p of ALLOWLIST_EXISTING_NOW) {
    const here = guards.filter((g) => g.path === p);
    assert.ok(here.length >= 1, `allowlisted route ${p} not found in the stack`);
    assert.ok(here.every((g) => g.guard.allowsUnverified === true), `${p} must carry allowsUnverified`);
  }
  // Allowlisted paths that exist (e.g. once Task 6 lands) must carry it too.
  for (const g of guards.filter((x) => ALLOWLIST.includes(x.path))) {
    assert.equal(g.guard.allowsUnverified, true, `${g.path} is allowlisted but its guard gates`);
  }
});
