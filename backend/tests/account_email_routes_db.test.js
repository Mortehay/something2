// Set / resend / verify account email against a real database.
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

test('account email routes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const users = [];
  const codes = [];
  const sent = [];
  const saved = {};
  for (const k of ['EMAIL_GATE_FORCE', 'CORS_ORIGINS', 'REGISTRATION_MODE']) saved[k] = process.env[k];
  process.env.EMAIL_GATE_FORCE = '1';
  process.env.CORS_ORIGINS = ORIGIN;
  process.env.REGISTRATION_MODE = 'open';
  __setSender(async (m) => { sent.push(m); });
  t.after(async () => {
    __setSender(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (codes.length) await pool.query('DELETE FROM invite_codes WHERE code = ANY($1)', [codes]);
    if (users.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [users]);
    await pool.end();
  });

  // POST /api/auth/register is capped at 20 per hour per IP and this file
  // shares one app (one supertest IP), so users that are not the subject of a
  // registration test are inserted directly and logged in. Only the register
  // tests below spend registrations.
  let hash;
  const mk = async () => {
    const username = uniq('em');
    users.push(username);
    hash ??= await hashPassword('password123');
    const ins = await pool.query(
      `INSERT INTO users (username, password_hash, role, email) VALUES ($1, $2, 'player', $3) RETURNING id`,
      [username, hash, `${username}@example.com`]);
    const r = await request(app).post('/api/auth/login').send({ username, password: 'password123' });
    assert.equal(r.status, 200, r.text);
    return { username, id: ins.rows[0].id, auth: { Authorization: `Bearer ${r.body.token}` } };
  };
  const post = (path, u, body) => {
    const r = request(app).post(path).set('Origin', ORIGIN);
    return (u ? r.set(u.auth) : r).send(body);
  };
  const lastToken = () => {
    const m = sent[sent.length - 1].text.match(/\/verify-email\/([0-9a-f-]{36})/);
    assert.ok(m, 'link in mail');
    return m[1];
  };
  const backdate = (id) => pool.query(
    "UPDATE email_tokens SET created_at = now() - interval '2 minutes' WHERE user_id = $1", [id]);
  const email = () => `${uniq('x')}@example.com`;

  const register = (body) => request(app).post('/api/auth/register').set('Origin', ORIGIN)
    .send({ password: 'password123', ...body });

  await t.test('register without email is 400', async () => {
    const r = await register({ username: uniq('noem') });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_email');
  });

  await t.test('register stores the email, mails a link, returns unverified', async () => {
    const username = uniq('reg');
    users.push(username);
    const e = email();
    const before = sent.length;
    const r = await register({ username, email: ` ${e.toUpperCase()} ` });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.user.email, e);
    assert.equal(r.body.user.emailVerified, false);
    assert.equal(sent.length, before + 1);
    assert.equal(sent[sent.length - 1].to, e);
    const row = (await pool.query('SELECT email, email_verified_at FROM users WHERE username = $1', [username])).rows[0];
    assert.equal(row.email, e);
    assert.equal(row.email_verified_at, null);
  });

  await t.test('register refuses an email a verified account holds', async () => {
    const u = await mk();
    const e = email();
    await post('/api/auth/email', u, { email: e });
    const tok = lastToken();
    assert.equal((await post('/api/auth/verify-email', null, { token: tok })).status, 200);
    const r = await register({ username: uniq('dupem'), email: e.toUpperCase() });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'email_taken');
  });

  await t.test('a failing mailer does not fail registration', async () => {
    const username = uniq('mailfail');
    users.push(username);
    __setSender(async () => { throw new Error('smtp down'); });
    try {
      const r = await register({ username, email: email() });
      assert.equal(r.status, 201, r.text);
    } finally {
      __setSender(async (m) => { sent.push(m); });
    }
  });

  await t.test('email-locked invite code: matching mixed-case email registers', async () => {
    process.env.REGISTRATION_MODE = 'invite';
    try {
      const e = email();
      const code = uniq('LOCK').toUpperCase();
      codes.push(code);
      await pool.query('INSERT INTO invite_codes (code, email) VALUES ($1, $2)', [code, e]);
      const username = uniq('lockok');
      users.push(username);
      const before = sent.length;
      const r = await register({ username, email: ` ${e.toUpperCase()} `, inviteCode: code });
      assert.equal(r.status, 201, r.text);
      assert.equal(sent.length, before + 1);
      assert.equal(sent[sent.length - 1].to, e);
    } finally {
      process.env.REGISTRATION_MODE = 'open';
    }
  });

  await t.test('email-locked invite code: another email is 403 and the code stays unused', async () => {
    process.env.REGISTRATION_MODE = 'invite';
    try {
      const code = uniq('LOCK').toUpperCase();
      codes.push(code);
      await pool.query('INSERT INTO invite_codes (code, email) VALUES ($1, $2)', [code, email()]);
      const username = uniq('lockbad');
      const r = await register({ username, email: email(), inviteCode: code });
      assert.equal(r.status, 403);
      assert.match(r.body.error, /invalid or already-used/);
      const row = (await pool.query('SELECT used_at FROM invite_codes WHERE code = $1', [code])).rows[0];
      assert.equal(row.used_at, null);
      const made = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
      assert.equal(made.rows.length, 0);
    } finally {
      process.env.REGISTRATION_MODE = 'open';
    }
  });

  await t.test('invalid email is 400', async () => {
    const u = await mk();
    const r = await post('/api/auth/email', u, { email: 'nope' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_email');
  });

  await t.test('set, cooldown, verify, reuse, unlocks the gate', async () => {
    const u = await mk();
    const e = email();
    const gated = await request(app).get('/api/characters').set(u.auth);
    assert.equal(gated.status, 403);

    const r = await post('/api/auth/email', u, { email: `  ${e.toUpperCase()} ` });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.email, e);
    assert.equal(sent[sent.length - 1].to, e);

    const again = await post('/api/auth/email/resend', u, {});
    assert.equal(again.status, 429);
    assert.equal(again.body.error, 'resend_cooldown');
    assert.ok(again.body.retryAfterSec > 0 && again.body.retryAfterSec <= 60);

    const token = lastToken();
    const v = await post('/api/auth/verify-email', null, { token });
    assert.equal(v.status, 200, v.text);
    const me = await request(app).get('/api/auth/me').set(u.auth);
    assert.equal(me.body.emailVerified, true);
    const ok = await request(app).get('/api/characters').set(u.auth);
    assert.notEqual(ok.status, 403);

    const reuse = await post('/api/auth/verify-email', null, { token });
    assert.equal(reuse.status, 410);
    assert.equal(reuse.body.error, 'link_expired');

    const lock = await post('/api/auth/email', u, { email: email() });
    assert.equal(lock.status, 409);
    assert.equal(lock.body.error, 'email_locked');
  });

  await t.test('resend after cooldown mails a fresh link and kills the old', async () => {
    const u = await mk();
    await post('/api/auth/email', u, { email: email() });
    const oldTok = lastToken();
    await pool.query(
      "UPDATE email_tokens SET created_at = now() - interval '2 minutes' WHERE user_id = $1", [u.id],
    );
    const n = sent.length;
    const r = await post('/api/auth/email/resend', u, {});
    assert.equal(r.status, 200, r.text);
    assert.equal(sent.length, n + 1);
    assert.equal((await post('/api/auth/verify-email', null, { token: oldTok })).status, 410);
    assert.equal((await post('/api/auth/verify-email', null, { token: lastToken() })).status, 200);
  });

  await t.test('resend without an email is 400', async () => {
    const u = await mk();
    // Legacy account: registered before emails were required.
    await pool.query('UPDATE users SET email = NULL WHERE id = $1', [u.id]);
    const r = await post('/api/auth/email/resend', u, {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_email');
  });

  await t.test('changing email invalidates the old link', async () => {
    const u = await mk();
    await post('/api/auth/email', u, { email: email() });
    const oldTok = lastToken();
    await backdate(u.id);
    const r = await post('/api/auth/email', u, { email: email() });
    assert.equal(r.status, 200);
    assert.equal((await post('/api/auth/verify-email', null, { token: oldTok })).status, 410);
    assert.equal((await post('/api/auth/verify-email', null, { token: lastToken() })).status, 200);
  });

  await t.test('verified email is taken (case-insensitive), at set and at verify', async () => {
    const a = await mk();
    const b = await mk();
    const c = await mk();
    const e = email();
    await post('/api/auth/email', a, { email: e });
    await post('/api/auth/email', c, { email: e }); // unverified claim by c coexists
    const cTok = lastToken();
    await post('/api/auth/verify-email', null, { token: (await (async () => {
      // a's token: the first of the two mails for e
      const mails = sent.filter((m) => m.to === e);
      return mails[0].text.match(/\/verify-email\/([0-9a-f-]{36})/)[1];
    })()) });
    const r = await post('/api/auth/email', b, { email: e.toUpperCase() });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'email_taken');
    const v = await post('/api/auth/verify-email', null, { token: cTok });
    assert.equal(v.status, 409);
    assert.equal(v.body.error, 'email_taken');
  });

  await t.test('invite-locked account cannot change email, may re-send its own', async () => {
    const u = await mk();
    const locked = email();
    const code = uniq('LOCK').toUpperCase();
    codes.push(code);
    await pool.query('INSERT INTO invite_codes (code, email, used_by, used_at) VALUES ($1, $2, $3, now())',
      [code, locked, u.id]);
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [locked, u.id]);
    const r = await post('/api/auth/email', u, { email: email() });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'email_locked');
    const same = await post('/api/auth/email', u, { email: locked.toUpperCase() });
    assert.equal(same.status, 200, same.text);
  });

  await t.test('send failure is 502 and the email stays set', async () => {
    const u = await mk();
    const e = email();
    __setSender(async () => { throw new Error('smtp down'); });
    const r = await post('/api/auth/email', u, { email: e });
    __setSender(async (m) => { sent.push(m); });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'email_failed');
    const me = await request(app).get('/api/auth/me').set(u.auth);
    assert.equal(me.body.email, e);
  });

  await t.test('POST /email shares the 60 s cooldown and changes nothing when throttled', async () => {
    const u = await mk();
    const e = email();
    assert.equal((await post('/api/auth/email', u, { email: e })).status, 200);
    const n = sent.length;
    const r = await post('/api/auth/email', u, { email: email() });
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'resend_cooldown');
    assert.ok(r.body.retryAfterSec > 0);
    assert.equal(sent.length, n);
    const me = await request(app).get('/api/auth/me').set(u.auth);
    assert.equal(me.body.email, e);
  });

  await t.test('10 sends per hour cap across set and resend', async () => {
    const u = await mk();
    await post('/api/auth/email', u, { email: email() });
    for (let i = 0; i < 9; i += 1) {
      await pool.query(
        `INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at, created_at, used_at)
         VALUES ($1, $2, 'verify_email', 'old@example.com', now() + interval '1 day',
                 now() - interval '30 minutes', now())`,
        [`cap_${u.id}_${i}`, u.id]);
    }
    await backdate(u.id); // clears the 60 s cooldown on the real row; rows stay within the hour
    const n = sent.length;
    for (const path of ['/api/auth/email', '/api/auth/email/resend']) {
      const r = await post(path, u, { email: email() });
      assert.equal(r.status, 429, path);
      assert.equal(r.body.error, 'resend_cooldown');
      assert.ok(r.body.retryAfterSec > 0 && r.body.retryAfterSec <= 3600);
    }
    assert.equal(sent.length, n);
  });

  await t.test('per-IP cap: 30 sends an hour across /email and /email/resend, 31st is 429 (own app)', async () => {
    // Own app, so this file's other tests (one supertest IP on the shared app) stay clear of the cap.
    const express = require('express');
    const authRouter = require('../src/auth/routes.js');
    const a = express();
    a.use(express.json());
    a.use('/api/auth', authRouter({ query: (...x) => pool.query(...x), connect: () => pool.connect() }));
    const u = await mk();
    const hit = (path) => request(a).post(path).set('Origin', ORIGIN).set(u.auth).send({ email: email() });
    for (let i = 0; i < 30; i += 1) {
      // Alternate the two routes: they share one count. Most of these are the per-user cooldown's 429; none is
      // the IP cap's.
      const r = await hit(i % 2 ? '/api/auth/email/resend' : '/api/auth/email');
      assert.notEqual(r.body.error, 'too_many_requests', `request ${i + 1}`);
    }
    for (const path of ['/api/auth/email', '/api/auth/email/resend']) {
      const r = await hit(path);
      assert.equal(r.status, 429, path);
      assert.equal(r.body.error, 'too_many_requests');
    }
  });

  await t.test('garbage token is 410', async () => {
    assert.equal((await post('/api/auth/verify-email', null, { token: 'x' })).status, 410);
  });
});
