// Set / resend / verify account email against a real database.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

require('./helpers/auth.js');
const request = require('supertest');
const { app } = require('../src/index.js');
const { __setSender } = require('../src/email/mailer.js');

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

  const mk = async () => {
    const username = uniq('em');
    users.push(username);
    const r = await request(app).post('/api/auth/register').send({ username, password: 'password123' });
    assert.equal(r.status, 201, r.text);
    return { username, id: r.body.user.id, auth: { Authorization: `Bearer ${r.body.token}` } };
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
  const email = () => `${uniq('x')}@example.com`;

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
    const r = await post('/api/auth/email/resend', u, {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_email');
  });

  await t.test('changing email invalidates the old link', async () => {
    const u = await mk();
    await post('/api/auth/email', u, { email: email() });
    const oldTok = lastToken();
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

  await t.test('garbage token is 410', async () => {
    assert.equal((await post('/api/auth/verify-email', null, { token: 'x' })).status, 410);
  });
});
