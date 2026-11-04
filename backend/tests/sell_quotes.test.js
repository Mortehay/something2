// SOMET-713. quoteSellPrice is the one formula sellItem pays; sellQuotes is what the shop frame
// shows. Pure: sellQuotes only reads item_types, served here by a stub.
const test = require('node:test');
const assert = require('node:assert');
const { quoteSellPrice, sellQuotes } = require('../src/authority/trade.js');
const { sellPriceFor } = require('../src/services/merchantStock.js');
const { sellBonus } = require('../src/services/enchant.js');
const { boostedSellFraction } = require('../src/services/reputation.js');
const { SELL_FRACTION_MAX } = require('../src/services/progressionConstants.js');

test('quoteSellPrice is the sell formula, with and without enchant', () => {
  for (const level of [0, 5]) {
    const expected = sellPriceFor(100 + sellBonus(level), boostedSellFraction(1, 40, SELL_FRACTION_MAX));
    assert.strictEqual(quoteSellPrice(100, level, 1, 40), expected);
  }
  assert.ok(quoteSellPrice(100, 5, 1, 40) > quoteSellPrice(100, 0, 1, 40), 'enchant must raise the quote');
});

test('sellQuotes omits worn, soulbound, stacked and stone items and quotes a plain one', async () => {
  const types = [
    { id: 1, value: 100, category: 'armor' },
    { id: 2, value: 100, category: 'stone' },
  ];
  const db = {
    query: async (sql, [ids]) => (/stone_instances/.test(sql)
      ? { rows: ids.filter((id) => id === 'stone').map((id) => ({ player_item_id: id })) }
      : { rows: types.filter((x) => ids.includes(x.id)) }),
  };
  const inv = {
    equipment: { chest: 'worn' },
    items: [
      { id: 'plain', typeId: 1, quantity: 1, soulbound: false, enchantLevel: 5 },
      { id: 'worn', typeId: 1, quantity: 1 },
      { id: 'bound', typeId: 1, quantity: 1, soulbound: true },
      { id: 'stack', typeId: 1, quantity: 3 },
      { id: 'stone', typeId: 2, quantity: 1 },
    ],
  };
  const q = await sellQuotes(db, inv, 1, 40);
  assert.deepStrictEqual(Object.keys(q), ['plain']);
  assert.strictEqual(q.plain, quoteSellPrice(100, 5, 1, 40));
});
