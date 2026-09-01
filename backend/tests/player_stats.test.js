const test = require('node:test');
const assert = require('node:assert');
const {
  derivePlayerStats, xpFloor, xpToNext, levelForXp, xpForKill,
  applyDeathPenalty, DEFAULT_PROGRESSION,
} = require('../src/services/playerStats.js');

const at = (over) => ({ ...DEFAULT_PROGRESSION, ...over });

// THE regression-safety test for the whole slice: a fresh character must
// reproduce the game's pre-A2 numbers exactly. Every number below is the
// literal the pre-A2 code used -- 100 from PLAYER_MAX_HP, 100 from
// PLAYER_MAX_MANA, 10 from PLAYER_MANA_REGEN, 0.5 from SELL_FRACTION.
test('a base character reproduces the pre-A2 numbers exactly', () => {
  const s = derivePlayerStats(DEFAULT_PROGRESSION);
  assert.equal(s.maxHp, 100);
  assert.equal(s.maxMana, 100);
  assert.equal(s.meleeMult, 1);
  assert.equal(s.spellMult, 1);
  assert.equal(s.cooldownMult, 1);
  assert.equal(s.manaRegen, 10);
  assert.equal(s.priceMult, 0.5);
});

test('each stat moves its own output and nothing else', () => {
  assert.equal(derivePlayerStats(at({ constitution: 7 })).maxHp, 120);
  assert.equal(derivePlayerStats(at({ constitution: 7 })).maxMana, 100);
  assert.equal(derivePlayerStats(at({ intelligence: 8 })).maxMana, 130);
  assert.equal(derivePlayerStats(at({ strength: 15 })).meleeMult, 1.5);
  assert.equal(derivePlayerStats(at({ strength: 15 })).spellMult, 1);
  assert.equal(derivePlayerStats(at({ intelligence: 15 })).spellMult, 1.5);
  assert.equal(derivePlayerStats(at({ wisdom: 25 })).manaRegen, 20);
  assert.equal(derivePlayerStats(at({ charisma: 15 })).priceMult, 0.7);
});

test('DEX shortens the cooldown and can never reach zero', () => {
  // 1 / (1 + 0.03 * 5) = 0.8695652... -> 0.8696 at 4dp
  assert.equal(derivePlayerStats(at({ dexterity: 10 })).cooldownMult, 0.8696);
  // The floor: an absurd DEX still cannot exceed the clamp.
  assert.equal(derivePlayerStats(at({ dexterity: 999 })).cooldownMult, 0.4);
});

// The money-printer guard. The village base catalog sells at `value` and buys
// back at `value * priceMult`; a priceMult >= 1 turns that into infinite gold.
test('the sell fraction is capped strictly below 1.0 at any charisma', () => {
  assert.equal(derivePlayerStats(at({ charisma: 999 })).priceMult, 0.9);
  assert.ok(derivePlayerStats(at({ charisma: 999 })).priceMult < 1,
    'a sell fraction of 1.0 or more is a buy-low-sell-high money printer');
});

// SOMET-486. Pools now start from the CLASS's base, and the stat scaling sits
// on top of it. Every expected value below is hand-computed from the migration
// 1714440509000 numbers and progressionConstants' growth rates, never by
// calling the function twice or re-summing its own constants.
test('class base pools replace the universal base, and stats still scale on top', () => {
  const WARRIOR = { maxHp: 100, maxMana: 100 };
  const RANGER = { maxHp: 85, maxMana: 115 };
  const MAGE = { maxHp: 75, maxMana: 150 };

  // At BASE_STAT a character's pools ARE its class's base pools.
  assert.deepEqual(
    [derivePlayerStats(DEFAULT_PROGRESSION, WARRIOR).maxHp, derivePlayerStats(DEFAULT_PROGRESSION, WARRIOR).maxMana],
    [100, 100], 'Warrior is frozen at the pre-486 numbers -- every live character is one');
  assert.deepEqual(
    [derivePlayerStats(DEFAULT_PROGRESSION, RANGER).maxHp, derivePlayerStats(DEFAULT_PROGRESSION, RANGER).maxMana],
    [85, 115]);
  assert.deepEqual(
    [derivePlayerStats(DEFAULT_PROGRESSION, MAGE).maxHp, derivePlayerStats(DEFAULT_PROGRESSION, MAGE).maxMana],
    [75, 150]);

  // AC4: CON still buys HP and INT still buys mana, ON TOP of the class base
  // rather than instead of it. CON 15 is 10 above BASE_STAT(5) -> +100 hp;
  // INT 8 is 3 above -> +30 mana. A Mage: 75+100 = 175 hp, 150+30 = 180 mana.
  const grown = derivePlayerStats(at({ constitution: 15, intelligence: 8 }), MAGE);
  assert.equal(grown.maxHp, 175, 'HP_PER_CON must add to the class base, not replace it');
  assert.equal(grown.maxMana, 180, 'MANA_PER_INT must add to the class base, not replace it');

  // The same growth on a Warrior lands 25 hp higher and 50 mana lower --
  // the class difference must SURVIVE levelling, not wash out.
  const warriorGrown = derivePlayerStats(at({ constitution: 15, intelligence: 8 }), WARRIOR);
  assert.equal(warriorGrown.maxHp - grown.maxHp, 25);
  assert.equal(grown.maxMana - warriorGrown.maxMana, 50);
});

