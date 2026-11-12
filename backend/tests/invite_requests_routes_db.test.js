// Invite requests (public + admin) against a real database.
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

test('invite requests', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const users = [];
  const emails = [];
  const sent = [];
  let sender = async (m) => { sent.push(m); };
  const saved = {};
  for (const k of ['EMAIL_GATE_FORCE', 'CORS_ORIGINS', 'REGISTRATION_MODE']) saved[k] = process.env[k];
  process.env.EMAIL_GATE_FORCE = '1';
  process.env.CORS_ORIGINS = ORIGIN;
  process.env.REGISTRATION_MODE = 'invite';
  __setSender((m) => sender(m));
  t.after(async () => {
    __setSender(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await pool.query('DELETE FROM invite_requests WHERE email = ANY($1)', [emails]);
    await pool.query('DELETE FROM invite_codes WHERE email = ANY($1)', [emails]);
    if (users.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [users]);
    await pool.end();
  });

  let hash;
  // Users are inserted directly: /register is IP-capped on the shared app.
  const mkUser = async (role, addr = null) => {
    const username = uniq('ir');
    users.push(username);
    hash ??= await hashPassword('password123');
    const ins = await pool.query(
      `INSERT INTO users (username, password_hash, role, email, email_verified_at)
       VALUES ($1, $2, $3, $4, ${addr ? 'now()' : 'NULL'}) RETURNING id`,
      [username, hash, role, addr]);
    const r = await request(app).post('/api/auth/login').send({ username, password: 'password123' });
    assert.equal(r.status, 200, r.text);
    return { username, id: ins.rows[0].id, auth: { Authorization: `Bearer ${r.body.token}` } };
  };
  const email = () => { const e = `${uniq('inv')}@example.com`; emails.push(e); return e; };
  // Non-subject fixtures go in via SQL so the shared app's 10/h IP cap is not approached.
  const seedRequest = async (addr, status = 'pending', decidedAgo = null) => {
    const { rows } = await pool.query(
      `INSERT INTO invite_requests (email, status, decided_at)
       VALUES ($1, $2, CASE WHEN $3::text IS NULL THEN NULL ELSE now() - $3::interval END) RETURNING id`,
      [addr, status, decidedAgo]);
    return rows[0].id;
  };
  const rowsFor = async (addr) =>
    (await pool.query('SELECT * FROM invite_requests WHERE email = $1', [addr])).rows;
  const ask = (e, note) => request(app).post('/api/auth/invite-requests').send({ email: e, note });

  const admin = await mkUser('admin', email());
  const player = await mkUser('player', email());
  const approve = (id) => request(app).post(`/api/admin/invite-requests/${id}/approve`).set('Origin', ORIGIN).set(admin.auth);
  const reject = (id) => request(app).post(`/api/admin/invite-requests/${id}/reject`).set('Origin', ORIGIN).set(admin.auth);

  await t.test('options reports the mode', async () => {
    const r = await request(app).get('/api/auth/options');
    assert.deepEqual(r.body, { registrationMode: 'invite', inviteRequests: true });
    process.env.REGISTRATION_MODE = 'open';
    try {
      const o = await request(app).get('/api/auth/options');
      assert.deepEqual(o.body, { registrationMode: 'open', inviteRequests: false });
    } finally { process.env.REGISTRATION_MODE = 'invite'; }
  });

  await t.test('open mode: invite requests are 404 and no row is made', async () => {
    process.env.REGISTRATION_MODE = 'open';
    const e = email();
    try {
      assert.equal((await ask(e)).status, 404);
    } finally { process.env.REGISTRATION_MODE = 'invite'; }
    assert.equal((await rowsFor(e)).length, 0);
  });

  await t.test('invalid email is 400 invalid_email', async () => {
    const r = await ask('nope');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_email');
  });

  await t.test('duplicate pending (mixed case) makes one row; note trimmed and cut to 300', async () => {
    const e = email();
    const a = await ask(`  ${e.toUpperCase()} `, `  ${'n'.repeat(400)}  `);
    const b = await ask(e, 'second');
    assert.deepEqual(a.body, { ok: true });
    assert.deepEqual(b.body, { ok: true });
    const rows = await rowsFor(e);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note, 'n'.repeat(300));
  });

  await t.test('verified holder gets ok but no row', async () => {
    const e = email();
    await mkUser('player', e);
    const r = await ask(e);
    assert.deepEqual(r.body, { ok: true });
    assert.equal((await rowsFor(e)).length, 0);
  });

  await t.test('recently rejected: no new row; old rejection allows one', async () => {
    const recent = email();
    await seedRequest(recent, 'rejected', '1 day');
    assert.deepEqual((await ask(recent)).body, { ok: true });
    assert.equal((await rowsFor(recent)).length, 1);
    const old = email();
    await seedRequest(old, 'rejected', '8 days');
    assert.deepEqual((await ask(old)).body, { ok: true });
    assert.equal((await rowsFor(old)).length, 2);
  });

  await t.test('admin routes refuse non-admins and anonymous callers', async () => {
    const id = await seedRequest(email());
    assert.equal((await request(app).get('/api/admin/invite-requests').set(player.auth)).status, 403);
    assert.equal((await request(app).post(`/api/admin/invite-requests/${id}/approve`).set(player.auth)).status, 403);
    assert.equal((await request(app).post(`/api/admin/invite-requests/${id}/reject`).set(player.auth)).status, 403);
    assert.equal((await request(app).get('/api/admin/invite-requests')).status, 401);
    assert.equal((await rowsFor((await pool.query('SELECT email FROM invite_requests WHERE id=$1', [id])).rows[0].email))[0].status, 'pending');
  });

  await t.test('list filters by status, newest first', async () => {
    const e1 = email(); const e2 = email();
    const id1 = await seedRequest(e1, 'rejected', '1 day');
    const id2 = await seedRequest(e2, 'rejected', '1 day');
    const r = await request(app).get('/api/admin/invite-requests?status=rejected').set(admin.auth);
    assert.equal(r.status, 200);
    const ids = r.body.requests.map((x) => x.id);
    assert.ok(ids.indexOf(id2) !== -1 && ids.indexOf(id2) < ids.indexOf(id1), 'newest first');
    assert.ok(r.body.requests.every((x) => x.status === 'rejected'));
    const pend = await request(app).get('/api/admin/invite-requests?status=pending').set(admin.auth);
    assert.ok(!pend.body.requests.some((x) => x.id === id1));
    assert.equal((await request(app).get('/api/admin/invite-requests?status=bogus').set(admin.auth)).status, 400);
  });

  await t.test('approve mints an email-locked code, mails it, and the code registers', async () => {
    const e = email();
    await ask(`  ${e.toUpperCase()} `, 'please');
    const id = (await rowsFor(e))[0].id;
    const n = sent.length;
    const r = await approve(id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.request.status, 'approved');
    assert.equal(r.body.request.decidedBy, admin.id);
    assert.equal(r.body.request.codeUsed, false);
    const code = r.body.request.inviteCode;
    assert.ok(code);
    const c = (await pool.query('SELECT email::text AS email, note FROM invite_codes WHERE code = $1', [code])).rows[0];
    assert.equal(c.email, e);
    assert.equal(c.note, `request ${id}`);
    assert.equal(sent.length, n + 1);
    const mail = sent[sent.length - 1];
    assert.equal(mail.to, e);
    assert.ok(mail.text.includes(code));
    assert.ok(mail.text.includes(`${ORIGIN}/login?register=1&invite=${code}&email=${encodeURIComponent(e)}`));

    // Locked to the requester: another address cannot spend it (and failing does not burn it).
    const { claimInviteCode } = require('../src/auth/inviteCodes.js');
    assert.equal(await claimInviteCode(pool, code, email()), false);
    const username = uniq('irreg');
    users.push(username);
    const reg = await request(app).post('/api/auth/register')
      .send({ username, password: 'password123', inviteCode: code, email: e });
    assert.equal(reg.status, 201, reg.text);
    const listed = await request(app).get('/api/admin/invite-requests?status=approved').set(admin.auth);
    assert.equal(listed.body.requests.find((x) => x.id === id).codeUsed, true);
  });

  await t.test('two concurrent approves: one 200, one 409, one code, one mail', async () => {
    const e = email();
    const id = await seedRequest(e);
    const n = sent.length;
    // The first approve's send blocks inside its transaction (row lock held).
    // Release it only once the other approve is genuinely waiting on that lock,
    // so the two cannot have run one after the other.
    let release;
    const held = new Promise((r) => { release = r; });
    let entered;
    const inSend = new Promise((r) => { entered = r; });
    sender = async (m) => { entered(); await held; sent.push(m); };
    try {
      const first = approve(id).then((r) => r);
      await inSend;
      const second = approve(id).then((r) => r);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        const { rowCount } = await pool.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND datname = current_database() AND query ILIKE '%FOR UPDATE%'`);
        waiting = rowCount > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(waiting, 'second approve is blocked on the row lock');
      release();
      const [a, b] = await Promise.all([first, second]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409]);
      assert.equal([a, b].find((x) => x.status === 409).body.error, 'not_pending');
    } finally {
      release();
      sender = async (m) => { sent.push(m); };
    }
    assert.equal((await pool.query('SELECT 1 FROM invite_codes WHERE email = $1', [e])).rowCount, 1);
    assert.equal(sent.length, n + 1);
  });

  await t.test('throwing sender: 502, still pending, no new invite_codes row', async () => {
    const e = email();
    const id = await seedRequest(e);
    sender = async () => { throw new Error('smtp down'); };
    let r;
    try { r = await approve(id); } finally { sender = async (m) => { sent.push(m); }; }
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'email_failed');
    const row = (await rowsFor(e))[0];
    assert.equal(row.status, 'pending');
    assert.equal(row.invite_code, null);
    assert.equal((await pool.query('SELECT 1 FROM invite_codes WHERE email = $1', [e])).rowCount, 0);
    // and it can still be approved once mail is back
    assert.equal((await approve(id)).status, 200);
  });

  await t.test('no trusted link origin: 500 no_link_origin, nothing changed', async () => {
    const e = email();
    const id = await seedRequest(e);
    const savedEnv = { c: process.env.CORS_ORIGINS, a: process.env.APP_URL };
    delete process.env.CORS_ORIGINS; delete process.env.APP_URL;
    let r;
    try {
      r = await request(app).post(`/api/admin/invite-requests/${id}/approve`).set(admin.auth);
    } finally {
      process.env.CORS_ORIGINS = savedEnv.c;
      if (savedEnv.a !== undefined) process.env.APP_URL = savedEnv.a;
    }
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'no_link_origin');
    assert.equal((await rowsFor(e))[0].status, 'pending');
    assert.equal((await pool.query('SELECT 1 FROM invite_codes WHERE email = $1', [e])).rowCount, 0);
  });

  await t.test('reject mails the rejection; second decision is 409', async () => {
    const e = email();
    const id = await seedRequest(e);
    const n = sent.length;
    const r = await reject(id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.request.status, 'rejected');
    assert.equal(r.body.request.inviteCode, null);
    assert.equal(sent.length, n + 1);
    assert.equal(sent[sent.length - 1].to, e);
    assert.equal((await reject(id)).status, 409);
    assert.equal((await approve(id)).status, 409);
  });

  await t.test('throwing sender on reject: 502 and still pending', async () => {
    const e = email();
    const id = await seedRequest(e);
    sender = async () => { throw new Error('smtp down'); };
    let r;
    try { r = await reject(id); } finally { sender = async (m) => { sent.push(m); }; }
    assert.equal(r.status, 502);
    assert.equal((await rowsFor(e))[0].status, 'pending');
  });

  await t.test('per-IP cap: 11th request is 429 (own app)', async () => {
    const express = require('express');
    const inviteRequestRouter = require('../src/auth/inviteRequestRoutes.js');
    const a = express();
    a.use(express.json());
    a.use('/api', inviteRequestRouter({ query: (...x) => pool.query(...x), connect: () => pool.connect() }));
    for (let i = 0; i < 10; i += 1) {
      const r = await request(a).post('/api/auth/invite-requests').send({ email: email() });
      assert.equal(r.status, 200);
    }
    const r = await request(a).post('/api/auth/invite-requests').send({ email: email() });
    assert.equal(r.status, 429);
  });
});
