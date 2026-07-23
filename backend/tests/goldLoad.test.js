// backend/tests/goldLoad.test.js
const test = require('node:test');
const assert = require('node:assert');
const { loadCreatureTypes } = require('../src/authority/creatures');
const { resolveGoldItemTypeId } = require('../src/authority/items');

test('resolveGoldItemTypeId finds the gold item type by name', () => {
  const itemTypes = new Map([
    [1, { id: 1, name: 'dagger' }],
    [7, { id: 7, name: 'gold' }],
  ]);
  assert.equal(resolveGoldItemTypeId(itemTypes), 7);
  assert.equal(resolveGoldItemTypeId(new Map([[1, { id: 1, name: 'dagger' }]])), null);
});

test('loadCreatureTypes returns a name->gold-range map from gold_min/gold_max', async () => {
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rows: [
    { id: 1, name: 'Slime', color: '#0f0', hp: 10, defense: 0, resistances: {}, faction: 'hostile', gold_min: 1, gold_max: 3 },
    { id: 2, name: 'Village Guard', color: '#3f6fb5', hp: 300, defense: 10, resistances: {}, faction: 'guard', gold_min: 0, gold_max: 0 },
  ] }; } };
  const { creatureGold } = await loadCreatureTypes(pool);
  assert.match(sql, /gold_min/, 'SELECT must include gold_min/gold_max — omitting them loads undefined and drops no gold');
  assert.deepEqual(creatureGold.get('Slime'), { min: 1, max: 3 });
  assert.deepEqual(creatureGold.get('Village Guard'), { min: 0, max: 0 });
});