// AC5. entity_types.max_hp/max_mana are nullable and default to 0, so both
// shapes have to fail soft. A NaN pool is an unkillable or instantly-dead
// player; a 0 pool is a player who is dead on arrival.
test('a missing, null or zero class pool falls back to HP_BASE/MANA_BASE, never NaN', () => {
  for (const [label, pools] of [
    ['omitted', undefined],
    ['null', null],
    ['null columns', { maxHp: null, maxMana: null }],
    ['zero columns (the entity_types default)', { maxHp: 0, maxMana: 0 }],
    ['non-numeric', { maxHp: 'lots', maxMana: {} }],
  ]) {
    const s = derivePlayerStats(DEFAULT_PROGRESSION, pools);
    assert.equal(s.maxHp, 100, `maxHp with ${label} pools`);
    assert.equal(s.maxMana, 100, `maxMana with ${label} pools`);
  }
  // And the fallback still scales, rather than being a flat constant.
  assert.equal(derivePlayerStats(at({ constitution: 15 }), null).maxHp, 200);
});

test('a malformed progression falls back to base rather than NaN', () => {
  const s = derivePlayerStats({});
  assert.equal(s.maxHp, 100);
  assert.equal(s.maxMana, 100);
  assert.equal(s.meleeMult, 1);
  assert.equal(s.spellMult, 1);
  assert.equal(s.cooldownMult, 1);
  assert.equal(s.manaRegen, 10);
  assert.equal(s.priceMult, 0.5);
  assert.equal(derivePlayerStats(null).maxHp, 100);
  assert.equal(derivePlayerStats({ constitution: 'seven' }).maxHp, 100);
});


// Every number below is a hand-computed literal for
// xpToNext(L) = round(18 * L^1.33), verified with `node -e` before being
// written here. NOT one of them is produced by calling xpToNext or by
// re-implementing the formula: an XP-curve test that builds its own
// expectation from the code's own constants proves nothing, and this repo's
// dominant test failure is exactly that.
//
// The spec's own table is wrong at two rows -- it printed 8240 for level 100
// and 14123 for level 150. The correct values are 8228 and 14108.
test('the XP curve costs the documented amount at every checked level', () => {
  assert.equal(xpToNext(1), 18);
  assert.equal(xpToNext(2), 45);
  assert.equal(xpToNext(3), 78);
  assert.equal(xpToNext(4), 114);
  assert.equal(xpToNext(5), 153);
  assert.equal(xpToNext(7), 239);
  assert.equal(xpToNext(10), 385);
  assert.equal(xpToNext(50), 3273);
  assert.equal(xpToNext(100), 8228);
  // MAX_LEVEL: there is no next level to buy.
  assert.equal(xpToNext(150), Infinity);
  assert.equal(xpToNext(151), Infinity);
});

// The cumulative table. Also literals: xpFloor has no closed form with a
// fractional exponent, so there is no formula to write inline the way the old
// triangular-sum version did -- which makes a direct equality check against
// hand-computed numbers the ONLY thing that can catch a floor that is too
// high, since every downstream clamp trivially satisfies a >= assertion.
test('the cumulative floors are the documented literals', () => {
  assert.equal(xpFloor(1), 0);
  assert.equal(xpFloor(2), 18);
  assert.equal(xpFloor(3), 63);
  assert.equal(xpFloor(4), 141);
  assert.equal(xpFloor(5), 255);
  assert.equal(xpFloor(7), 603);
  assert.equal(xpFloor(10), 1463);
  assert.equal(xpFloor(50), 68598);
  assert.equal(xpFloor(100), 349010);
  assert.equal(xpFloor(150), 901212);
  // Out of range clamps rather than returning NaN or undefined.
  assert.equal(xpFloor(0), 0);
  assert.equal(xpFloor(999), 901212);
});

