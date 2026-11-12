// Change password (profile Task 3), against a real database.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { Pool } = require('pg');

require('./helpers/auth.js');
const request = require('supertest');
const { app } = require('../src/index.js');
const { hashPassword } = require('../src/auth/passwords.js');
const authRouter = require('../src/auth/routes.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const uniq = (p) => `${p}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

test('change password', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const users = [];
  t.after(async () => {
    if (users.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [users]);
    await pool.end();
  });
  let hash;
  const mk = async (target = app) => {
    const username = uniq('pw');
    users.push(username);
    hash ??= await hashPassword('password123');
    const ins = await pool.query(
      `INSERT INTO users (username, password_hash, role, email, email_verified_at)
       VALUES ($1, $2, 'player', $3, now()) RETURNING id`,
      [username, hash, `${username}@example.com`]);
    const r = await request(target).post('/api/auth/login').send({ username, password: 'password123' });
    assert.equal(r.status, 200, r.text);
    return { username, id: ins.rows[0].id, token: r.body.token, auth: { Authorization: `Bearer ${r.body.token}` } };
  };
  const change = (u, body, target = app) => request(target).post('/api/auth/password/change').set(u.auth).send(body);
  const hashOf = async (u) => (await pool.query('SELECT password_hash FROM users WHERE id = $1', [u.id])).rows[0].password_hash;

  await t.test('other sessions signed out, returned token works', async () => {
    const u = await mk();
    const r = await change(u, { currentPassword: 'password123', newPassword: 'newpass456' });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.body.token);
    assert.equal((await request(app).get('/api/auth/me').set(u.auth)).status, 401);
    assert.equal((await request(app).get('/api/auth/me').set({ Authorization: `Bearer ${r.body.token}` })).status, 200);
    assert.equal((await request(app).post('/api/auth/login').send({ username: u.username, password: 'newpass456' })).status, 200);
    assert.equal((await request(app).post('/api/auth/login').send({ username: u.username, password: 'password123' })).status, 401);
  });

  await t.test('wrong current password is 403 and changes nothing', async () => {
    const u = await mk();
    const before = await hashOf(u);
    const r = await change(u, { currentPassword: 'nope', newPassword: 'newpass456' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'wrong_password');
    assert.equal(await hashOf(u), before);
    assert.equal((await request(app).get('/api/auth/me').set(u.auth)).status, 200);
  });

  await t.test('same password is 400, empty new is 400', async () => {
    const u = await mk();
    const same = await change(u, { currentPassword: 'password123', newPassword: 'password123' });
    assert.equal(same.status, 400);
    assert.equal(same.body.error, 'same_password');
    const empty = await change(u, { currentPassword: 'password123', newPassword: '' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'password is required');
  });

  await t.test('limiter: 11th attempt across password and email routes is 429', async () => {
    const own = express();
    own.use(express.json());
    own.use('/api/auth', authRouter(pool));
    const u = await mk(own);
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await change(u, { currentPassword: 'bad', newPassword: 'x1' }, own)).status, 403);
    }
    for (let i = 0; i < 5; i += 1) {
      const r = await request(own).post('/api/auth/email/change').set(u.auth)
        .send({ email: 'a@example.com', password: 'bad' });
      assert.notEqual(r.status, 429);
    }
    const r = await change(u, { currentPassword: 'bad', newPassword: 'x1' }, own);
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'too_many_requests');
  });
});
