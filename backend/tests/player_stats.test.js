const test = require('node:test');
const assert = require('node:assert');
const {
  derivePlayerStats, xpFloor, xpToNext, levelForXp, xpForKill,
  applyDeathPenalty, refundedPoints, DEFAULT_PROGRESSION,
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

test('the XP curve has the documented floors', () => {
  assert.equal(xpFloor(1), 0);
  assert.equal(xpFloor(2), 100);
  assert.equal(xpFloor(3), 300);
  assert.equal(xpFloor(4), 600);
  assert.equal(xpFloor(5), 1000);
  assert.equal(xpToNext(1), 100);
  assert.equal(xpToNext(4), 400);
});

test('levelForXp inverts the curve exactly at the boundaries', () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(99), 1);
  assert.equal(levelForXp(100), 2);   // exactly on the boundary
  assert.equal(levelForXp(299), 2);
  assert.equal(levelForXp(300), 3);
  assert.equal(levelForXp(999999999), 50); // clamped at MAX_LEVEL
});

test('kill XP rewards a harder creature and decays to zero on a trivial one', () => {
  assert.equal(xpForKill(1, 1), 10);
  assert.equal(xpForKill(5, 1), 90);
  assert.equal(xpForKill(12, 1), 240);  // clamped at XP_LEVEL_DIFF_MAX
  assert.equal(xpForKill(1, 6), 0);     // diff -5: exactly zero
  assert.equal(xpForKill(1, 10), 0);    // never negative
});

test('death costs progress into the level and never de-levels', () => {
  assert.deepStrictEqual(applyDeathPenalty(500, 3), { experience: 450, lost: 50 });
  // Exactly at the floor there is nothing to lose.
  assert.deepStrictEqual(applyDeathPenalty(300, 3), { experience: 300, lost: 0 });
  // The invariant, stated directly: for every level and every XP inside it,
  // the result never falls below the level's floor. The floor used here is
  // the closed form written out inline -- NOT a call into xpFloor -- so a bug
  // confined to xpFloor cannot corrupt both the input and the expectation
  // identically and cancel itself out. xpFloor is also checked directly
  // against that same closed form for every level, because the >= invariant
  // below is structurally unable to catch a floor that is too HIGH: the
  // clamp in applyDeathPenalty guarantees out.experience >= whatever floor
  // it was given, so an over-reporting xpFloor still trivially satisfies the
  // inequality. Only a direct equality check on xpFloor's own output can
  // catch that.
  for (let level = 1; level <= 50; level++) {
    const expectedFloor = 50 * (level - 1) * level;
    assert.equal(xpFloor(level), expectedFloor,
      `xpFloor(${level}) diverged from the closed form: ${xpFloor(level)} !== ${expectedFloor}`);
    for (const offset of [0, 1, 7, 50, 999]) {
      const xp = expectedFloor + offset;
      const out = applyDeathPenalty(xp, level);
      assert.ok(out.experience >= expectedFloor,
        `level ${level} +${offset} de-levelled: ${out.experience} < ${expectedFloor}`);
    }
  }
});

test('refundedPoints returns every point ever spent', () => {
  assert.equal(refundedPoints(DEFAULT_PROGRESSION), 0);
  assert.equal(refundedPoints(at({ strength: 10, wisdom: 8 })), 8);
});
