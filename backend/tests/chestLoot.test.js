const test = require('node:test');
const assert = require('node:assert');
const { rollChestLoot, xpForChest } = require('../src/authority/chestLoot.js');

function scriptedPool(rows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; },
  };
}

test('rollChestLoot queries chest_loot bounded by the guard level and rolls it through rollDrops', async () => {
  const row = { item_type_id: 9, chance: '1', min_qty: 1, max_qty: 1 };
  const pool = scriptedPool([row]);
  const always = () => 0;
  const out = await rollChestLoot(pool, 5, always);
  assert.deepEqual(out, [9]);
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /FROM chest_loot/i);
  assert.match(pool.calls[0].sql, /level_min <= \$1/i);
  assert.match(pool.calls[0].sql, /level_max >= \$1/i);
  assert.deepEqual(pool.calls[0].params, [5]);
});

test('rollChestLoot rolls nothing when the level band has no matching rows', async () => {
  const pool = scriptedPool([]);
  const out = await rollChestLoot(pool, 1, () => 0);
  assert.deepEqual(out, []);
});

test('xpForChest reuses xpForKill unchanged, applied to the guard level', () => {
  const { xpForKill } = require('../src/services/playerStats.js');
  assert.equal(xpForChest(10, 3), xpForKill(10, 3));
  assert.equal(xpForChest(1, 1), xpForKill(1, 1));
});
