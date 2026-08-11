// backend/tests/p5_restore_entry.test.js
const test = require('node:test');
const assert = require('node:assert');
const { restoreEntry } = require('../scripts/dungeon/restore-entry');

// This file used to assert the opposite of what it now asserts, and the old
// assertions were pinning a bug (SOMET-265). restoreEntry cleared is_entry
// everywhere and THEN set it by name, so a typo in the world name left the game
// with no entry world at all -- from the script whose whole purpose is to put
// one back. Its own error message said as much: "is_entry was cleared but not
// restored". It now goes through services/entryWorld.js, which resolves the
// name first and updates atomically.

test('restoreEntry points is_entry at the named world in one statement', async () => {
  const calls = [];
  const fakePool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT id FROM worlds WHERE name/i.test(sql)) return { rows: [{ id: 'w7' }] };
      return { rowCount: 1 };
    },
  };
  await restoreEntry(fakePool, 'Old Trailhead');

  const updates = calls.filter((c) => /UPDATE/i.test(c.sql));
  assert.equal(updates.length, 1, 'two UPDATEs reintroduce the zero-entry window');
  assert.match(updates[0].sql, /SET is_entry = \(id = \$1\)/);
  assert.deepEqual(updates[0].params, ['w7']);
  assert.deepEqual(calls[0].params, ['Old Trailhead'], 'the name is resolved before anything is written');
});

test('an unknown world name throws WITHOUT clearing the current entry', async () => {
  // The regression that matters. Previously this path cleared first and threw
  // second, so the failure mode of a mistyped name was silent data loss.
  const calls = [];
  const fakePool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT id FROM worlds WHERE name/i.test(sql)) return { rows: [] };
      return { rowCount: 0 };
    },
  };
  await assert.rejects(() => restoreEntry(fakePool, 'Nonexistent World'), /not found/);
  assert.ok(!calls.some((c) => /UPDATE/i.test(c.sql)),
    'nothing may be written when the target world does not exist');
});
