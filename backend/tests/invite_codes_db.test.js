// SOMET-381. Invite-gated registration, against a real database.
//
// The interesting property is not "a good code works" -- it is that a code
// can be spent EXACTLY ONCE even when two registrations race for it, and that
// a failed registration does not burn one. Both are transaction behaviour, so
// neither can be tested against a stubbed pool.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

require('./helpers/auth.js');
const request = require('supertest');
const { app } = require('../src/index.js');
const { claimInviteCode } = require('../src/auth/inviteCodes.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to mutate a real database (this test writes users)'
  : false;

const uniq = (p) => `${p}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

test('invite-gated registration', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const made = { users: [], codes: [] };
  t.after(async () => {
    // Explicit cleanup: client.release() does NOT roll back, a lesson this
    // project has already paid for once.
    if (made.users.length) {
      await pool.query('DELETE FROM users WHERE username = ANY($1)', [made.users]);
    }
    if (made.codes.length) {
      await pool.query('DELETE FROM invite_codes WHERE code = ANY($1)', [made.codes]);
    }
    await pool.end();
  });

  const mint = async (code) => {
    made.codes.push(code);
    await pool.query('INSERT INTO invite_codes (code) VALUES ($1)', [code]);
    return code;
  };

  const prevMode = process.env.REGISTRATION_MODE;
  t.after(() => { process.env.REGISTRATION_MODE = prevMode; });

  await t.test('open mode ignores invite codes entirely', async () => {
    process.env.REGISTRATION_MODE = 'open';
    const username = uniq('open_user');
    made.users.push(username);
    const res = await request(app).post('/api/auth/register')
      .send({ username, password: 'password123', email: `${Math.random().toString(36).slice(2)}@example.com` });
    assert.equal(res.status, 201, res.text);
  });

  await t.test('closed mode refuses even with a valid code', async () => {
    process.env.REGISTRATION_MODE = 'closed';
    const code = await mint(uniq('CLOSED').toUpperCase());
    const username = uniq('closed_user');
    const res = await request(app).post('/api/auth/register')
      .send({ username, password: 'password123', email: `${Math.random().toString(36).slice(2)}@example.com`, inviteCode: code });
    assert.equal(res.status, 403);
    const check = await pool.query('SELECT used_at FROM invite_codes WHERE code = $1', [code]);
    assert.equal(check.rows[0].used_at, null, 'a refused registration must not burn the code');
  });

  await t.test('invite mode requires a code, and rejects an unknown one', async () => {
    process.env.REGISTRATION_MODE = 'invite';
    const noCode = await request(app).post('/api/auth/register')
      .send({ username: uniq('nc'), password: 'password123', email: `${Math.random().toString(36).slice(2)}@example.com` });
    assert.equal(noCode.status, 400);

    const bad = await request(app).post('/api/auth/register')
      .send({ username: uniq('bad'), password: 'password123', email: `${Math.random().toString(36).slice(2)}@example.com`, inviteCode: 'NOPE-NOPE-NOPE' });
    assert.equal(bad.status, 403);
    // The same message for "no such code" and "already used": telling them
    // apart lets someone enumerate which codes exist.
    assert.match(bad.body.error, /invalid or already-used/);
  });

  await t.test('a valid code registers once and is then spent', async () => {
    process.env.REGISTRATION_MODE = 'invite';
    const code = await mint(uniq('GOOD').toUpperCase());
    const first = uniq('first_user');
    made.users.push(first);

    const ok = await request(app).post('/api/auth/register')
      .send({ username: first, password: 'password123', email: `${Math.random().toString(36).slice(2)}@example.com`, inviteCode: code });
    assert.equal(ok.status, 201, ok.text);

    const row = (await pool.query(
      'SELECT used_at, used_by FROM invite_codes WHERE code = $1', [code])).rows[0];
    assert.ok(row.used_at, 'the code should be marked used');
    assert.ok(row.used_by, 'the code should record who spent it');

    // Second attempt on the same code must fail.
    const second = uniq('second_user');
    const again = await request(app).post('/api/auth/register')
      .send({ username: second, password: 'password123', email: `${Math.random().toString(36).slice(2)}@example.com`, inviteCode: code });
    assert.equal(again.status, 403);
    const exists = await pool.query('SELECT id FROM users WHERE username = $1', [second]);
    assert.equal(exists.rows.length, 0, 'no account may be created on a spent code');
  });

  await t.test('two transactions racing the same code: exactly one wins', async () => {
    // THE assertion this file exists for, and it is deliberately NOT driven
    // through HTTP. Password hashing runs before the transaction and costs
    // ~550 ms of CPU per request, so concurrent registrations serialise and
    // the race window never opens -- an HTTP-level version of this test passes
    // just as happily against a SELECT-then-UPDATE implementation. Verified by
    // mutation: swapping claimInviteCode for SELECT-then-UPDATE leaves the
    // HTTP test green and fails THIS one.
    const code = await mint(uniq('TXRACE').toUpperCase());
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      // A claims first but does not commit; B's UPDATE must block on A's row
      // lock rather than reading a stale `used_at IS NULL`.
      const aWon = await claimInviteCode(a, code);
      assert.equal(aWon, true, 'the first claimant should win');

      const bAttempt = claimInviteCode(b, code);
      // Give B time to reach the lock and block on it. If the implementation
      // is SELECT-then-UPDATE, B does NOT block -- it reads the uncommitted-
      // invisible row as unused and resolves true right here.
      const settledEarly = await Promise.race([
        bAttempt.then(() => 'settled'),
        new Promise((r) => setTimeout(() => r('blocked'), 400)),
      ]);
      assert.equal(settledEarly, 'blocked',
        'the second claimant must block on the first transaction, not read around it');

      await a.query('COMMIT');
      assert.equal(await bAttempt, false, 'the second claimant must lose once the first commits');
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }
  });

  await t.test('invite mode: a bad code never reveals that an email is taken', async () => {
    // An email held VERIFIED by another account. Without a valid code the
    // caller must get the code error, not email_taken -- otherwise /register
    // is an oracle for "does this address have an account".
    process.env.REGISTRATION_MODE = 'invite';
    const holder = uniq('em_holder');
    made.users.push(holder);
    const held = `${Math.random().toString(36).slice(2)}@example.com`;
    await pool.query(
      `INSERT INTO users (username, password_hash, role, email, email_verified_at)
       VALUES ($1, 'x', 'player', $2, now())`, [holder, held]);

    const bad = await request(app).post('/api/auth/register')
      .send({ username: uniq('em_probe'), password: 'password123', email: held.toUpperCase(), inviteCode: 'NOPE-NOPE-NOPE' });
    assert.equal(bad.status, 403, bad.text);
    assert.match(bad.body.error, /invalid or already-used/);

    // With a valid code the caller does learn it -- and the code survives.
    const code = await mint(uniq('EMTAKEN').toUpperCase());
    const probe = uniq('em_probe2');
    const taken = await request(app).post('/api/auth/register')
      .send({ username: probe, password: 'password123', email: held, inviteCode: code });
    assert.equal(taken.status, 409, taken.text);
    assert.equal(taken.body.error, 'email_taken');
    const row = (await pool.query(
      'SELECT used_at, used_by FROM invite_codes WHERE code = $1', [code])).rows[0];
    assert.equal(row.used_at, null, 'email_taken must roll the claim back');
    assert.equal(row.used_by, null);
    const none = await pool.query('SELECT id FROM users WHERE username = $1', [probe]);
    assert.equal(none.rows.length, 0);
  });

  await t.test('a code is not burned when the registration itself fails', async () => {
    process.env.REGISTRATION_MODE = 'invite';
    const code = await mint(uniq('TAKEN').toUpperCase());
    const taken = uniq('taken_user');
    made.users.push(taken);

    // Create the username first, then try to register it again WITH a code.
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player')", [taken]);
    const res = await request(app).post('/api/auth/register')
      .send({ username: taken, password: 'password123', email: `${Math.random().toString(36).slice(2)}@example.com`, inviteCode: code });
    assert.equal(res.status, 409);

    const row = (await pool.query(
      'SELECT used_at FROM invite_codes WHERE code = $1', [code])).rows[0];
    assert.equal(row.used_at, null,
      'a registration that created no account must leave the code spendable');
  });
});
