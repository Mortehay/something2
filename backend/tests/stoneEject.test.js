const test = require('node:test');
const assert = require('node:assert');
const { ejectSocketedStone } = require('../src/services/stoneEject.js');

test('ejectSocketedStone clears socketed_into_id for a stone pointing at the given host', async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; } };
  await ejectSocketedStone(client, 'host-1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE stone_instances SET socketed_into_id = NULL/i);
  assert.deepEqual(calls[0].params, ['host-1']);
});

test('ejectSocketedStone is a no-op (still one clean UPDATE, no error) when nothing is socketed into the host', async () => {
  const client = { query: async () => ({ rowCount: 0 }) };
  await assert.doesNotReject(() => ejectSocketedStone(client, 'host-with-nothing-socketed'));
});
