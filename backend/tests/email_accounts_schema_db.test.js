// Email accounts schema, against a real database. The two partial unique
// indexes ARE the feature's integrity guarantees (one verified owner per
// email; one pending invite request per email), so they are tested by
// provoking the violation, not by inspecting catalog rows.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to mutate a real database (this test writes users)'
  : false;

const uniq = (p) => `${p}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

test('schema has email account tables', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const emails = [];
  const usernames = [];
  t.after(async () => {
    if (emails.length) {
      await pool.query('DELETE FROM invite_requests WHERE email = ANY($1::citext[])', [emails]);
    }
    if (usernames.length) {
      await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames]);
    }
    await pool.end();
  });

  const addUser = (email, verified) => {
    const username = uniq('eacct');
    usernames.push(username);
    return pool.query(
      `INSERT INTO users (username, password_hash, email, email_verified_at)
       VALUES ($1, 'x', $2, ${verified ? 'now()' : 'NULL'})`,
      [username, email],
    );
  };
  const addRequest = (email, status) => {
    emails.push(email);
    return pool.query(
      'INSERT INTO invite_requests (email, status) VALUES ($1, $2)',
      [email, status],
    );
  };

  await t.test('a verified email can belong to only one user', async () => {
    const e = `${uniq('v')}@x.com`;
    await addUser(e, true);
    await assert.rejects(addUser(e.toUpperCase(), true), { code: '23505' });
  });

  await t.test('the same email may be unverified on many users', async () => {
    const e = `${uniq('u')}@x.com`;
    await addUser(e, false);
    await addUser(e, false);
  });

  await t.test('one pending invite request per email, case-insensitive', async () => {
    const e = `${uniq('P')}@x.com`;
    await addRequest(e.toUpperCase(), 'pending');
    await assert.rejects(addRequest(e.toLowerCase(), 'pending'), { code: '23505' });
  });

  await t.test('a pending request may coexist with a rejected one', async () => {
    const e = `${uniq('r')}@x.com`;
    await addRequest(e, 'rejected');
    await addRequest(e, 'pending');
  });

  await t.test('email_tokens and invite_codes.email exist', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE (table_name='email_tokens' AND column_name IN ('token_hash','user_id','purpose','email','expires_at','used_at'))
          OR (table_name='invite_codes' AND column_name='email')`);
    assert.equal(rows.length, 7);
  });
});
