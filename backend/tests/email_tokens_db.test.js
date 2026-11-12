// Email tokens: single-use, hashed, expiring. Raced with two real clients.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const {
  issueEmailToken, consumeEmailToken, peekEmailToken, lastIssuedAt,
  VERIFY_TTL_MS, RESET_TTL_MS,
} = require('../src/auth/emailTokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to mutate a real database' : false;
const uniq = (p) => `${p}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

test('email tokens', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const names = [];
  t.after(async () => {
    if (names.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [names]);
    await pool.end();
  });
  const mkUser = async () => {
    const username = uniq('tok_user');
    names.push(username);
    const { rows } = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [username]);
    return rows[0].id;
  };

  await t.test('constants', () => {
    assert.equal(VERIFY_TTL_MS, 24 * 3600e3);
    assert.equal(RESET_TTL_MS, 24 * 3600e3);
  });

  await t.test('issue then consume returns user+email once', async () => {
    const userId = await mkUser();
    const raw = await issueEmailToken(pool, { userId, purpose: 'verify_email', email: 'a@x.com', ttlMs: VERIFY_TTL_MS });
    assert.deepEqual(await consumeEmailToken(pool, raw, 'verify_email'), { userId, email: 'a@x.com' });
    assert.equal(await consumeEmailToken(pool, raw, 'verify_email'), null);
  });

  await t.test('stores only a 64-hex hash, not the raw token', async () => {
    const userId = await mkUser();
    const raw = await issueEmailToken(pool, { userId, purpose: 'verify_email', email: 'b@x.com', ttlMs: VERIFY_TTL_MS });
    const { rows } = await pool.query('SELECT token_hash FROM email_tokens WHERE user_id=$1', [userId]);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, raw);
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  });

  await t.test('concurrent consume: exactly one wins', async () => {
    const userId = await mkUser();
    const raw = await issueEmailToken(pool, { userId, purpose: 'reset_password', email: 'c@x.com', ttlMs: RESET_TTL_MS });
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      assert.ok(await consumeEmailToken(a, raw, 'reset_password'));
      const bAttempt = consumeEmailToken(b, raw, 'reset_password');
      const early = await Promise.race([
        bAttempt.then(() => 'settled'),
        new Promise((r) => setTimeout(() => r('blocked'), 400)),
      ]);
      assert.equal(early, 'blocked', 'second consumer must block on the first row lock');
      await a.query('COMMIT');
      assert.equal(await bAttempt, null);
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }
  });

  await t.test('expired token is refused', async () => {
    const userId = await mkUser();
    const raw = await issueEmailToken(pool, { userId, purpose: 'verify_email', email: 'd@x.com', ttlMs: -1000 });
    assert.equal(await peekEmailToken(pool, raw, 'verify_email'), false);
    assert.equal(await consumeEmailToken(pool, raw, 'verify_email'), null);
  });

  await t.test('reissue invalidates the older token (same purpose only)', async () => {
    const userId = await mkUser();
    const first = await issueEmailToken(pool, { userId, purpose: 'verify_email', email: 'e@x.com', ttlMs: VERIFY_TTL_MS });
    const other = await issueEmailToken(pool, { userId, purpose: 'reset_password', email: 'e@x.com', ttlMs: RESET_TTL_MS });
    const second = await issueEmailToken(pool, { userId, purpose: 'verify_email', email: 'e@x.com', ttlMs: VERIFY_TTL_MS });
    assert.equal(await consumeEmailToken(pool, first, 'verify_email'), null);
    assert.ok(await consumeEmailToken(pool, second, 'verify_email'));
    assert.ok(await consumeEmailToken(pool, other, 'reset_password'));
  });

  await t.test('wrong purpose and non-UUID input yield null', async () => {
    const userId = await mkUser();
    const raw = await issueEmailToken(pool, { userId, purpose: 'verify_email', email: 'f@x.com', ttlMs: VERIFY_TTL_MS });
    assert.equal(await consumeEmailToken(pool, raw, 'reset_password'), null);
    assert.equal(await consumeEmailToken(pool, 'not-a-uuid', 'verify_email'), null);
    assert.equal(await peekEmailToken(pool, undefined, 'verify_email'), false);
    assert.ok(await consumeEmailToken(pool, raw.toUpperCase(), 'verify_email'), 'case-insensitive');
  });

  await t.test('peek is true then false after consume', async () => {
    const userId = await mkUser();
    const raw = await issueEmailToken(pool, { userId, purpose: 'reset_password', email: 'g@x.com', ttlMs: RESET_TTL_MS });
    assert.equal(await peekEmailToken(pool, raw, 'reset_password'), true);
    assert.equal(await peekEmailToken(pool, raw, 'reset_password'), true, 'peek does not consume');
    await consumeEmailToken(pool, raw, 'reset_password');
    assert.equal(await peekEmailToken(pool, raw, 'reset_password'), false);
  });

  await t.test('lastIssuedAt', async () => {
    const userId = await mkUser();
    assert.equal(await lastIssuedAt(pool, userId, 'verify_email'), null);
    await issueEmailToken(pool, { userId, purpose: 'verify_email', email: 'h@x.com', ttlMs: VERIFY_TTL_MS });
    const d = await lastIssuedAt(pool, userId, 'verify_email');
    assert.ok(d instanceof Date);
    assert.ok(Date.now() - d.getTime() < 10000);
    assert.equal(await lastIssuedAt(pool, userId, 'reset_password'), null);
  });
});