// The floors must be strictly increasing across all 150 levels. A binary
// search over a table that is not sorted returns a plausible wrong answer
// silently, and no single-point assertion above can see that.
test('the floor table is strictly increasing for all 150 levels', () => {
  for (let level = 2; level <= 150; level++) {
    assert.ok(xpFloor(level) > xpFloor(level - 1),
      `xpFloor(${level}) = ${xpFloor(level)} is not above xpFloor(${level - 1}) = ${xpFloor(level - 1)}`);
  }
});

// The exact-boundary cases the binary search has to get right. An off-by-one
// in the search puts an exact total on the wrong side and a player one level
// behind for the rest of their life.
test('levelForXp inverts the curve exactly at the boundaries', () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(17), 1);
  assert.equal(levelForXp(18), 2);   // exactly on the boundary
  assert.equal(levelForXp(62), 2);
  assert.equal(levelForXp(63), 3);
  assert.equal(levelForXp(140), 3);
  assert.equal(levelForXp(141), 4);
  assert.equal(levelForXp(254), 4);
  assert.equal(levelForXp(255), 5);
  assert.equal(levelForXp(68597), 49);
  assert.equal(levelForXp(68598), 50);
  assert.equal(levelForXp(901211), 149);
  assert.equal(levelForXp(901212), 150);
  assert.equal(levelForXp(999999999), 150); // clamped at MAX_LEVEL
});

test('kill XP rewards a harder creature and decays to zero on a trivial one', () => {
  assert.equal(xpForKill(1, 1), 10);
  assert.equal(xpForKill(5, 1), 90);
  assert.equal(xpForKill(12, 1), 240);  // clamped at XP_LEVEL_DIFF_MAX
  assert.equal(xpForKill(1, 6), 0);     // diff -5: exactly zero
  assert.equal(xpForKill(1, 10), 0);    // never negative
});

// Level 3 is worth xpToNext(3) = 78 and its floor is 63. Every expected
// number below is hand-computed from those two literals.
test('death costs a random slice of what the level is worth', () => {
  // Draw 0 -> the 0.5% floor: floor(0.005 * 78) = floor(0.39) = 0.
  assert.deepStrictEqual(applyDeathPenalty(500, 3, 0), { experience: 500, lost: 0 });
  // Draw 1 -> the 10% ceiling: floor(0.10 * 78) = floor(7.8) = 7.
  assert.deepStrictEqual(applyDeathPenalty(500, 3, 1), { experience: 493, lost: 7 });
  // Draw 0.5 -> 5.25%: floor(0.0525 * 78) = floor(4.095) = 4.
  assert.deepStrictEqual(applyDeathPenalty(500, 3, 0.5), { experience: 496, lost: 4 });
});

// Level 10 is worth 385, which is large enough that all five draws land on
// distinct values -- a formula that ignored `unit`, or used the wrong end of
// the range, would collapse this list.
test('the roll spans the whole 0.5%-10% band and never leaves it', () => {
  const losses = [0, 0.25, 0.5, 0.75, 1].map((u) => applyDeathPenalty(100000, 10, u).lost);
  assert.deepStrictEqual(losses, [1, 11, 20, 29, 38]);
  for (const u of [-5, 2, NaN, undefined, 'half']) {
    const { lost } = applyDeathPenalty(100000, 10, u);
    assert.ok(lost >= 1 && lost <= 38, `draw ${String(u)} escaped the band: ${lost}`);
  }
});

