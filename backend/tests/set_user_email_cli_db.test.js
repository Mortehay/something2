// Operator CLI set-user-email.js: real script as a child process against the
// scratch database, handed TEST_DATABASE_URL explicitly so dotenv can never
// point it at the shared dev DB.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'no TEST_DATABASE_URL -- refusing to touch a real database';
const SCRIPT = path.resolve(__dirname, '../scripts/set-user-email.js');
const TAG = `sue${process.pid}${Date.now().toString(36)}`;

const run = (...args) => spawnSync('node', [SCRIPT, ...args], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });

test('set-user-email', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const names = { a: `${TAG}_a`, b: `${TAG}_b` };
  const mk = (n) => pool.query("INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [n]);
  const get = async (n) => (await pool.query('SELECT email, email_verified_at FROM users WHERE username = $1', [n])).rows[0];
  t.after(async () => { await pool.query('DELETE FROM users WHERE username LIKE $1', [`${TAG}%`]); await pool.end(); });
  await mk(names.a); await mk(names.b);

  await t.test('sets a normalized, verified email', async () => {
    const r = run(names.a, `  ${TAG}.Mixed@Example.COM `);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), `ok: ${names.a} ${TAG}.mixed@example.com (verified)`);
    const row = await get(names.a);
    assert.strictEqual(row.email, `${TAG}.mixed@example.com`);
    assert.ok(row.email_verified_at);
  });

  await t.test('refuses an email another account holds verified, no change', async () => {
    const r = run(names.b, `${TAG}.MIXED@example.com`);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /already verified on another account/);
    assert.deepStrictEqual(await get(names.b), { email: null, email_verified_at: null });
  });

  await t.test('invalid email and unknown user exit 1, no change', async () => {
    const bad = run(names.b, 'not-an-email');
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stderr, /invalid email address/);
    const r = run(`${TAG}_nobody`, `${TAG}.x@example.com`);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no such user/);
    assert.deepStrictEqual(await get(names.b), { email: null, email_verified_at: null });
  });

  await t.test('missing args exit 1', () => {
    assert.strictEqual(run(names.b).status, 1);
  });
});
