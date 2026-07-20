const test = require('node:test');
const assert = require('node:assert');
const {
  applyDamage, applyDamageWithEffects, drainMana,
  MIN_DAMAGE, RESIST_CAP, ELEMENTS, NO_MITIGATION,
} = require('../src/authority/damage.js');
const { applyEffect, SHOCK, SHOCK_MAGNITUDE } = require('../src/authority/effects.js');

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

// --- Task 6: shock's damage vulnerability, layered in FRONT of applyDamage ---

test('shock increases damage taken by 25%', () => {
  const shocked = t(), plain = t();
  applyEffect(shocked, SHOCK, { durationMs: 5000, magnitude: SHOCK_MAGNITUDE, now: 0 });
  const d1 = applyDamageWithEffects(shocked, 20, 'physical', NO_MITIGATION, 0);
  const d2 = applyDamageWithEffects(plain, 20, 'physical', NO_MITIGATION, 0);
  assert.ok(d1 > d2 * 1.2, `shocked took ${d1}, unshocked ${d2} — the vulnerability is inert`);
  assert.equal(d1, 25);
  assert.equal(d2, 20);
});

// THE ordering test. Multiplicative resistance ALONE cannot distinguish
// before-mitigation from after-mitigation (raw*1.25*(1-r) === raw*(1-r)*1.25),
// so this deliberately pairs resistance with FLAT DEFENSE, where the two
// orderings genuinely diverge:
//
//   before (correct): (20*1.25 - 8) * (1 - 0.5) = 8.5
//   after  (wrong):   ((20 - 8) * (1 - 0.5)) * 1.25 = 7.5
//
// The wrong ordering lets a shocked target's mitigation be partly bypassed:
// the amplified portion of the hit never passes through defense at all. A test
// written with resistance only would be vacuous here — it would stay green
// under exactly the mutation it exists to catch.
test('shock vulnerability multiplies RAW damage BEFORE mitigation, so defense and resistance apply on top', () => {
  const x = t();
  applyEffect(x, SHOCK, { durationMs: 5000, magnitude: 0.25, now: 0 });
  const dealt = applyDamageWithEffects(x, 20, 'fire', { defense: 8, resistances: { fire: 0.5 } }, 0);
  assert.equal(dealt, 8.5,
    'vulnerability must scale the RAW damage before defense/resistance are subtracted; '
    + `got ${dealt} (7.5 means it was applied AFTER mitigation, bypassing part of it)`);
});

test('an expired or absent shock adds nothing, and applyDamage stays the single reduction path', () => {
  const x = t();
  applyEffect(x, SHOCK, { durationMs: 1000, magnitude: 0.25, now: 0 });
  // now = 2000: the shock is long gone, so this must match plain applyDamage.
  assert.equal(applyDamageWithEffects(x, 20, 'physical', NO_MITIGATION, 2000), 20);
  const y = t();
  assert.equal(applyDamageWithEffects(y, 20, 'physical', NO_MITIGATION, 0), 20);
});

test('vulnerability cannot push damage past applyDamage floor or resistance cap', () => {
  const x = t();
  applyEffect(x, SHOCK, { durationMs: 5000, magnitude: 0.25, now: 0 });
  // Defense far exceeds even the amplified raw: the floor still holds.
  assert.equal(applyDamageWithEffects(x, 5, 'physical', { defense: 999, resistances: {} }, 0), MIN_DAMAGE);
  // Resistance is still capped at RESIST_CAP even on an amplified hit.
  const y = t();
  applyEffect(y, SHOCK, { durationMs: 5000, magnitude: 0.25, now: 0 });
  assert.equal(applyDamageWithEffects(y, 100, 'ice', { defense: 0, resistances: { ice: 5 } }, 0),
    125 * (1 - RESIST_CAP));
});

// --- Task 6: mana drain ---

test('mana drain clamps at zero and no-ops on a target with no mana pool', () => {
  const creature = { hp: 10 };                    // creatures have no mana
  assert.doesNotThrow(() => drainMana(creature, 10));
  assert.equal('mana' in creature, false,
    'drainMana invented a mana pool on a creature — a clamped `mana: 0` would leak into '
    + 'the creature snapshot and make every creature read as an out-of-mana caster');

  const p = { hp: 100, mana: 3 };
  drainMana(p, 10);
  assert.equal(p.mana, 0, 'mana must clamp at 0, never go negative');
});

test('mana drain returns the amount ACTUALLY drained, not the amount requested', () => {
  const p = { hp: 100, mana: 3 };
  assert.equal(drainMana(p, 10), 3, 'a clamped drain must report 3, not 10');
  assert.equal(drainMana(p, 10), 0, 'an empty pool drains nothing');
  const full = { hp: 100, mana: 50 };
  assert.equal(drainMana(full, 10), 10);
  assert.equal(full.mana, 40);
});
