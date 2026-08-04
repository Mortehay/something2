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

// Level 3 is worth xpToNext(3) = 300 XP and its floor is 300. Every expected
// number below is hand-computed from those two facts and written as a literal.
test('death costs a random slice of what the level is worth', () => {
  // Draw 0 -> the 0.5% floor of the range: floor(0.005 * 300) = 1.
  assert.deepStrictEqual(applyDeathPenalty(500, 3, 0), { experience: 499, lost: 1 });
  // Draw 1 -> the 10% ceiling: floor(0.10 * 300) = 30.
  assert.deepStrictEqual(applyDeathPenalty(500, 3, 1), { experience: 470, lost: 30 });
  // Draw 0.5 -> 5.25%: floor(0.0525 * 300) = floor(15.75) = 15.
  assert.deepStrictEqual(applyDeathPenalty(500, 3, 0.5), { experience: 485, lost: 15 });
});

test('the roll spans the whole 0.5%-10% band and never leaves it', () => {
  // Sweep the draw and confirm the loss is monotonic in it and bounded by the
  // two literals above -- a formula that ignored `unit`, or that used the
  // wrong end of the range, would collapse this to a single value.
  const losses = [0, 0.25, 0.5, 0.75, 1].map((u) => applyDeathPenalty(100000, 3, u).lost);
  assert.deepStrictEqual(losses, [1, 8, 15, 22, 30]);
  for (const u of [-5, 2, NaN, undefined, 'half']) {
    const { lost } = applyDeathPenalty(100000, 3, u);
    assert.ok(lost >= 1 && lost <= 30, `draw ${String(u)} escaped the band: ${lost}`);
  }
});

test('death never de-levels, and the clamp reports the real loss', () => {
  // Exactly at the floor there is nothing to lose, at ANY draw.
  assert.deepStrictEqual(applyDeathPenalty(300, 3, 1), { experience: 300, lost: 0 });
  // Barely into the level: the 10% roll wants 30 but only 4 exist. `lost` must
  // report 4, not 30 -- an over-reported loss would lie to the player and to
  // the wire message the sheet renders.
  assert.deepStrictEqual(applyDeathPenalty(304, 3, 1), { experience: 300, lost: 4 });

  // MAX_LEVEL is the case a naive implementation gets wrong: xpToNext(50) is
  // Infinity by design, so deriving the loss from it would wipe out every
  // point of progress above the floor. Level 50 is worth 100*50 = 5000, so a
  // full-strength roll costs floor(0.10 * 5000) = 500.
  assert.deepStrictEqual(applyDeathPenalty(xpFloor(50) + 900, 50, 1),
    { experience: xpFloor(50) + 400, lost: 500 });

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
      // Both ends of the roll, because the loss now derives from the level's
      // total worth rather than from progress made, so the strongest draw is
      // the one most able to punch through the floor.
      for (const unit of [0, 1]) {
        const out = applyDeathPenalty(xp, level, unit);
        assert.ok(out.experience >= expectedFloor,
          `level ${level} +${offset} at draw ${unit} de-levelled: ${out.experience} < ${expectedFloor}`);
        assert.equal(out.experience, xp - out.lost,
          `level ${level} +${offset} at draw ${unit}: reported loss ${out.lost} does not match the XP actually removed`);
      }
    }
  }
});

test('refundedPoints returns every point ever spent', () => {
  assert.equal(refundedPoints(DEFAULT_PROGRESSION), 0);
  assert.equal(refundedPoints(at({ strength: 10, wisdom: 8 })), 8);
});
