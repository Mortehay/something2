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

test('a NaN resistance is clamped to 0 instead of producing NaN damage/hp', () => {
  // Defence in depth: even though the API now validates resistance values,
  // a NaN reaching this path (e.g. a pre-existing row) must not silently
  // make the target immortal (NaN <= 0 is false, so resolveDeaths never
  // fires).
  const x = t();
  const dealt = applyDamage(x, 10, 'fire', { defense: 0, resistances: { fire: NaN } });
  assert.ok(Number.isFinite(dealt), 'dealt damage must be finite');
  assert.ok(dealt >= MIN_DAMAGE);
  assert.ok(Number.isFinite(x.hp), 'target hp must stay finite');
  assert.equal(x.hp, 90);
});

test('a negative resistance is clamped to 0, not amplifying damage', () => {
  const x = t();
  const dealt = applyDamage(x, 10, 'fire', { defense: 0, resistances: { fire: -0.5 } });
  assert.equal(dealt, 10, 'negative resistance must not deal MORE than raw damage');
  assert.ok(Number.isFinite(dealt));
});
