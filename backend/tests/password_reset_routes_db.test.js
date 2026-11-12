// Forgot / reset password against a real database.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

require('./helpers/auth.js');
const request = require('supertest');
const { app } = require('../src/index.js');
const { __setSender } = require('../src/email/mailer.js');
const { hashPassword } = require('../src/auth/passwords.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const uniq = (p) => `${p}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const ORIGIN = 'http://localhost:5173';

test('password reset routes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const users = [];
  const sent = [];
  const saved = {};
  for (const k of ['EMAIL_GATE_FORCE', 'CORS_ORIGINS']) saved[k] = process.env[k];
  process.env.EMAIL_GATE_FORCE = '1';
  process.env.CORS_ORIGINS = ORIGIN;
  __setSender(async (m) => { sent.push(m); });
  t.after(async () => {
    __setSender(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (users.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [users]);
    await pool.end();
  });

  let hash;
  const email = () => `${uniq('x')}@example.com`;
  // Users are inserted directly (see account_email_routes_db.test.js: /register is IP-capped).
  const mk = async (addr, verified) => {
    const username = uniq('pr');
    users.push(username);
    hash ??= await hashPassword('password123');
    const ins = await pool.query(
      `INSERT INTO users (username, password_hash, role, email, email_verified_at)
       VALUES ($1, $2, 'player', $3, ${verified ? 'now()' : 'NULL'}) RETURNING id`,
      [username, hash, addr]);
    const r = await request(app).post('/api/auth/login').send({ username, password: 'password123' });
    assert.equal(r.status, 200, r.text);
    return { username, id: ins.rows[0].id, auth: { Authorization: `Bearer ${r.body.token}` } };
  };
  // The mail goes out AFTER the response, so wait for it deterministically.
  const waitSent = async (n) => {
    for (let i = 0; i < 100 && sent.length < n; i += 1) await new Promise((r) => setTimeout(r, 20));
  };
  const settle = () => new Promise((r) => setTimeout(r, 300));
  // Shared-app forgot calls in this file total 8 (< the 10/h IP cap); the cap itself is tested on its own app.
  const forgot = (e) => request(app).post('/api/auth/password/forgot').set('Origin', ORIGIN).send({ email: e });
  const lastToken = () => {
    const m = sent[sent.length - 1].text.match(/\/reset-password\/([0-9a-f-]{36})/);
    assert.ok(m, 'link in mail');
    return m[1];
  };
  const reset = (token, password) => request(app).post('/api/auth/password/reset').send({ token, password });

  await t.test('unknown and known email give identical responses', async () => {
    const e = email();
    await mk(e, true);
    const n = sent.length;
    const a = await forgot(email());
    const b = await forgot(e);
    await waitSent(n + 1); // let the detached send land before the next test counts mails
    assert.equal(a.status, 200);
    assert.equal(b.status, a.status);
    assert.deepEqual(b.body, { ok: true });
    assert.deepEqual(b.body, a.body);
    assert.equal(b.headers['content-type'], a.headers['content-type']);
  });

  await t.test('verified account gets a mail (mixed-case address)', async () => {
    const e = email();
    await mk(e, true);
    const before = sent.length;
    const r = await forgot(`  ${e.toUpperCase()} `);
    assert.equal(r.status, 200);
    await waitSent(before + 1);
    assert.equal(sent.length, before + 1);
    assert.equal(sent[sent.length - 1].to, e);
    lastToken();
  });

  await t.test('single unverified holder gets a mail', async () => {
    const e = email();
    await mk(e, false);
    const before = sent.length;
    await forgot(e);
    await waitSent(before + 1);
    await settle();
    assert.equal(sent.length, before + 1);
  });

  await t.test('two unverified holders: nobody is mailed', async () => {
    const e = email();
    await mk(e, false);
    await mk(e, false);
    const before = sent.length;
    const r = await forgot(e);
    assert.equal(r.status, 200);
    await settle();
    assert.equal(sent.length, before);
  });

  await t.test('reset invalidates old JWT, new password works, verifies email, single use', async () => {
    const e = email();
    const u = await mk(e, false);
    const n = sent.length;
    await forgot(e);
    await waitSent(n + 1);
    const token = lastToken();
    const peek = await request(app).get(`/api/auth/password/reset/${token}`);
    assert.deepEqual(peek.body, { live: true });
    assert.equal((await reset(token, '')).status, 400);
    const r = await reset(token, 'newpassword456');
    assert.equal(r.status, 200, r.text);
    assert.equal((await request(app).get('/api/auth/me').set(u.auth)).status, 401);
    const login = await request(app).post('/api/auth/login').send({ username: u.username, password: 'newpassword456' });
    assert.equal(login.status, 200);
    const me = await request(app).get('/api/auth/me').set({ Authorization: `Bearer ${login.body.token}` });
    assert.equal(me.body.emailVerified, true);
    const again = await reset(token, 'another789');
    assert.equal(again.status, 410);
    assert.equal(again.body.error, 'link_expired');
    const peek2 = await request(app).get(`/api/auth/password/reset/${token}`);
    assert.deepEqual(peek2.body, { live: false });
  });

  await t.test('2nd forgot in an hour is silently not mailed; link lives 24 h', async () => {
    const e = email();
    await mk(e, true);
    const before = sent.length;
    const r1 = await forgot(e);
    assert.deepEqual([r1.status, r1.body], [200, { ok: true }]);
    await waitSent(before + 1);
    const r2 = await forgot(e);
    assert.deepEqual([r2.status, r2.body], [200, { ok: true }]);
    await settle();
    assert.equal(sent.length, before + 1);
    const { rows } = await pool.query(
      `SELECT extract(epoch FROM expires_at - created_at)::int AS s FROM email_tokens
        WHERE purpose = 'reset_password' AND email = $1`, [e]);
    assert.deepEqual(rows.map((x) => x.s), [24 * 3600]);
  });

  await t.test('a link 23 hours old still resets', async () => {
    const e = email();
    await mk(e, true);
    const n = sent.length;
    await forgot(e);
    await waitSent(n + 1);
    const token = lastToken();
    await pool.query(
      `UPDATE email_tokens SET created_at = created_at - interval '23 hours', expires_at = expires_at - interval '23 hours'
        WHERE purpose = 'reset_password' AND email = $1`, [e]);
    assert.equal((await reset(token, 'newpassword789')).status, 200);
  });

  await t.test('rollback keeps the link alive when the reset fails mid-way', async () => {
    const e = email();
    const u = await mk(e, true);
    const n = sent.length;
    await forgot(e);
    await waitSent(n + 1);
    const token = lastToken();
    // A password longer than bcrypt-safe input is not the failure; force one in the UPDATE instead.
    await pool.query('ALTER TABLE users ADD CONSTRAINT pr_fail_' + u.id + ' CHECK (token_version < 0) NOT VALID');
    let r;
    try { r = await reset(token, 'newpassword456'); } finally {
      await pool.query('ALTER TABLE users DROP CONSTRAINT pr_fail_' + u.id);
    }
    assert.equal(r.status, 500);
    const peek = await request(app).get(`/api/auth/password/reset/${token}`);
    assert.deepEqual(peek.body, { live: true });
    assert.equal((await reset(token, 'newpassword456')).status, 200);
  });

  await t.test('per-IP cap: 11th forgot is 429 (own app)', async () => {
    const express = require('express');
    const authRouter = require('../src/auth/routes.js');
    const a = express();
    a.use(express.json());
    a.use('/api/auth', authRouter({ query: (...x) => pool.query(...x), connect: () => pool.connect() }));
    for (let i = 0; i < 10; i += 1) {
      const r = await request(a).post('/api/auth/password/forgot').send({ email: email() });
      assert.equal(r.status, 200);
    }
    const r = await request(a).post('/api/auth/password/forgot').send({ email: email() });
    assert.equal(r.status, 429);
  });
});
