'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GroundItemSim } = require('../src/authority/groundItems.js');
const { loadLootFilter, saveLootFilter } = require('../src/authority/lootFilterStore.js');
const lf = require('../src/authority/lootFilter.js');

test('a ground item carries its level and affix ids into the snapshot, only when they matter', () => {
  const sim = new GroundItemSim(10);
  sim.add([
    { id: 1, item_type_id: 4, x: 1, y: 1, rarity: 'yellow', item_level: 77,
      affixes: [{ affixTypeId: 5, value: 3 }, { affixTypeId: 9, value: 1 }, { affixTypeId: 5, value: 2 }] },
    { id: 2, item_type_id: 4, x: 2, y: 2, rarity: 'white' },
  ]);
  const snap = sim.snapshotForNeighborhood(new Set(['0,0']));
  const byId = Object.fromEntries(snap.map((r) => [r.id, r]));
  assert.equal(byId[1].lv, 77);
  assert.deepEqual(byId[1].ax, [5, 9], 'ids only, de-duplicated');
  assert.equal('lv' in byId[2], false, 'a plain drop adds no bytes');
  assert.equal('ax' in byId[2], false);
});

test('a ground item added with camelCase fields (the in-memory form) is read too', () => {
  const sim = new GroundItemSim(10);
  sim.add([{ id: 1, typeId: 4, x: 1, y: 1, rarity: 'blue', itemLevel: 20, affixIds: [3] }]);
  const it = sim.get(1);
  assert.equal(it.itemLevel, 20);
  assert.deepEqual(it.affixIds, [3]);
});

function poolWith(rows) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: rows.length, rows }; } };
}

test('loadLootFilter: no row reads as the default', async () => {
  const cfg = await loadLootFilter(poolWith([]), 7);
  assert.deepEqual(cfg, lf.defaultConfig());
});

test('loadLootFilter: a stored row that no longer validates degrades to the default', async () => {
  const cfg = await loadLootFilter(poolWith([{ config: { presets: 'nonsense' } }]), 7);
  assert.deepEqual(cfg, lf.defaultConfig());
});

test('saveLootFilter validates first, stores the normalised config, and returns it', async () => {
  const pool = poolWith([]);
  const out = await saveLootFilter(pool, 7, {
    presets: [{ id: 'a', name: ' X ', rules: [{ action: 'hide', conditions: { rarities: ['white'] } }] }],
  });
  assert.equal(out.presets[0].name, 'X');
  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].params[0], 7);
  assert.deepEqual(JSON.parse(pool.calls[0].params[1]), out);
});

test('saveLootFilter refuses a bad config without touching the database', async () => {
  const pool = poolWith([]);
  await assert.rejects(() => saveLootFilter(pool, 7, { presets: [] }), lf.FilterError);
  assert.equal(pool.calls.length, 0);
});
