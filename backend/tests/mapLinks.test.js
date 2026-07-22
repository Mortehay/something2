const test = require('node:test');
const assert = require('node:assert');
const { fetchLinks, setLink, clearLink } = require('../src/services/mapLinks');

function mockPool(handlers) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    throw new Error(`unexpected query: ${sql}`);
  } };
}

test('fetchLinks returns edges joined to target bounds', async () => {
  const pool = mockPool([[/SELECT .*FROM map_links.*JOIN worlds/is, () => ({
    rows: [{ edge: 'E', to_world_id: 'B', to_width: 16, to_height: 16 }] })]]);
  const rows = await fetchLinks(pool, 'A');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].edge, 'E');
  assert.equal(rows[0].to_world_id, 'B');
});

test('setLink writes BOTH directions (A,E,B) and (B,W,A)', async () => {
  const pool = mockPool([[/INSERT INTO map_links/i, () => ({ rows: [] })]]);
  await setLink(pool, 'A', 'E', 'B');
  const inserts = pool.calls.filter(c => /INSERT INTO map_links/i.test(c.sql));
  assert.equal(inserts.length, 2);
  // forward (A,E,B)
  assert.deepEqual(inserts[0].params, ['A', 'E', 'B']);
  // mirror (B,W,A)
  assert.deepEqual(inserts[1].params, ['B', 'W', 'A']);
});

test('clearLink removes both directions', async () => {
  const pool = mockPool([
    [/SELECT to_world_id FROM map_links/i, () => ({ rows: [{ to_world_id: 'B' }] })],
    [/DELETE FROM map_links/i, () => ({ rows: [] })],
  ]);
  await clearLink(pool, 'A', 'E');
  const dels = pool.calls.filter(c => /DELETE FROM map_links/i.test(c.sql));
  assert.equal(dels.length, 2);
  assert.deepEqual(dels[0].params, ['A', 'E']);       // forward
  assert.deepEqual(dels[1].params, ['B', 'W']);       // mirror
});

test('clearLink with no existing link deletes only the forward row', async () => {
  const pool = mockPool([
    [/SELECT to_world_id FROM map_links/i, () => ({ rows: [] })],
    [/DELETE FROM map_links/i, () => ({ rows: [] })],
  ]);
  await clearLink(pool, 'A', 'E');
  const dels = pool.calls.filter(c => /DELETE FROM map_links/i.test(c.sql));
  assert.equal(dels.length, 1);
  assert.deepEqual(dels[0].params, ['A', 'E']);
});
