const test = require('node:test');
const assert = require('node:assert');

// Set the secret before requiring the app / signing any token.
require('./helpers/auth.js');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

// A stateful in-memory `users` table just rich enough to exercise the auth
// routes end-to-end (register -> token -> guarded route). The INSERT handler
// reads role from params[2] IF PRESENT so that a mutation which passes
// req.body.role through as a third parameter is observable here (correct code
// forces the 'player' literal in SQL, so params only carry [username, hash]).
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
        const row = {
          id: nextId++,
          username: params[0],
          password_hash: params[1],
          role: params[2] || 'player',
          token_version: 1,
        };
        users.push(row);
        return { rows: [{ id: row.id, username: row.username, role: row.role, token_version: row.token_version }] };
      }
      if (/SELECT token_version, role FROM users WHERE id/i.test(sql)) {
        const u = users.find((x) => x.id === params[0]);
        return { rows: u ? [{ token_version: u.token_version, role: u.role }] : [] };
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
  const res = await request(app).post('/api/auth/register').send({ username: 'bob', password: 'pw123456' });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(JSON.stringify(res.body).includes('password_hash'), false);
  assert.equal(JSON.stringify(res.body).includes('pw123456'), false);
});

test('register IGNORES a role field in the body (privilege escalation)', async () => {
  const pool = usersPool();
  __setPool(pool);
  const res = await request(app).post('/api/auth/register')
    .send({ username: 'sneak', password: 'pw123456', role: 'admin' });
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
    const res = await request(app).post('/api/auth/register').send({ username: 'quiet', password: 'sup3rsecret!' });
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
  const first = await request(app).post('/api/auth/register').send({ username: 'dup', password: 'pw123456' });
  assert.equal(first.status, 201);
  const second = await request(app).post('/api/auth/register').send({ username: 'dup', password: 'pw123456' });
  assert.equal(second.status, 409);
});

test('login rejects a wrong password without revealing which field was wrong', async () => {
  __setPool(usersPool());
  await request(app).post('/api/auth/register').send({ username: 'alice', password: 'correct-horse' });
  const wrongPw = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'nope' });
  const noUser = await request(app).post('/api/auth/login').send({ username: 'ghost', password: 'whatever' });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  // Same generic message; must not name the username/password field specifically.
  assert.deepEqual(wrongPw.body, noUser.body);
  assert.equal(/username|password/i.test(JSON.stringify(wrongPw.body)), false);
});

test('login succeeds with the right password and returns a token', async () => {
  __setPool(usersPool());
  await request(app).post('/api/auth/register').send({ username: 'carol', password: 'pw123456' });
  const res = await request(app).post('/api/auth/login').send({ username: 'carol', password: 'pw123456' });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
});

test('logout-all bumps token_version so a prior token stops working', async () => {
  const pool = usersPool();
  __setPool(pool);
  const reg = await request(app).post('/api/auth/register').send({ username: 'dave', password: 'pw123456' });
  const token = reg.body.token;
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
  __setPool(usersPool());
  const reg = await request(app).post('/api/auth/register').send({ username: 'erin', password: 'pw123456' });
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${reg.body.token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.username, 'erin');
  assert.equal(JSON.stringify(res.body).includes('password_hash'), false);
});

test('username uniqueness is case-insensitive (Bob == bob)', async () => {
  __setPool(usersPool());
  const a = await request(app).post('/api/auth/register').send({ username: 'Bob', password: 'pw123456' });
  assert.equal(a.status, 201);
  const b = await request(app).post('/api/auth/register').send({ username: 'bob', password: 'pw123456' });
  assert.equal(b.status, 409);
});

test('a non-admin cannot promote anyone', async () => {
  const pool = usersPool();
  __setPool(pool);
  const reg = await request(app).post('/api/auth/register').send({ username: 'frank', password: 'pw123456' });
  const victim = pool.seedAdmin('victim'); // any existing user id
  const res = await request(app)
    .post(`/api/auth/admin/users/${victim.id}/role`)
    .set('Authorization', `Bearer ${reg.body.token}`)
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
