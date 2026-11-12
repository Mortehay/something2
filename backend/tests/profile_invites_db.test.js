// Player invite codes (profile Task 4): create (3 per rolling 24 h), list, revoke, against a real database.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

require('./helpers/auth.js');
const request = require('supertest');
const { app } = require('../src/index.js');
const { hashPassword } = require('../src/auth/passwords.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const uniq = (p) => `${p}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

test('player invite codes', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const users = [];
  const prevMode = process.env.REGISTRATION_MODE;
  t.after(async () => {
    if (prevMode === undefined) delete process.env.REGISTRATION_MODE; else process.env.REGISTRATION_MODE = prevMode;
    if (users.length) {
      await pool.query('DELETE FROM invite_codes WHERE created_by IN (SELECT id FROM users WHERE username = ANY($1))', [users]);
      await pool.query('DELETE FROM users WHERE username = ANY($1)', [users]);
    }
    await pool.end();
  });

  let hash;
  const mk = async (role = 'player') => {
    const username = uniq('pi');
    users.push(username);
    hash ??= await hashPassword('password123');
    const ins = await pool.query(
      `INSERT INTO users (username, password_hash, role, email, email_verified_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING id`,
      [username, hash, role, `${username}@example.com`]);
    const r = await request(app).post('/api/auth/login').send({ username, password: 'password123' });
    assert.equal(r.status, 200, r.text);
    return { username, id: ins.rows[0].id, auth: { Authorization: `Bearer ${r.body.token}` } };
  };
  const create = (u) => request(app).post('/api/auth/invites').set(u.auth).send({});
  const list = (u) => request(app).get('/api/auth/invites').set(u.auth);
  const revoke = (u, code) => request(app).post(`/api/auth/invites/${code}/revoke`).set(u.auth).send({});

  await t.test('3 creates ok, 4th is 429 with retryAfterSec', async () => {
    const u = await mk();
    for (let i = 0; i < 3; i += 1) {
      const r = await create(u);
      assert.equal(r.status, 201, r.text);
      assert.match(r.body.invite.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      assert.equal(r.body.invite.usedAt, null);
      assert.equal(r.body.invite.revokedAt, null);
    }
    const note = await pool.query('SELECT note, created_by FROM invite_codes WHERE created_by = $1 LIMIT 1', [u.id]);
    assert.equal(note.rows[0].note, `player ${u.username}`);
    const l = await list(u);
    assert.equal(l.body.remainingToday, 0);
    const r4 = await create(u);
    assert.equal(r4.status, 429);
    assert.equal(r4.body.error, 'invite_limit');
    assert.ok(Number.isInteger(r4.body.retryAfterSec) && r4.body.retryAfterSec > 86300 && r4.body.retryAfterSec <= 86400,
      `retryAfterSec ${r4.body.retryAfterSec}`);
    assert.equal((await pool.query('SELECT count(*)::int n FROM invite_codes WHERE created_by = $1', [u.id])).rows[0].n, 3);
  });

  await t.test('retryAfterSec follows the oldest code in the window; old codes free a slot', async () => {
    const u = await mk();
    for (let i = 0; i < 3; i += 1) assert.equal((await create(u)).status, 201);
    await pool.query(
      `UPDATE invite_codes SET created_at = now() - interval '23 hours'
        WHERE code = (SELECT code FROM invite_codes WHERE created_by = $1 ORDER BY created_at LIMIT 1)`, [u.id]);
    const l = await list(u);
    assert.equal(l.body.remainingToday, 0);
    const r = await create(u);
    assert.equal(r.status, 429);
    assert.ok(r.body.retryAfterSec > 3500 && r.body.retryAfterSec <= 3600, `retryAfterSec ${r.body.retryAfterSec}`);
    // The list's countdown is the same computation as the 429's.
    assert.ok(Math.abs(l.body.nextAvailableInSec - r.body.retryAfterSec) <= 2,
      `nextAvailableInSec ${l.body.nextAvailableInSec} vs retryAfterSec ${r.body.retryAfterSec}`);
    await pool.query("UPDATE invite_codes SET created_at = now() - interval '25 hours' WHERE created_by = $1", [u.id]);
    assert.equal((await create(u)).status, 201);
  });

  await t.test('a revoked code still counts toward the cap', async () => {
    const u = await mk();
    const first = await create(u);
    assert.equal(first.status, 201);
    assert.equal((await revoke(u, first.body.invite.code)).status, 200);
    assert.equal((await create(u)).status, 201);
    assert.equal((await create(u)).status, 201);
    const r = await create(u);
    assert.equal(r.status, 429, r.text);
    assert.equal(r.body.error, 'invite_limit');
  });

  await t.test('concurrent creates respect the cap', async () => {
    const u = await mk();
    assert.equal((await create(u)).status, 201);
    assert.equal((await create(u)).status, 201);
    const rs = await Promise.all([create(u), create(u)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 429]);
    assert.equal((await pool.query('SELECT count(*)::int n FROM invite_codes WHERE created_by = $1', [u.id])).rows[0].n, 3);
  });

  await t.test('a burst of 8 concurrent creates from zero yields exactly 3', async () => {
    const u = await mk();
    const rs = await Promise.all(Array.from({ length: 8 }, () => create(u)));
    assert.equal(rs.filter((r) => r.status === 201).length, 3, JSON.stringify(rs.map((r) => r.status)));
    assert.equal(rs.filter((r) => r.status === 429).length, 5);
    assert.equal((await pool.query('SELECT count(*)::int n FROM invite_codes WHERE created_by = $1', [u.id])).rows[0].n, 3);
  });

  await t.test('admin is unlimited and remainingToday is null', async () => {
    const a = await mk('admin');
    for (let i = 0; i < 4; i += 1) assert.equal((await create(a)).status, 201);
    const l = await list(a);
    assert.equal(l.status, 200);
    assert.equal(l.body.remainingToday, null);
    assert.equal(l.body.nextAvailableInSec, null);
    assert.equal(l.body.invites.length, 4);
  });

  await t.test('list shows only own codes, newest first, with the user who used one', async () => {
    const u = await mk();
    const other = await mk();
    const c1 = (await create(u)).body.invite.code;
    const c2 = (await create(u)).body.invite.code;
    await create(other);
    const user = await mk();
    await pool.query('UPDATE invite_codes SET used_at = now(), used_by = $2 WHERE code = $1', [c1, user.id]);
    const l = await list(u);
    assert.equal(l.status, 200);
    assert.equal(l.body.remainingToday, 1);
    assert.equal(l.body.nextAvailableInSec, null, 'not capped => null');
    assert.deepEqual(l.body.invites.map((i) => i.code), [c2, c1]);
    const used = l.body.invites.find((i) => i.code === c1);
    assert.equal(used.usedBy, user.username);
    assert.ok(used.usedAt);
    assert.equal(l.body.invites.find((i) => i.code === c2).usedBy, null);
    assert.deepEqual(Object.keys(used).sort(), ['code', 'createdAt', 'revokedAt', 'usedAt', 'usedBy']);
  });

  await t.test('revoke: own ok, someone else 404, unknown 404, used 409', async () => {
    const u = await mk();
    const other = await mk();
    const code = (await create(u)).body.invite.code;
    const used = (await create(u)).body.invite.code;
    const theirs = await revoke(other, code);
    assert.equal(theirs.status, 404);
    assert.equal(theirs.body.error, 'not_found');
    assert.equal((await pool.query('SELECT revoked_at FROM invite_codes WHERE code = $1', [code])).rows[0].revoked_at, null);
    assert.equal((await revoke(u, 'ZZZZ-ZZZZ-ZZZZ')).body.error, 'not_found');
    const ok = await revoke(u, code);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.invite.revokedAt);
    assert.equal(ok.body.invite.code, code);
    await pool.query('UPDATE invite_codes SET used_at = now(), used_by = $2 WHERE code = $1', [used, other.id]);
    const r = await revoke(u, used);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'already_used');
  });

  await t.test('requires auth', async () => {
    assert.equal((await request(app).get('/api/auth/invites')).status, 401);
    assert.equal((await request(app).post('/api/auth/invites').send({})).status, 401);
  });

  await t.test('revoked code cannot register', async () => {
    const u = await mk();
    const good = (await create(u)).body.invite.code;
    const bad = (await create(u)).body.invite.code;
    assert.equal((await revoke(u, bad)).status, 200);
    process.env.REGISTRATION_MODE = 'invite';
    const name = uniq('reg');
    users.push(name);
    const r = await request(app).post('/api/auth/register')
      .send({ username: name, password: 'password123', inviteCode: bad, email: `${name}@example.com` });
    assert.equal(r.status, 403, r.text);
    assert.equal((await pool.query('SELECT 1 FROM users WHERE username = $1', [name])).rows.length, 0);
    // Control: the same flow with a live code succeeds, so the 403 above is the revocation.
    const r2 = await request(app).post('/api/auth/register')
      .send({ username: name, password: 'password123', inviteCode: good, email: `${name}@example.com` });
    assert.equal(r2.status, 201, r2.text);
  });
});
