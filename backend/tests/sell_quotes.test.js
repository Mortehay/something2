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

test('sellQuotes omits soulbound, stacked and stone items and quotes a plain one and a worn one', async () => {
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
  assert.deepStrictEqual(Object.keys(q).sort(), ['plain', 'worn']);
  assert.strictEqual(q.plain, quoteSellPrice(100, 5, 1, 40));
  // Unequipping sends no shop frame, so the price has to be known before it happens.
  assert.strictEqual(q.worn, quoteSellPrice(100, 0, 1, 40));
});

test('sellQuotes leaves out a worn item that could not be sold once unequipped', async () => {
  const db = {
    query: async (sql) => (/stone_instances/.test(sql) ? { rows: [] } : { rows: [{ id: 1, value: 100 }] }),
  };
  const inv = {
    equipment: { chest: 'bound' },
    items: [{ id: 'bound', typeId: 1, quantity: 1, soulbound: true }],
  };
  assert.deepStrictEqual(await sellQuotes(db, inv, 1, 40), {});
});

// SOMET-755. Every bonus together, not each alone: the old caps each looked safe on their own.
test('no combination of charisma, standing and legacy sells for what the same character buys at', () => {
  const { vendorBuyPrice } = require('../src/services/legacyEffects.js');
  const { TIERS } = require('../src/services/reputation.js');
  const legacies = [null, 'city_restoration', 'elemental_surge'];
  const values = [1, 2, 3, 7, 16, 20, 40, 99, 100, 333, 1000, 6000, 99999];
  for (let priceMult = 0.5; priceMult <= SELL_FRACTION_MAX + 1e-9; priceMult += 0.02) {
    for (const { at: standing } of TIERS) {
      for (const legacy of legacies) {
        for (const value of values) {
          const buy = vendorBuyPrice(value, legacy);
          const sell = quoteSellPrice(value, 0, priceMult, standing, legacy);
          const at = `${legacy} mult ${priceMult} standing ${standing} value ${value}: sell ${sell}, buy ${buy}`;
          assert.ok(sell <= buy, at);
          // Both round down, so a 2 g item can break even at 1 g each. It still prints nothing.
          if (value >= 100) assert.ok(sell < buy, at);
        }
      }
    }
  }
});

test('only City Restoration lowers the cap, and only the cap', () => {
  // Below the cap, the legacy changes nothing about what charisma and standing earn.
  assert.strictEqual(quoteSellPrice(1000, 0, 0.5, 0, 'city_restoration'), quoteSellPrice(1000, 0, 0.5, 0, null));
  assert.strictEqual(quoteSellPrice(1000, 0, 0.5, 100, 'city_restoration'), 600);
  assert.strictEqual(quoteSellPrice(1000, 0, 0.9, 0, 'city_restoration'), 800);
  assert.strictEqual(quoteSellPrice(1000, 0, 0.9, 0, 'elemental_surge'), 900);
  assert.strictEqual(quoteSellPrice(1000, 0, 0.9, 0, null), 900);
  assert.strictEqual(quoteSellPrice(1000, 0, 0.9, 0), 900);
});

test('sellQuotes shows the capped price to a City Restoration character', async () => {
  const db = {
    query: async (sql) => (/stone_instances/.test(sql) ? { rows: [] } : { rows: [{ id: 1, value: 6000 }] }),
  };
  const inv = { equipment: {}, items: [{ id: 'x', typeId: 1, quantity: 1 }] };
  assert.strictEqual((await sellQuotes(db, inv, 0.9, 0, 'city_restoration')).x, 4800);
  assert.strictEqual((await sellQuotes(db, inv, 0.9, 0, null)).x, 5400);
});
