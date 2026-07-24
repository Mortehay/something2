const test = require('node:test');
const assert = require('node:assert');
const { nearestMerchantVillage, INTERACT_RADIUS } = require('../src/authority/server');

const V = (id, x, y) => ({ id, merchantX: x, merchantY: y });

test('nearestMerchantVillage picks the closest merchant inside the radius', () => {
  const villages = [V('far', 1000, 0), V('near', 100, 0)];
  assert.equal(nearestMerchantVillage(villages, 0, 0, 400).id, 'near');
});

test('returns null when every merchant is beyond the radius', () => {
  assert.equal(nearestMerchantVillage([V('a', 1000, 0)], 0, 0, INTERACT_RADIUS), null);
});

test('skips villages with no merchant position', () => {
  const villages = [{ id: 'nomerchant', merchantX: null, merchantY: null }, V('ok', 50, 0)];
  assert.equal(nearestMerchantVillage(villages, 0, 0, 400).id, 'ok');
});

test('returns null for an empty or missing village list', () => {
  assert.equal(nearestMerchantVillage([], 0, 0, 400), null);
  assert.equal(nearestMerchantVillage(null, 0, 0, 400), null);
});
