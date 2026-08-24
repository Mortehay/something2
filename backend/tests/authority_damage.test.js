const test = require('node:test');
const assert = require('node:assert');
const {
  applyDamage, applyDamageWithEffects, drainMana,
  MIN_DAMAGE, RESIST_CAP, RESIST_FLOOR, ELEMENTS, NO_MITIGATION,
  isProvokedBy, playerKey, creatureKey, PROVOKE_MEMORY_MS,
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

// SOMET-495 REVERSED this test's contract, deliberately.
//
// It used to read "a negative resistance is clamped to 0, not amplifying
// damage", and that was right while a resistance could only come from armour,
// where a negative number could only be a bad row. The passive tree now
// AUTHORS negative resistances: several keystones pay for their upside with a
// drawback like `{element:'ice', value:-15}`, and a clamp at 0 gave the player
// the upside for free -- the same "displayed but inert" failure SOMET-495
// exists to end, one layer down from the grant kinds themselves.
//
// What is NOT negotiable is that the amplification stays BOUNDED, which is what
// the second half pins.
test('a negative resistance AMPLIFIES damage — drawback nodes are real', () => {
  const x = t();
  const dealt = applyDamage(x, 10, 'fire', { defense: 0, resistances: { fire: -0.5 } });
  assert.equal(dealt, 15, 'a -50% fire resistance must take 1.5x, not 1x — '
    + 'clamping it at 0 silently deletes every drawback keystone');
  assert.ok(Number.isFinite(dealt));
});

test('the amplification is floored at RESIST_FLOOR (never worse than double)', () => {
  const x = t();
  assert.equal(RESIST_FLOOR, -1, 'the floor is the mirror of RESIST_CAP');
  // -4 is far past the floor: a stack of drawbacks cannot run away.
  const dealt = applyDamage(x, 10, 'ice', { defense: 0, resistances: { ice: -4 } });
  assert.equal(dealt, 20, `an absurd negative resistance must cap at 2x raw, got ${dealt}`);
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

// --- Task 2: mark provocation ---
//
// SOMET-290 follow-up: the mark is a RECORD now (who, and until when), not a
// boolean, and these read it through isProvokedBy rather than by touching
// `_provokedBy` -- the shape belongs to damage.js and every consumer goes
// through the predicate.

test('any landed hit marks the target provoked BY THE ACTOR THAT LANDED IT', () => {
  const t_obj = { hp: 100, maxHp: 100 };
  applyDamage(t_obj, 10, 'physical', NO_MITIGATION, 0, playerKey(7));
  assert.equal(isProvokedBy(t_obj, playerKey(7), 0), true, 'the attacker was not remembered');
  // The half a bare boolean could not express: a creature must not fight
  // someone else's fight. Both alternatives are checked, because a key format
  // that collapsed players and creatures together would pass the first alone.
  assert.equal(isProvokedBy(t_obj, playerKey(8), 0), false,
    'a bystanding player was blamed for a hit they never landed');
  assert.equal(isProvokedBy(t_obj, creatureKey(7), 0), false,
    'a creature with the same id as the attacking player was blamed');
});

test('provocation expires on the clock, and every fresh hit re-arms it', () => {
  const t_obj = { hp: 1000, maxHp: 1000 };
  applyDamage(t_obj, 10, 'physical', NO_MITIGATION, 1000, playerKey(7));
  assert.equal(isProvokedBy(t_obj, playerKey(7), 1000 + PROVOKE_MEMORY_MS - 1), true,
    'forgot its attacker before the memory ran out');
  assert.equal(isProvokedBy(t_obj, playerKey(7), 1000 + PROVOKE_MEMORY_MS), false,
    'stayed angry past the memory window -- provocation leaks permanently again');

  // A second hit late in the window must extend it, or a long fight would go
  // calm mid-fight.
  applyDamage(t_obj, 10, 'physical', NO_MITIGATION, 1000 + PROVOKE_MEMORY_MS - 1, playerKey(7));
  assert.equal(isProvokedBy(t_obj, playerKey(7), 1000 + PROVOKE_MEMORY_MS + 1), true,
    'a fresh hit did not re-arm the memory');
});

test('an unattributed hit provokes against NOBODY, not against everybody', () => {
  // SOMET-290 follow-up (finding 2), and this reversed during the follow-up.
  //
  // While provocation only re-banded a skittish creature's MOVEMENT, "an
  // unnamed source provokes against whoever is around" was the mild direction:
  // the worst case was a deer that stopped running. It stopped being mild once
  // provocation also granted target acquisition out to the LEASH radius -- a
  // hit nobody could be blamed for would make a creature acquire and chase an
  // innocent player standing far outside its aggro radius.
  //
  // `damageCreatureById` and `applyDamage` both still default `source` to null,
  // so this is the behaviour the next unthreaded caller inherits.
  const t_obj = { hp: 100, maxHp: 100 };
  applyDamage(t_obj, 10, 'physical', NO_MITIGATION, 0);
  assert.equal(isProvokedBy(t_obj, playerKey(7), 0), false,
    'an unattributed hit blamed a player who landed nothing');
  assert.equal(isProvokedBy(t_obj, creatureKey('abc'), 0), false,
    'an unattributed hit blamed a creature that landed nothing');
  // ...and asking "was it provoked by nobody?" is not a way back in either.
  assert.equal(isProvokedBy(t_obj, null, 0), false,
    'a null actor key matched a null provoker');
});

test('a hit with no clock at all provokes indefinitely rather than not at all', () => {
  // Every pre-SOMET-290 caller (and any future one that forgets `now`) lands
  // here. `undefined + PROVOKE_MEMORY_MS` would be NaN, and `NaN > now` is
  // false -- i.e. a target that is instantly calm again, which is exactly the
  // failure this rewrite exists to remove.
  //
  // The SOURCE is named here even though the clock is not: the two are
  // independent, and after the finding-2 fix an unsourced hit provokes nobody
  // at any clock, so omitting both would prove nothing about the clock.
  const t_obj = { hp: 100, maxHp: 100 };
  applyDamage(t_obj, 10, 'physical', NO_MITIGATION, undefined, playerKey(7));
  assert.equal(isProvokedBy(t_obj, playerKey(7), 0), true);
  assert.equal(isProvokedBy(t_obj, playerKey(7), 1e12), true);
});

test('a hit against enormous defence still provokes', () => {
  // Named for what it can actually prove. MIN_DAMAGE floors every hit at 1, so
  // no amount of defence produces a zero-damage hit and this case cannot
  // distinguish an unconditional provoke from one gated on `final > 0` — the
  // sibling case above is what covers the mark itself. What this does pin is
  // that mitigation is not a separate escape route: however much of the swing
  // is absorbed, the target still knows it was hit.
  //
  // If the floor is ever removed, being hit for zero must STILL provoke — a
  // creature that ignores an attack it survived unharmed reads as broken.
  const t_obj = { hp: 100, maxHp: 100 };
  applyDamage(t_obj, 1, 'physical', { defense: 9999, resistances: {} }, 0, playerKey(7));
  assert.equal(isProvokedBy(t_obj, playerKey(7), 0), true);
});

test('a target nobody has hit is not provoked', () => {
  const t_obj = { hp: 100, maxHp: 100 };
  assert.equal(isProvokedBy(t_obj, playerKey(7), 0), false);
  assert.equal(isProvokedBy(t_obj, null, 0), false);
});
