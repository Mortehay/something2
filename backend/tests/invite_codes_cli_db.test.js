// SOMET-734. `invite-codes.js --json`, the shape the pi helper reads. Real
// script as a child process against the scratch database; every code made
// here is deleted afterwards.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const { ALPHABET } = require('../scripts/invite-codes.js');

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'no TEST_DATABASE_URL -- refusing to touch a real database';
const SCRIPT = path.resolve(__dirname, '../scripts/invite-codes.js');
const NOTE = `cli-test-${process.pid}-${Date.now()}`;

const run = (...args) => execFileSync('node', [SCRIPT, ...args], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });

test('invite-codes --json', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(async () => { await pool.query('DELETE FROM invite_codes WHERE note LIKE $1', [`${NOTE}%`]); await pool.end(); });

  const minted = JSON.parse(run('mint', '2', '--json', '--note', `${NOTE} a "quoted" $(x);`));
  assert.deepStrictEqual(Object.keys(minted).sort(), ['codes', 'requested']);
  assert.strictEqual(minted.requested, 2);
  assert.strictEqual(minted.codes.length, 2);
  const re = new RegExp(`^[${ALPHABET}]{4}-[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);
  for (const c of minted.codes) assert.match(c, re);

  await t.test('list --all --json shows status and note', () => {
    const out = run('list', '--all', '--json');
    assert.strictEqual(out.trim().split('\n').length, 1, 'one line of JSON');
    const mine = JSON.parse(out).invites.filter((i) => minted.codes.includes(i.code));
    assert.strictEqual(mine.length, 2);
    for (const i of mine) {
      assert.strictEqual(i.status, 'unused');
      assert.strictEqual(i.note, `${NOTE} a "quoted" $(x);`);
      assert.strictEqual(i.usedAt, null);
      assert.ok(Date.parse(i.createdAt));
    }
  });

  await t.test('revoke --json burns the code and list says revoked, not used', () => {
    assert.deepStrictEqual(JSON.parse(run('revoke', minted.codes[0], '--json')), { revoked: minted.codes[0] });
    const inv = JSON.parse(run('list', '--all', '--json')).invites;
    assert.strictEqual(inv.find((i) => i.code === minted.codes[0]).status, 'revoked');
    assert.strictEqual(inv.find((i) => i.code === minted.codes[1]).status, 'unused');
    assert.deepStrictEqual(JSON.parse(run('revoke', 'ZZZZ-ZZZZ-ZZZZ', '--json')), { revoked: null });
  });

  await t.test('a code a user spent reads as used', async () => {
    await pool.query("UPDATE invite_codes SET used_at = now() WHERE code = $1", [minted.codes[1]]);
    const row = JSON.parse(run('list', '--all', '--json')).invites.find((i) => i.code === minted.codes[1]);
    assert.strictEqual(row.status, 'used');
  });

  await t.test('revoking a used code changes nothing and says so', async () => {
    const before = (await pool.query('SELECT note, used_at FROM invite_codes WHERE code = $1', [minted.codes[1]])).rows[0];
    assert.deepStrictEqual(JSON.parse(run('revoke', minted.codes[1], '--json')), { revoked: null });
    assert.match(run('revoke', minted.codes[1]), /^nothing revoked/);
    const after = (await pool.query('SELECT note, used_at FROM invite_codes WHERE code = $1', [minted.codes[1]])).rows[0];
    assert.deepStrictEqual(after, before);
    assert.strictEqual(JSON.parse(run('list', '--all', '--json')).invites.find((i) => i.code === minted.codes[1]).status, 'used');
  });

  await t.test('without --json the output is the old human text', () => {
    assert.match(run('list', '--all'), new RegExp(`${minted.codes[1]}  used`));
  });
});
