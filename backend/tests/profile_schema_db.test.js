// Profile schema (change_email token purpose, player-created invite codes),
// against a real database. The CHECK and the claim guard are tested by
// provoking them, not by reading catalog rows.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const { claimInviteCode } = require('../src/auth/inviteCodes.js');
const { CHANGE_EMAIL_TTL_MS } = require('../src/auth/emailTokens.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to mutate a real database (this test writes users)'
  : false;

const uniq = (p) => `${p}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

test('profile schema', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const usernames = [];
  const codes = [];
  t.after(async () => {
    if (codes.length) await pool.query('DELETE FROM invite_codes WHERE code = ANY($1::citext[])', [codes]);
    if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames]);
    await pool.end();
  });

  const addUser = async () => {
    const username = uniq('prof');
    usernames.push(username);
    const { rows } = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [username]);
    return rows[0].id;
  };
  const addToken = (userId, purpose) => pool.query(
    `INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at)
     VALUES ($1, $2, $3, 'a@x.com', now() + interval '1 hour')`,
    [uniq('h'), userId, purpose]);

  await t.test('CHANGE_EMAIL_TTL_MS is 24 h', () => {
    assert.strictEqual(CHANGE_EMAIL_TTL_MS, 24 * 3600e3);
  });

  await t.test('email_tokens accepts change_email, rejects unknown purposes', async () => {
    const id = await addUser();
    await addToken(id, 'change_email');
    await addToken(id, 'verify_email');
    await assert.rejects(addToken(id, 'bogus'), { code: '23514' });
  });

  await t.test('invite_codes has created_by and revoked_at', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'invite_codes' AND column_name IN ('created_by','revoked_at')`);
    assert.strictEqual(rows.length, 2);
  });

  await t.test('the (created_by, created_at) index exists', async () => {
    const { rows } = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'invite_codes' AND indexname = 'invite_codes_created_by_created_at_index'");
    assert.strictEqual(rows.length, 1);
    assert.match(rows[0].indexdef, /\(created_by, created_at\)/);
  });

  await t.test('created_by is set NULL when the creator is deleted', async () => {
    const id = await addUser();
    const code = uniq('CB');
    codes.push(code);
    await pool.query('INSERT INTO invite_codes (code, created_by) VALUES ($1, $2)', [code, id]);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    const { rows } = await pool.query('SELECT created_by FROM invite_codes WHERE code = $1', [code]);
    assert.strictEqual(rows[0].created_by, null);
  });

  await t.test('claimInviteCode refuses a revoked unused code, accepts a live one', async () => {
    const live = uniq('LV');
    const dead = uniq('RV');
    codes.push(live, dead);
    await pool.query('INSERT INTO invite_codes (code) VALUES ($1)', [live]);
    await pool.query('INSERT INTO invite_codes (code, revoked_at) VALUES ($1, now())', [dead]);
    assert.strictEqual(await claimInviteCode(pool, dead), false);
    const { rows } = await pool.query('SELECT used_at FROM invite_codes WHERE code = $1', [dead]);
    assert.strictEqual(rows[0].used_at, null);
    assert.strictEqual(await claimInviteCode(pool, live), true);
  });
});

// Down migration, with a recording pgm (no DB writes): it must restore the
// old two-purpose CHECK after clearing rows that would violate it.
test('down restores the original purpose CHECK', () => {
  const calls = [];
  const rec = (name) => (...a) => calls.push({ name, a });
  const pgm = {
    sql: rec('sql'), dropConstraint: rec('dropConstraint'), addConstraint: rec('addConstraint'),
    dropIndex: rec('dropIndex'), dropColumns: rec('dropColumns'),
  };
  require('../migrations/1714440888000_profile.js').down(pgm);
  const add = calls.find((c) => c.name === 'addConstraint');
  assert.strictEqual(add.a[1], 'email_tokens_purpose_check');
  assert.strictEqual(add.a[2].check, "purpose IN ('verify_email','reset_password')");
  const del = calls.findIndex((c) => c.name === 'sql' && /change_email/.test(c.a[0]));
  assert.ok(del !== -1 && del < calls.indexOf(add), 'change_email rows cleared before the CHECK is restored');
  assert.deepStrictEqual(calls.find((c) => c.name === 'dropColumns').a, ['invite_codes', ['created_by', 'revoked_at']]);
});
