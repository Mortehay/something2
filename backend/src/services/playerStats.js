// Player progression maths. PURE -- no database, no clock, no randomness.
//
// Every consumer of progression reads derivePlayerStats' bundle. Nothing
// outside this module and progressionStore.js reads the raw stat columns;
// that is what keeps six stats from becoming six scattered formulas.

const C = require('./progressionConstants.js');

const DEFAULT_PROGRESSION = Object.freeze({
  experience: 0,
  level: 1,
  stat_points: 0,
  strength: C.BASE_STAT,
  dexterity: C.BASE_STAT,
  constitution: C.BASE_STAT,
  intelligence: C.BASE_STAT,
  wisdom: C.BASE_STAT,
  charisma: C.BASE_STAT,
});

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Round to 4dp without floating-point noise. cooldownMult is a reciprocal and
// 1/(1+0.03*5) is 0.8695652173913044 -- an unrounded multiplier would make
// every cooldown assertion a float-tolerance argument.
function round4(n) { return Math.round(n * 10000) / 10000; }

// A stat column that is missing, null, or not a finite number falls back to
// the base rather than poisoning every derived value with NaN. Progression
// rows come from the database, and a NaN maxHp is an unkillable or
// instantly-dead player -- fail soft, in the direction of "as if level 1".
function stat(progression, key) {
  const v = progression == null ? undefined : progression[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= C.BASE_STAT ? n : C.BASE_STAT;
}

// The single source of every number a stat affects.
function derivePlayerStats(progression) {
  const above = (key) => stat(progression, key) - C.BASE_STAT;
  return {
    maxHp: C.HP_BASE + C.HP_PER_CON * above('constitution'),
    maxMana: C.MANA_BASE + C.MANA_PER_INT * above('intelligence'),
    meleeMult: round4(1 + C.MELEE_PER_STR * above('strength')),
    spellMult: round4(1 + C.SPELL_PER_INT * above('intelligence')),
    // Lower is faster. Floored so attack rate stays bounded.
    cooldownMult: Math.max(
      C.MIN_COOLDOWN_MULT,
      round4(1 / (1 + C.HASTE_PER_DEX * above('dexterity'))),
    ),
    manaRegen: round4(C.MANA_REGEN_BASE + C.MANA_REGEN_PER_WIS * above('wisdom')),
    // The fraction of an item's value a merchant pays. Capped strictly below
    // 1.0: see SELL_FRACTION_MAX in progressionConstants.js -- this is a
    // safety bound against an infinite-gold loop, not a balance knob.
    priceMult: Math.min(
      C.SELL_FRACTION_MAX,
      round4(C.SELL_FRACTION_BASE + C.PRICE_PER_CHA * above('charisma')),
    ),
  };
}

// Cumulative XP at which `level` begins. xpToNext is XP_BASE * level, so the
// floor is the triangular sum XP_BASE * (level-1) * level / 2.
function xpFloor(level) {
  const l = clamp(Math.floor(Number(level) || 1), 1, C.MAX_LEVEL);
  return (C.XP_BASE * (l - 1) * l) / 2;
}

function xpToNext(level) {
  const l = clamp(Math.floor(Number(level) || 1), 1, C.MAX_LEVEL);
  return l >= C.MAX_LEVEL ? Infinity : C.XP_BASE * l;
}

// Inverted by stepping, not by the quadratic formula. The closed form needs a
// sqrt, and a float sqrt lands on the wrong side of an exact boundary (xp
// 300 must be level 3, not level 2). MAX_LEVEL bounds this at 50 iterations.
function levelForXp(experience) {
  const xp = Math.max(0, Number(experience) || 0);
  let level = 1;
  while (level < C.MAX_LEVEL && xp >= xpFloor(level + 1)) level++;
  return level;
}

// XP for a kill, scaled by the creature's A1 level relative to the player's.
// The clamp's lower bound is 0, so a high-level player farming level-1 slimes
// earns literally nothing rather than a token trickle.
function xpForKill(creatureLevel, playerLevel) {
  const cl = Math.max(1, Math.floor(Number(creatureLevel) || 1));
  const pl = Math.max(1, Math.floor(Number(playerLevel) || 1));
  const factor = clamp(1 + C.XP_LEVEL_DIFF_SLOPE * (cl - pl), 0, C.XP_LEVEL_DIFF_MAX);
  return Math.max(0, Math.round(C.XP_KILL_BASE * cl * factor));
}

// Lose a fraction of the progress made INTO the current level. Because the
// loss is computed from the progress above the floor, it can never cross it:
// a player loses a level's worth of grinding but never a level.
function applyDeathPenalty(experience, level) {
  const floor = xpFloor(level);
  const xp = Math.max(floor, Number(experience) || 0);
  const lost = Math.floor(C.DEATH_PENALTY * (xp - floor));
  return { experience: xp - lost, lost };
}

// Every point ever spent above the base, across all six stats.
function refundedPoints(progression) {
  return C.STAT_KEYS.reduce((sum, k) => sum + (stat(progression, k) - C.BASE_STAT), 0);
}

module.exports = {
  derivePlayerStats, xpFloor, xpToNext, levelForXp, xpForKill,
  applyDeathPenalty, refundedPoints, DEFAULT_PROGRESSION,
};
