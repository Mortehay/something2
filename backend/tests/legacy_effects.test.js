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

test('elemental_surge: +15% magic find on the rarity roll, +20% gold, nothing for other choices', () => {
  const { legacyMagicFind, legacyGoldAmount } = require('../src/services/legacyEffects.js');
  const { withMagicFind, interpolateWeights, rollRarity } = require('../src/authority/rarity.js');
  assert.strictEqual(legacyMagicFind('elemental_surge'), 0.15);
  assert.strictEqual(legacyMagicFind('city_restoration'), 0);
  assert.strictEqual(legacyMagicFind(null), 0);
  assert.strictEqual(legacyGoldAmount(100, 'elemental_surge'), 120);
  assert.strictEqual(legacyGoldAmount(100, null), 100);

  const anchors = [{ item_level: 1, white: 70, blue: 25, yellow: 5, foxy: 0 }];
  const base = interpolateWeights(10, anchors);
  assert.strictEqual(withMagicFind(base, 0), base, 'zero magic find returns the table untouched');
  const boosted = withMagicFind(base, 0.15);
  const sum = Object.values(boosted).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'still a distribution');
  assert.ok(boosted.white < base.white && boosted.blue > base.blue && boosted.yellow > base.yellow);
  assert.strictEqual(boosted.foxy, 0, 'a grade with no weight stays unreachable');
  // Default rollRarity (no magic find) is unchanged.
  assert.strictEqual(rollRarity(10, anchors, () => 0.5), rollRarity(10, anchors, () => 0.5, 0));
});
