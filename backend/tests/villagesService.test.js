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
      }] };
    },
  };
  const out = await fetchVillages(pool, 'w1');
  assert.deepEqual(out, [{
    id: 'v1', minRow: 5, minCol: 6, width: 8, height: 6,
    gateEdge: 'S', spawnX: 650, spawnY: 550,
  }]);
});
