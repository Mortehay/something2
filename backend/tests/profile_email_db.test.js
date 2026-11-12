// Change a verified email via a confirmation link to the new address (profile Task 2), against a real database.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

require('./helpers/auth.js');
const request = require('supertest');
const { app } = require('../src/index.js');
const { __setSender } = require('../src/email/mailer.js');
const { hashPassword } = require('../src/auth/passwords.js');
const { issueEmailToken, peekEmailToken, VERIFY_TTL_MS, RESET_TTL_MS } = require('../src/auth/emailTokens.js');
const { maskEmail } = require('../src/email/templates.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const uniq = (p) => `${p}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const ORIGIN = 'http://localhost:5173';
const LINK_RE = /\/confirm-email\/([0-9a-f-]{36})/;

test('maskEmail keeps the first character and the domain', () => {
  assert.equal(maskEmail('alice@example.com'), 'a***@example.com');
  assert.equal(maskEmail('b@x.org'), 'b***@x.org');
});

test('change email routes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const users = [];
  const sent = [];
  const saved = {};
  // Fake SMTP values make smtpConfigured() true; the __setSender seam captures every message, so nothing ever
  // reaches a mail server (the host is also an unresolvable .invalid name).
  const ENV = {
    EMAIL_GATE_FORCE: '1', CORS_ORIGINS: ORIGIN, APP_URL: '',
    SMTP_HOST: 'smtp.invalid', SMTP_USER: 'u', SMTP_PASS: 'p',
  };
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  __setSender(async (m) => { sent.push(m); });
  t.after(async () => {
    __setSender(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (users.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [users]);
    await pool.end();
  });

  // Users are inserted directly (/register is IP-capped). This file's change requests share one app and one
  // supertest IP: keep the total of POST /email/change calls well under the route's per-IP cap (30/h).
  let hash;
  const email = () => `${uniq('x')}@example.com`;
  const mk = async ({ verified = true } = {}) => {
    const username = uniq('pe');
    users.push(username);
    hash ??= await hashPassword('password123');
    const addr = email();
    const ins = await pool.query(
      `INSERT INTO users (username, password_hash, role, email, email_verified_at)
       VALUES ($1, $2, 'player', $3, ${verified ? 'now()' : 'NULL'}) RETURNING id`,
      [username, hash, addr]);
    const r = await request(app).post('/api/auth/login').send({ username, password: 'password123' });
    assert.equal(r.status, 200, r.text);
    return { username, id: ins.rows[0].id, email: addr, auth: { Authorization: `Bearer ${r.body.token}` } };
  };
  const change = (u, body, origin = ORIGIN) => {
    const r = request(app).post('/api/auth/email/change').set(u.auth);
    return (origin ? r.set('Origin', origin) : r).send(body);
  };
  const confirm = (token) => request(app).post('/api/auth/email/change/confirm').send({ token });
  const peek = (token) => request(app).get(`/api/auth/email/change/${token}`);
  const me = async (u) => (await request(app).get('/api/auth/me').set(u.auth)).body;
  const row = async (u) => (await pool.query('SELECT email, email_verified_at FROM users WHERE id = $1', [u.id])).rows[0];
  const liveChange = async (u) => (await pool.query(
    `SELECT count(*)::int AS n FROM email_tokens
      WHERE user_id = $1 AND purpose = 'change_email' AND used_at IS NULL`, [u.id])).rows[0].n;
  const backdate = (u) => pool.query(
    "UPDATE email_tokens SET created_at = now() - interval '2 minutes' WHERE user_id = $1", [u.id]);
  const tokenOf = (m) => {
    const got = LINK_RE.exec(m.text);
    assert.ok(got, `confirm link in mail: ${m.subject}`);
    return got[1];
  };

  await t.test('happy path: link to the new address, old email stays until confirm, then switched + notice', async () => {
    const u = await mk();
    const next = email();
    const n = sent.length;
    const r = await change(u, { email: ` ${next.toUpperCase()} `, password: 'password123' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, { pendingEmail: next });
    assert.equal(sent.length, n + 1);
    const mail = sent[sent.length - 1];
    assert.equal(mail.to, next);
    assert.ok(mail.text.includes(`${ORIGIN}/confirm-email/`), mail.text);
    assert.ok(mail.html.includes(`${ORIGIN}/confirm-email/`));
    const token = tokenOf(mail);

    const before = await me(u);
    assert.equal(before.pendingEmail, next);
    assert.equal(before.mailEnabled, true);
    assert.equal(before.email, u.email);
    assert.equal(before.emailVerified, true);
    assert.equal((await row(u)).email, u.email);

    const c = await confirm(token);
    assert.equal(c.status, 200, c.text);
    assert.deepEqual(c.body, { ok: true });
    const after = await row(u);
    assert.equal(after.email, next);
    assert.notEqual(after.email_verified_at, null);
    const m2 = await me(u);
    assert.equal(m2.email, next);
    assert.equal(m2.pendingEmail, null);

    assert.equal(sent.length, n + 2);
    const notice = sent[sent.length - 1];
    assert.equal(notice.to, u.email);
    const masked = maskEmail(next);
    assert.ok(notice.text.includes(masked), notice.text);
    assert.ok(notice.html.includes(masked));
    assert.ok(!notice.text.includes(next) && !notice.html.includes(next), 'notice never shows the full new address');

    assert.equal((await confirm(token)).status, 410, 'single use');
  });

  await t.test('wrong password is 403 and nothing is mailed or issued', async () => {
    const u = await mk();
    const n = sent.length;
    const r = await change(u, { email: email(), password: 'nope-nope' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'wrong_password');
    assert.equal(sent.length, n);
    assert.equal(await liveChange(u), 0);
    assert.equal((await me(u)).pendingEmail, null);
  });

  await t.test('same email (any case) is 400 same_email', async () => {
    const u = await mk();
    const r = await change(u, { email: u.email.toUpperCase(), password: 'password123' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'same_email');
  });

  await t.test('invalid email is 400 invalid_email', async () => {
    const u = await mk();
    for (const bad of ['not-an-email', 'a@b.c, evil@x.com']) {
      const r = await change(u, { email: bad, password: 'password123' });
      assert.equal(r.status, 400, bad);
      assert.equal(r.body.error, 'invalid_email');
    }
  });

  await t.test('an address verified by another account is 409 email_taken, no mail', async () => {
    const other = await mk();
    const u = await mk();
    const n = sent.length;
    const r = await change(u, { email: other.email, password: 'password123' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'email_taken');
    assert.equal(sent.length, n);
    assert.equal(await liveChange(u), 0);
  });

  await t.test('cooldown: a second request within 60 s is 429 with retryAfterSec', async () => {
    const u = await mk();
    assert.equal((await change(u, { email: email(), password: 'password123' })).status, 200);
    const n = sent.length;
    const r = await change(u, { email: email(), password: 'password123' });
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'resend_cooldown');
    assert.ok(r.body.retryAfterSec > 0 && r.body.retryAfterSec <= 60, String(r.body.retryAfterSec));
    assert.equal(sent.length, n);
  });

  await t.test('cooldown is shared with verification sends (a fresh verify_email token blocks a change)', async () => {
    const u = await mk();
    await issueEmailToken(pool, { userId: u.id, purpose: 'verify_email', email: u.email, ttlMs: VERIFY_TTL_MS });
    const r = await change(u, { email: email(), password: 'password123' });
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'resend_cooldown');
  });

  await t.test('hourly cap counts verify_email and change_email together', async () => {
    const u = await mk();
    for (let i = 0; i < 5; i += 1) {
      await pool.query(
        `INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at, created_at, used_at)
         VALUES (md5(random()::text) || md5(random()::text), $1, $2, $3, now() + interval '1 day',
                 now() - interval '10 minutes', now())`,
        [u.id, 'verify_email', u.email]);
      await pool.query(
        `INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at, created_at, used_at)
         VALUES (md5(random()::text) || md5(random()::text), $1, $2, $3, now() + interval '1 day',
                 now() - interval '10 minutes', now())`,
        [u.id, 'change_email', email()]);
    }
    const r = await change(u, { email: email(), password: 'password123' });
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'resend_cooldown');
    assert.ok(r.body.retryAfterSec > 60, `hour window, not the 60 s cooldown: ${r.body.retryAfterSec}`);
  });

  await t.test('mail not configured is 503 mail_disabled and /me says mailEnabled:false', async () => {
    const u = await mk();
    process.env.SMTP_HOST = '';
    try {
      const n = sent.length;
      const r = await change(u, { email: email(), password: 'password123' });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'mail_disabled');
      assert.equal(sent.length, n);
      assert.equal(await liveChange(u), 0);
      assert.equal((await me(u)).mailEnabled, false);
    } finally {
      process.env.SMTP_HOST = ENV.SMTP_HOST;
    }
  });

  await t.test('no trusted link origin is 500 no_link_origin and nothing is issued', async () => {
    const u = await mk();
    process.env.CORS_ORIGINS = '';
    try {
      const r = await change(u, { email: email(), password: 'password123' }, null);
      assert.equal(r.status, 500);
      assert.equal(r.body.error, 'no_link_origin');
      assert.equal(await liveChange(u), 0);
    } finally {
      process.env.CORS_ORIGINS = ORIGIN;
    }
  });

  await t.test('cancel marks the pending change used: /me clears and the link is dead', async () => {
    const u = await mk();
    assert.equal((await change(u, { email: email(), password: 'password123' })).status, 200);
    const token = tokenOf(sent[sent.length - 1]);
    const r = await request(app).post('/api/auth/email/change/cancel').set(u.auth).send({});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal((await me(u)).pendingEmail, null);
    const c = await confirm(token);
    assert.equal(c.status, 410);
    assert.equal(c.body.error, 'link_expired');
    assert.equal((await row(u)).email, u.email);
  });

  await t.test('GET on the token never consumes it', async () => {
    const u = await mk();
    const next = email();
    assert.equal((await change(u, { email: next, password: 'password123' })).status, 200);
    const token = tokenOf(sent[sent.length - 1]);
    for (let i = 0; i < 2; i += 1) {
      const p = await peek(token);
      assert.equal(p.status, 200);
      assert.deepEqual(p.body, { live: true, email: next });
    }
    assert.equal((await confirm(token)).status, 200);
    const dead = await peek(token);
    assert.deepEqual(dead.body, { live: false, email: null });
    assert.deepEqual((await peek('not-a-uuid')).body, { live: false, email: null });
  });

  await t.test('confirm loses to a newer verified holder', async () => {
    const u = await mk();
    const other = await mk({ verified: false });
    const next = email();
    assert.equal((await change(u, { email: next, password: 'password123' })).status, 200);
    const token = tokenOf(sent[sent.length - 1]);
    await pool.query('UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2', [next, other.id]);
    const n = sent.length;
    const c = await confirm(token);
    assert.equal(c.status, 409);
    assert.equal(c.body.error, 'email_taken');
    const after = await row(u);
    assert.equal(after.email, u.email);
    assert.notEqual(after.email_verified_at, null);
    assert.equal(sent.length, n, 'no notice when nothing changed');
    assert.equal((await confirm(token)).status, 410, 'the token is spent');
  });

  await t.test('change invalidates pending reset and verify tokens', async () => {
    const u = await mk();
    const reset = await issueEmailToken(pool, { userId: u.id, purpose: 'reset_password', email: u.email, ttlMs: RESET_TTL_MS });
    const verify = await issueEmailToken(pool, { userId: u.id, purpose: 'verify_email', email: u.email, ttlMs: VERIFY_TTL_MS });
    await backdate(u); // clear the shared 60 s cooldown the verify token just started
    assert.equal((await change(u, { email: email(), password: 'password123' })).status, 200);
    const token = tokenOf(sent[sent.length - 1]);
    assert.ok(await peekEmailToken(pool, reset, 'reset_password'), 'request alone keeps the reset link');
    assert.equal((await confirm(token)).status, 200);
    assert.equal(await peekEmailToken(pool, reset, 'reset_password'), false);
    assert.equal(await peekEmailToken(pool, verify, 'verify_email'), false);
    const r = await request(app).post('/api/auth/password/reset').send({ token: reset, password: 'another-pass' });
    assert.equal(r.status, 410);
  });

  await t.test('a second request replaces the first (first link 410, second works)', async () => {
    const u = await mk();
    const first = email();
    const second = email();
    assert.equal((await change(u, { email: first, password: 'password123' })).status, 200);
    const t1 = tokenOf(sent[sent.length - 1]);
    await backdate(u);
    assert.equal((await change(u, { email: second, password: 'password123' })).status, 200);
    const t2 = tokenOf(sent[sent.length - 1]);
    assert.equal((await me(u)).pendingEmail, second);
    assert.deepEqual((await peek(t1)).body, { live: false, email: null });
    const c1 = await confirm(t1);
    assert.equal(c1.status, 410);
    assert.equal(c1.body.error, 'link_expired');
    assert.equal((await confirm(t2)).status, 200);
    assert.equal((await row(u)).email, second);
  });

  await t.test('an address held UNverified elsewhere can still be claimed', async () => {
    const other = await mk({ verified: false });
    const u = await mk();
    assert.equal((await change(u, { email: other.email, password: 'password123' })).status, 200);
    assert.equal((await confirm(tokenOf(sent[sent.length - 1]))).status, 200);
    assert.equal((await row(u)).email, other.email);
  });

  await t.test('gate active: an unverified account cannot use change or cancel', async () => {
    const u = await mk({ verified: false });
    const r = await change(u, { email: email(), password: 'password123' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'email_not_verified');
    const c = await request(app).post('/api/auth/email/change/cancel').set(u.auth).send({});
    assert.equal(c.status, 403);
  });

  await t.test('change and cancel need a session', async () => {
    assert.equal((await request(app).post('/api/auth/email/change').send({ email: email(), password: 'x' })).status, 401);
    assert.equal((await request(app).post('/api/auth/email/change/cancel').send({})).status, 401);
  });
});
