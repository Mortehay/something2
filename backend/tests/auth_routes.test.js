const test = require('node:test');
const assert = require('node:assert');

// Set the secret before requiring the app / signing any token.
require('./helpers/auth.js');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

// A stateful in-memory `users` table just rich enough to exercise the auth
// routes end-to-end (register -> token -> guarded route). The INSERT handler
// asserts the INSERT params are exactly [username, hash, email]: correct code
// forces the 'player' literal in SQL, so a role param appended or reordered
// (e.g. req.body.role passed through) fails loudly here.
// /register is capped at 20 per hour per IP and every request here shares one
// app (one supertest IP), so tests whose subject is NOT registration create
// their user directly and log in, instead of spending registrations.
let seededHash;
async function loginAs(pool, username, password = 'pw123456') {
  seededHash ??= await require('../src/auth/passwords.js').hashPassword(password);
  pool.users.push({
    id: 1000 + pool.users.length, username, password_hash: seededHash,
    email: `${username}@example.com`, role: 'player', token_version: 1,
  });
  const res = await request(app).post('/api/auth/login').send({ username, password });
  assert.equal(res.status, 200, res.text);
  return res.body.token;
}

function usersPool() {
  const users = [];
  let nextId = 1;
  const pool = {
    users,
    seedAdmin(username = 'root') {
      const row = { id: nextId++, username, password_hash: 'x', role: 'admin', token_version: 1 };
      users.push(row);
      return row;
    },
    getUser(username) {
      return users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
    },
    query: async (sql, params) => {
      if (/INSERT INTO users/i.test(sql)) {
        if (params.length !== 3) throw new Error(`INSERT INTO users expects [username, hash, email], got ${params.length} params`);
        const row = {
          id: nextId++,
          username: params[0],
          password_hash: params[1],
          email: params[2],
          role: 'player',
          token_version: 1,
        };
        users.push(row);
        return { rows: [{ id: row.id, username: row.username, role: row.role, token_version: row.token_version }] };
      }
      if (/SELECT token_version, role FROM users WHERE id/i.test(sql)) {
        const u = users.find((x) => x.id === params[0]);
        return { rows: u ? [{ token_version: u.token_version, role: u.role }] : [] };
      }
      // GET /me's email-state read (email-accounts Task 5).
      if (/SELECT email, email_verified_at FROM users WHERE id/i.test(sql)) {
        const u = users.find((x) => x.id === params[0]);
        return { rows: u ? [{ email: u.email ?? null, email_verified_at: u.email_verified_at ?? null }] : [] };
      }
      // GET /me's pending email change (profile Task 2): none in this fake.
      if (/FROM email_tokens/i.test(sql) && /change_email/.test(sql)) return { rows: [] };
      // verifiedHolder (registration): nobody holds any email verified here.
      if (/FROM users\s+WHERE email/i.test(sql)) {
        return { rows: users.filter((u) => u.email === params[0] && u.email_verified_at).map((u) => ({ id: u.id })) };
      }
      if (/FROM users WHERE username/i.test(sql)) {
        const u = pool.getUser(params[0]);
        return { rows: u ? [u] : [] };
      }
      if (/UPDATE users SET token_version/i.test(sql)) {
        const u = users.find((x) => x.id === params[0]);
        if (u) u.token_version += 1;
        return { rows: [] };
      }
      if (/UPDATE users SET role/i.test(sql)) {
        const u = users.find((x) => x.id === Number(params[1]));
        if (u) u.role = params[0];
        return { rows: u ? [{ id: u.id, username: u.username, role: u.role }] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return pool;
}

test('register creates a player and returns a token, never a hash', async () => {
  __setPool(usersPool());
  const res = await request(app).post('/api/auth/register').send({ username: 'bob', password: 'pw123456', email: 'bob@example.com' });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(JSON.stringify(res.body).includes('password_hash'), false);
  assert.equal(JSON.stringify(res.body).includes('pw123456'), false);
});

test('register IGNORES a role field in the body (privilege escalation)', async () => {
  const pool = usersPool();
  __setPool(pool);
  const res = await request(app).post('/api/auth/register')
    .send({ username: 'sneak', password: 'pw123456', role: 'admin', email: 'sneak@example.com' });
  assert.equal(res.status, 201);
  const row = pool.getUser('sneak');
  assert.equal(row.role, 'player');
});

test('register response and logs never leak the password or the hash', async () => {
  const pool = usersPool();
  __setPool(pool);
  const captured = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  console.warn = (...a) => captured.push(a.join(' '));
  try {
    const res = await request(app).post('/api/auth/register').send({ username: 'quiet', password: 'sup3rsecret!', email: 'quiet@example.com' });
    assert.equal(res.status, 201);
    const hash = pool.getUser('quiet').password_hash;
    const body = JSON.stringify(res.body);
    assert.equal(body.includes('sup3rsecret!'), false);
    assert.equal(body.includes(hash), false);
    const logs = captured.join('\n');
    assert.equal(logs.includes('sup3rsecret!'), false, 'a log line leaked the password');
    assert.equal(logs.includes(hash), false, 'a log line leaked the hash');
  } finally {
    Object.assign(console, orig);
  }
});

test('register rejects a taken username', async () => {
  __setPool(usersPool());
  const first = await request(app).post('/api/auth/register').send({ username: 'dup', password: 'pw123456', email: 'dup@example.com' });
  assert.equal(first.status, 201);
  const second = await request(app).post('/api/auth/register').send({ username: 'dup', password: 'pw123456', email: 'dup@example.com' });
  assert.equal(second.status, 409);
});

test('login rejects a wrong password without revealing which field was wrong', async () => {
  const pool = usersPool();
  __setPool(pool);
  await loginAs(pool, 'alice');
  const wrongPw = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'nope' });
  const noUser = await request(app).post('/api/auth/login').send({ username: 'ghost', password: 'whatever' });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  // Same generic message; must not name the username/password field specifically.
  assert.deepEqual(wrongPw.body, noUser.body);
  assert.equal(/username|password/i.test(JSON.stringify(wrongPw.body)), false);
});

test('login succeeds with the right password and returns a token', async () => {
  const pool = usersPool();
  __setPool(pool);
  await loginAs(pool, 'carol');
  const res = await request(app).post('/api/auth/login').send({ username: 'carol', password: 'pw123456' });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
});

test('logout-all bumps token_version so a prior token stops working', async () => {
  const pool = usersPool();
  __setPool(pool);
  const token = await loginAs(pool, 'dave');
  // /me works with the fresh token.
  const before = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(before.status, 200);
  // logout-all invalidates it.
  const out = await request(app).post('/api/auth/logout-all').set('Authorization', `Bearer ${token}`);
  assert.equal(out.status, 200);
  const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(after.status, 401);
});

test('GET /me returns the user, never a hash', async () => {
  const pool = usersPool();
  __setPool(pool);
  const token = await loginAs(pool, 'erin');
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.username, 'erin');
  assert.equal(JSON.stringify(res.body).includes('password_hash'), false);
});

test('username uniqueness is case-insensitive (Bob == bob)', async () => {
  __setPool(usersPool());
  const a = await request(app).post('/api/auth/register').send({ username: 'Bob', password: 'pw123456', email: 'bob@example.com' });
  assert.equal(a.status, 201);
  const b = await request(app).post('/api/auth/register').send({ username: 'bob', password: 'pw123456', email: 'bob@example.com' });
  assert.equal(b.status, 409);
});

test('a non-admin cannot promote anyone', async () => {
  const pool = usersPool();
  __setPool(pool);
  const frankToken = await loginAs(pool, 'frank');
  const victim = pool.seedAdmin('victim'); // any existing user id
  const res = await request(app)
    .post(`/api/auth/admin/users/${victim.id}/role`)
    .set('Authorization', `Bearer ${frankToken}`)
    .send({ role: 'admin' });
  assert.equal(res.status, 403);
});

test('an admin can promote another user', async () => {
  const pool = usersPool();
  __setPool(pool);
  const admin = pool.seedAdmin('root');
  const target = pool.seedAdmin('target');
  target.role = 'player';
  const adminTok = signToken({ userId: admin.id, username: admin.username, role: 'admin', tokenVersion: admin.token_version });
  const res = await request(app)
    .post(`/api/auth/admin/users/${target.id}/role`)
    .set('Authorization', `Bearer ${adminTok}`)
    .send({ role: 'admin' });
  assert.equal(res.status, 200);
  assert.equal(pool.getUser('target').role, 'admin');
});

test('rate limiting one username does NOT lock out a different username on the same IP', async () => {
  __setPool(usersPool());
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await request(app).post('/api/auth/login').send({ username: 'flooder', password: 'x' });
    if (r.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'expected the flooded username to eventually hit 429');
  // A different username on the same IP is unaffected.
  const other = await request(app).post('/api/auth/login').send({ username: 'bystander', password: 'x' });
  assert.notEqual(other.status, 429);
});

test('register without a valid email is 400 invalid_email', async () => {
  __setPool(usersPool());
  for (const email of [undefined, '', 'nope', 42]) {
    const res = await request(app).post('/api/auth/register')
      .send({ username: 'noemail', password: 'pw123456', email });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_email');
  }
});

test('register stores the normalized email and reports it unverified', async () => {
  const pool = usersPool();
  __setPool(pool);
  const res = await request(app).post('/api/auth/register')
    .send({ username: 'mixed', password: 'pw123456', email: '  Mixed@Example.COM ' });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'mixed@example.com');
  assert.equal(res.body.user.emailVerified, false);
  assert.equal(pool.getUser('mixed').email, 'mixed@example.com');
});

test('register is capped at 20 per hour per IP, whatever the username', async () => {
  const express = require('express');
  const authRouter = require('../src/auth/routes.js');
  const a = express();
  a.use(express.json());
  a.use('/api/auth', authRouter(usersPool()));
  for (let i = 0; i < 20; i++) {
    const r = await request(a).post('/api/auth/register').send({ username: `u${i}`, password: 'pw123456' });
    assert.equal(r.status, 400, `request ${i + 1}`);
  }
  const over = await request(a).post('/api/auth/register').send({ username: 'u21', password: 'pw123456' });
  assert.equal(over.status, 429);
});
