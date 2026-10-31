const { test } = require('node:test');
const assert = require('node:assert');
const { vendorBuyPrice, loadLegacyChoice } = require('../src/services/legacyEffects.js');

test('city_restoration takes 15% off, rounded down, never below 1', () => {
  assert.strictEqual(vendorBuyPrice(100, 'city_restoration'), 85);
  assert.strictEqual(vendorBuyPrice(1, 'city_restoration'), 1);
  assert.strictEqual(vendorBuyPrice(7, 'city_restoration'), 5);
});

test('other or missing legacy choices, and free items, are not changed', () => {
  assert.strictEqual(vendorBuyPrice(100, null), 100);
  assert.strictEqual(vendorBuyPrice(100, 'elemental_surge'), 100);
  assert.strictEqual(vendorBuyPrice(0, 'city_restoration'), 0);
});

test('loadLegacyChoice reads the stored choice and tolerates no character / no row', async () => {
  assert.strictEqual(await loadLegacyChoice({ query: async () => { throw new Error('no'); } }, null), null);
  assert.strictEqual(await loadLegacyChoice({ query: async () => ({ rows: [] }) }, 5), null);
  assert.strictEqual(
    await loadLegacyChoice({ query: async () => ({ rows: [{ legacy_choice: 'city_restoration' }] }) }, 5),
    'city_restoration',
  );
});
