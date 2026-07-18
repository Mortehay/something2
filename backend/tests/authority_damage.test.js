const test = require('node:test');
const assert = require('node:assert');
const { applyDamage, MIN_DAMAGE, RESIST_CAP, ELEMENTS, NO_MITIGATION } = require('../src/authority/damage.js');

const t = (hp = 100) => ({ hp });

test('with no mitigation, damage passes through unchanged', () => {
  const x = t();
  assert.equal(applyDamage(x, 10, 'physical', NO_MITIGATION), 10);
  assert.equal(x.hp, 90);
});

test('flat defense subtracts before resistance', () => {
  const x = t();
  const dealt = applyDamage(x, 10, 'physical', { defense: 4, resistances: {} });
  assert.equal(dealt, 6);
  assert.equal(x.hp, 94);
});

test('resistance scales the post-defense damage for the matching element', () => {
  const x = t();
  const dealt = applyDamage(x, 20, 'arcane', { defense: 0, resistances: { arcane: 0.5 } });
  assert.equal(dealt, 10);
});

test('resistance for a different element does not apply', () => {
  const x = t();
  assert.equal(applyDamage(x, 20, 'fire', { defense: 0, resistances: { arcane: 0.5 } }), 20);
});

test('total resistance is capped at RESIST_CAP (never immune)', () => {
  const x = t();
  const dealt = applyDamage(x, 100, 'ice', { defense: 0, resistances: { ice: 5 } }); // absurd resist
  assert.equal(dealt, 100 * (1 - RESIST_CAP));
  assert.ok(dealt > 0);
});

test('damage is floored at MIN_DAMAGE even against huge defense', () => {
  const x = t();
  assert.equal(applyDamage(x, 5, 'physical', { defense: 999, resistances: {} }), MIN_DAMAGE);
  assert.equal(x.hp, 100 - MIN_DAMAGE);
});

test('a missing/unknown element is treated as physical with no resistance', () => {
  const x = t();
  assert.equal(applyDamage(x, 10, null, { defense: 0, resistances: { physical: 0.5 } }), 5);
  const y = t();
  assert.equal(applyDamage(y, 10, 'nonsense', { defense: 0, resistances: { arcane: 0.5 } }), 10);
});

test('ELEMENTS lists the supported set with physical first', () => {
  assert.deepEqual(ELEMENTS, ['physical', 'arcane', 'fire', 'ice', 'lightning']);
});