test('death never de-levels, and the clamp reports the real loss', () => {
  // Exactly at the floor there is nothing to lose, at ANY draw. xpFloor(3) is
  // the literal 63 from the table above.
  assert.deepStrictEqual(applyDeathPenalty(63, 3, 1), { experience: 63, lost: 0 });
  // Barely into the level: the 10% roll wants 7 but only 4 exist. `lost` must
  // report 4, not 7 -- an over-reported loss would lie to the player and to
  // the wire message the sheet renders.
  assert.deepStrictEqual(applyDeathPenalty(67, 3, 1), { experience: 63, lost: 4 });

  // MAX_LEVEL is the case a naive implementation gets wrong: xpToNext(150) is
  // Infinity by design, so deriving the loss from it would wipe out every
  // point of progress above the floor. Level 150 is WORTH 14108, so a
  // full-strength roll costs floor(0.10 * 14108) = 1410.
  assert.deepStrictEqual(applyDeathPenalty(901212 + 2000, 150, 1),
    { experience: 901212 + 590, lost: 1410 });

  // The invariant, stated directly, across the whole range: for every level
  // and every XP inside it, the result never falls below the level's floor.
  // The floors themselves are pinned above as literals, so a bug confined to
  // xpFloor cannot corrupt both the input and the expectation identically.
  for (let level = 1; level <= 150; level++) {
    const floor = xpFloor(level);
    for (const offset of [0, 1, 7, 50, 999]) {
      const xp = floor + offset;
      for (const unit of [0, 1]) {
        const out = applyDeathPenalty(xp, level, unit);
        assert.ok(out.experience >= floor,
          `level ${level} +${offset} at draw ${unit} de-levelled: ${out.experience} < ${floor}`);
        assert.equal(out.experience, xp - out.lost,
          `level ${level} +${offset} at draw ${unit}: reported loss ${out.lost} does not match the XP actually removed`);
      }
    }
  }
});

// The stat-point system is gone: DEFAULT_PROGRESSION must not carry a
// stat_points field, and refundedPoints must not be exported at all. A test
// that only checked passive_points was present would still pass with a
// vestigial stat_points riding along into every INSERT.
test('the stat-point system leaves no trace on the default progression', () => {
  assert.ok(!('stat_points' in DEFAULT_PROGRESSION), 'stat_points must be gone entirely');
  assert.equal(DEFAULT_PROGRESSION.passive_points, 0);
  assert.equal(require('../src/services/playerStats.js').refundedPoints, undefined);
});

// ---------------------------------------------------------------------------
// SOMET-513: the `rules` passthrough.
//
// The nine rules SOMET-512 adds reach the authority through this ONE field, so
// its two failure modes both get a test: a populated map must arrive intact
// (not merged, not filtered, not re-derived), and an absent one must arrive as
// every rule at its identity rather than as `undefined`.
// ---------------------------------------------------------------------------

const { RULE_COMBINE, RULE_IDENTITIES } = require('../src/services/statComposition.js');

test('rules ride the derived bundle unchanged', () => {
  const rules = { lifeCostMultiplier: 0.75, treeCharmBonus: 3, cooldownFloor: 0.32, regenLifeShare: 0.2 };
  const s = derivePlayerStats(at({ rules }));
  assert.deepEqual(s.rules, rules);
});

// The identity fallback is the half that actually breaks things when it is
// wrong: a `product` rule read as undefined multiplies to NaN, and NaN damage
// is an immortal target. Asserting `!== undefined` per key is the point --
// deepEqual against RULE_IDENTITIES alone would pass if BOTH sides were empty.
test('a progression with no tree context gets every rule at its identity', () => {
  for (const p of [DEFAULT_PROGRESSION, at({}), {}, null, undefined]) {
    const s = derivePlayerStats(p);
    assert.deepEqual(s.rules, RULE_IDENTITIES, 'fallback must be the identity map');
    for (const key of Object.keys(RULE_COMBINE)) {
      assert.ok(key in s.rules, `rule ${key} missing from the identity fallback`);
    }
  }
});

// RULE_IDENTITIES is DERIVED from RULE_COMBINE, which is the whole reason it is
// imported rather than written out by hand. This pins that: a rule added to
// RULE_COMBINE with no identity would arrive at every consumer as undefined.
test('every combinable rule has an identity, at the value its mode means', () => {
  const expected = { product: 1, sum: 0, min: null };
  for (const [key, mode] of Object.entries(RULE_COMBINE)) {
    assert.ok(key in RULE_IDENTITIES, `rule ${key} has no identity`);
    assert.equal(RULE_IDENTITIES[key], expected[mode],
      `rule ${key} combines by ${mode}, so its identity must be ${expected[mode]}`);
  }
});

// The named lifeCostMultiplier field is kept for its existing call sites. It
// and rules.lifeCostMultiplier are the same value from the same source, and a
// future edit that re-derives one of them separately must fail here.
test('lifeCostMultiplier agrees with its entry in the rules map', () => {
  const s = derivePlayerStats(at({ rules: { ...RULE_IDENTITIES, lifeCostMultiplier: 0.75 } }));
  assert.equal(s.lifeCostMultiplier, 0.75);
  assert.equal(s.lifeCostMultiplier, s.rules.lifeCostMultiplier);
});
