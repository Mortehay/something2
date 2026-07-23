// backend/tests/goldDrop.test.js
const test = require('node:test');
const assert = require('node:assert');
const { rollGold, spawnDrops } = require('../src/authority/loot');

test('rollGold returns 0 when max is 0 or range missing', () => {
  assert.equal(rollGold({ min: 0, max: 0 }, () => 0.9), 0);
  assert.equal(rollGold(undefined, () => 0.9), 0);
});

test('rollGold returns an integer in [min,max], monotonic in rng', () => {
  assert.equal(rollGold({ min: 2, max: 6 }, () => 0), 2);
  assert.equal(rollGold({ min: 2, max: 6 }, () => 0.999), 6);
  const v = rollGold({ min: 2, max: 6 }, () => 0.5);
  assert.ok(Number.isInteger(v) && v >= 2 && v <= 6);
});

test('spawnDrops inserts one gold world_item when the creature has a gold range', async () => {
  const inserts = [];
  const pool = { query: async (sql, params) => {
    if (/SELECT item_type_id, chance/.test(sql)) return { rows: [] }; // no item drops
    if (/INSERT INTO world_items/.test(sql)) { inserts.push(params); return { rows: [{ id: 'g1', item_type_id: params[1], x: params[2], y: params[3], quantity: params[5] }] }; }
    throw new Error('unexpected ' + sql);
  } };
  const entry = {
    worldId: 'w1',
    goldItemTypeId: 42,
    creatureTypeIds: new Map([['Slime', 1]]),
    creatureGold: new Map([['Slime', { min: 5, max: 5 }]]),
    world: { groundItems: { add: () => {} } },
  };
  await spawnDrops(pool, entry, { type: 'Slime', x: 100, y: 100 }, { rng: () => 0.5 });
  const goldIns = inserts.filter((p) => p[1] === 42);
  assert.equal(goldIns.length, 1, 'exactly one gold world_item');
  assert.equal(goldIns[0][5], 5, 'quantity equals the rolled gold amount');
});

test('spawnDrops inserts NO gold when gold_max is 0', async () => {
  const inserts = [];
  const pool = { query: async (sql, params) => {
    if (/SELECT item_type_id, chance/.test(sql)) return { rows: [] };
    if (/INSERT INTO world_items/.test(sql)) { inserts.push(params); return { rows: [{ id: 'x' }] }; }
    throw new Error('unexpected ' + sql);
  } };
  const entry = {
    worldId: 'w1', goldItemTypeId: 42,
    creatureTypeIds: new Map([['Bat', 2]]),
    creatureGold: new Map([['Bat', { min: 0, max: 0 }]]),
    world: { groundItems: { add: () => {} } },
  };
  await spawnDrops(pool, entry, { type: 'Bat', x: 0, y: 0 }, { rng: () => 0.9 });
  assert.equal(inserts.length, 0);
});
