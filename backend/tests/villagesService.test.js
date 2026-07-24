const test = require('node:test');
const assert = require('node:assert');
const { fetchVillages } = require('../src/services/villages');

test('fetchVillages maps snake_case columns to camelCase', async () => {
  const pool = {
    query: async (sql, params) => {
      assert.match(sql, /FROM villages WHERE world_id = \$1/i);
      assert.deepEqual(params, ['w1']);
      return { rows: [{
        id: 'v1', min_row: 5, min_col: 6, width: 8, height: 6,
        gate_edge: 'S', spawn_x: 650, spawn_y: 550,
        merchant_x: 950, merchant_y: 850,
      }] };
    },
  };
  const out = await fetchVillages(pool, 'w1');
  assert.deepEqual(out, [{
    id: 'v1', minRow: 5, minCol: 6, width: 8, height: 6,
    gateEdge: 'S', spawnX: 650, spawnY: 550,
    merchantX: 950, merchantY: 850,
  }]);
});

test('fetchVillages maps null merchant columns to null', async () => {
  const pool = {
    query: async () => ({ rows: [{
      id: 'v2', min_row: 1, min_col: 1, width: 3, height: 3,
      gate_edge: 'N', spawn_x: 150, spawn_y: 150,
      merchant_x: null, merchant_y: null,
    }] }),
  };
  const out = await fetchVillages(pool, 'w1');
  assert.equal(out[0].merchantX, null);
  assert.equal(out[0].merchantY, null);
});
