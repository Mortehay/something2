// backend/tests/p5_restore_entry.test.js
const test = require('node:test');
const assert = require('node:assert');
const { restoreEntry } = require('../scripts/dungeon/restore-entry');

test('restoreEntry clears is_entry everywhere then sets it on the named world', async () => {
  const calls = [];
  const fakePool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1 };
    },
  };
  await restoreEntry(fakePool, 'Old Trailhead');
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /UPDATE worlds SET is_entry = false WHERE is_entry = true/);
  assert.match(calls[1].sql, /UPDATE worlds SET is_entry = true WHERE name = \$1/);
  assert.deepEqual(calls[1].params, ['Old Trailhead']);
});

test('restoreEntry throws if the named world does not exist (rowCount 0)', async () => {
  const fakePool = { query: async (sql) => (/is_entry = true WHERE name/.test(sql) ? { rowCount: 0 } : { rowCount: 1 }) };
  await assert.rejects(() => restoreEntry(fakePool, 'Nonexistent World'), /not found/);
});
