'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NEW_AFFIXES, LEGACY } = require('../seeds/data/affixTypes.js');
const { rollChestLoot } = require('../src/authority/chestLoot.js');

// ---- an affix says what it does ------------------------------------------------------------------
// "of the Hawk" read "+N% Attack Speed" while applying castSpeedMult (the spell rule).
test('an affix whose text promises Attack Speed applies attackSpeedMult, Cast Speed castSpeedMult', () => {
  for (const a of [...NEW_AFFIXES, ...Object.values(LEGACY)]) {
    const eff = a.effect || {};
    const text = String(eff.text || '');
    if (/Attack Speed/.test(text)) assert.equal(eff.rule, 'attackSpeedMult', `${a.key}: text says Attack Speed`);
    if (/Cast Speed/.test(text)) assert.equal(eff.rule, 'castSpeedMult', `${a.key}: text says Cast Speed`);
  }
  const hawk = NEW_AFFIXES.find((a) => a.key === 'of_the_hawk');
  assert.ok(hawk, 'of_the_hawk exists');
  assert.equal(hawk.effect.rule, 'attackSpeedMult');
});

// ---- chests pay gear for their guard's level -----------------------------------------------------
function poolWith(gearRows) {
  const sql = [];
  return {
    sql,
    query: async (text) => {
      sql.push(text);
      if (/chest_loot/.test(text)) return { rows: [{ item_type_id: 3, chance: 1, min_qty: 1, max_qty: 1 }] };
      return { rows: gearRows };
    },
  };
}

test('with no gearRng a chest rolls exactly its table (fixtures stay exact)', async () => {
  const pool = poolWith([{ id: 900 }]);
  const out = await rollChestLoot(pool, 120, () => 0);
  assert.deepEqual(out, [3]);
  assert.equal(pool.sql.length, 1, 'no gear query without a gearRng');
});

test('with a gearRng a deep chest adds one piece of wild gear from the guard\'s level pool', async () => {
  const pool = poolWith([{ id: 901 }, { id: 902 }]);
  const out = await rollChestLoot(pool, 120, () => 0, () => 0); // 0 < CHEST_GEAR_CHANCE, picks the first
  assert.deepEqual(out, [3, 901]);
  assert.match(pool.sql[1], /WITH eligible AS/);
});

test('a roll above the chance adds nothing, and a failed gear query costs only the bonus item', async () => {
  const none = await rollChestLoot(poolWith([{ id: 901 }]), 120, () => 0, () => 0.99);
  assert.deepEqual(none, [3]);
  const broken = {
    query: async (text) => {
      if (/chest_loot/.test(text)) return { rows: [{ item_type_id: 3, chance: 1, min_qty: 1, max_qty: 1 }] };
      throw new Error('db down');
    },
  };
  assert.deepEqual(await rollChestLoot(broken, 120, () => 0, () => 0), [3]);
});
