// The guard the tunnel DB tests use before they TRUNCATE: pure, no connection is made.
const test = require('node:test');
const assert = require('node:assert/strict');
const { privateTestDb } = require('./helpers/privateTestDb.js');

test('no TEST_DATABASE_URL: skip, never a DATABASE_URL fallback', () => {
  assert.ok(privateTestDb({ DATABASE_URL: 'postgres://u:p@localhost:15432/game_db' }).skip);
  assert.ok(privateTestDb({}).skip);
});

test('the shared dev database is refused even when named as TEST_DATABASE_URL', () => {
  const dev = 'postgres://u:p@localhost:15432/game_db';
  const r = privateTestDb({ TEST_DATABASE_URL: dev, DATABASE_URL: dev });
  assert.match(r.skip, /game_db/);
  assert.match(r.skip, /DATABASE_URL points at/);
  assert.ok(privateTestDb({ TEST_DATABASE_URL: dev }).skip);
});

test('the testdb.js throwaway databases are accepted', () => {
  for (const name of ['game_test', 'game_test_sync']) {
    const url = `postgres://u:p@localhost:25441/${name}`;
    assert.deepEqual(privateTestDb({ TEST_DATABASE_URL: url, DATABASE_URL: url }), { url });
  }
});

test('a malformed URL is a skip, not a throw', () => {
  assert.ok(privateTestDb({ TEST_DATABASE_URL: 'not a url' }).skip);
});
