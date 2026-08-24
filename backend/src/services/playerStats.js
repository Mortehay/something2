// Player progression maths. PURE -- no database, no clock, no randomness.
//
// Every consumer of progression reads derivePlayerStats' bundle. Nothing
// outside this module and progressionStore.js reads the raw stat columns;
// that is what keeps six stats from becoming six scattered formulas.
//
// SOMET-486: pools now take the CLASS's base as their starting point, passed
// in as `classPools`. This is still the only place a pool is computed -- the
// class row supplies a base, not a formula. Anything that puts a second
// `+ classSomething` on a pool outside this function reintroduces the exact
// split that let character select advertise 100/85/75 for eleven months while
// the game handed everyone 100.

const C = require('./progressionConstants.js');

const DEFAULT_PROGRESSION = Object.freeze({
  experience: 0,
  level: 1,
  passive_points: 0,
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

// A class's base pool, or the universal fallback when there is no class row,
// the column is NULL, or it is not a finite number.
//
// SOMET-486: HP_BASE/MANA_BASE stopped being the universal base and became the
// FALLBACK. Every caller that knows which class a character is must pass
// classPools -- see characters.js `classPoolsFromRow`, which is the one place
// the entity_types columns are read. A caller that does not know the class
// (a pure unit test, a progression row with no character context) still gets
// the pre-486 numbers, which is what keeps Warrior-only databases unmoved.
//
// Fails soft rather than producing NaN, for exactly the reason stat() does: a
// NaN maxHp is an unkillable or instantly-dead player.
function poolBase(classPools, key, fallback) {
  const v = classPools == null ? undefined : classPools[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The passive tree's `lifeCostMultiplier` rule, carried onto the derived
// bundle so the authority has ONE place to read it (SOMET-472).
//
// It rides `stats` rather than living as its own field on the player object
// because `stats` is the only bundle every re-derive path already refreshes --
// join, level-up, chest XP, socket, allocate, respec all go through
// derivePlayerStats and then applyDerivedStats. A separate player field would
// be written once at join and then go stale the moment a Cultist allocated
// Blood Pact, which is precisely the silent half-wired shape this epic keeps
// shipping.
//
// `progression.rules` is composeStats' aggregate (contract §2 / §6.11),
// attached to every row loadProgression returns. A progression object with no
// tree context at all -- DEFAULT_PROGRESSION, a unit-test literal, a row read
// before the tree was seeded -- has no `rules`, and degrades to 1: no
// discount, never a free cast.
function ruleLifeCostMultiplier(progression) {
  const rules = progression == null ? null : progression.rules;
  const v = rules == null ? undefined : rules.lifeCostMultiplier;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// The single source of every number a stat affects.
//
// `classPools` is `{ maxHp, maxMana }` -- the class's BASE pools, before any
// stat scaling. It is the class's whole mechanical contribution to pools;
// there is deliberately no second per-class term anywhere else (contract
// §6.11: start nodes grant RULES, never raw pool bonuses, so class identity
// cannot be counted twice).
function derivePlayerStats(progression, classPools = null) {
  const above = (key) => stat(progression, key) - C.BASE_STAT;
  return {
    maxHp: poolBase(classPools, 'maxHp', C.HP_BASE) + C.HP_PER_CON * above('constitution'),
    maxMana: poolBase(classPools, 'maxMana', C.MANA_BASE) + C.MANA_PER_INT * above('intelligence'),
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
    // Passed straight to lifeCost.js `lifeCostFor` at the one attack gate.
    // NOT derived from any stat -- it is a passive-tree rule, carried here
    // only so it reaches the authority by the same route every other derived
    // number does.
    lifeCostMultiplier: ruleLifeCostMultiplier(progression),
  };
}

// What level `level` COSTS to buy. Kept separate from xpToNext because
// xpToNext deliberately returns Infinity at MAX_LEVEL, and applyDeathPenalty
// needs the finite number there (see its own comment). One formula, two
// callers -- not two copies of `18 * L^1.33`.
function levelWorth(level) {
  const l = clamp(Math.floor(Number(level) || 1), 1, C.MAX_LEVEL);
  return Math.round(C.XP_BASE * Math.pow(l, C.XP_EXPONENT));
}

// Cumulative XP at which each level begins, precomputed once at module load.
// A fractional exponent has no closed-form cumulative sum, so there is
// nothing to evaluate per call -- and a 150-entry array is cheaper than the
// old triangular formula anyway. Index 0 is unused; XP_FLOORS[l] is the floor
// of level l.
const XP_FLOORS = (() => {
  const floors = new Array(C.MAX_LEVEL + 1);
  floors[1] = 0;
  for (let l = 2; l <= C.MAX_LEVEL; l++) floors[l] = floors[l - 1] + levelWorth(l - 1);
  return floors;
})();

function xpFloor(level) {
  return XP_FLOORS[clamp(Math.floor(Number(level) || 1), 1, C.MAX_LEVEL)];
}

function xpToNext(level) {
  const l = clamp(Math.floor(Number(level) || 1), 1, C.MAX_LEVEL);
  return l >= C.MAX_LEVEL ? Infinity : levelWorth(l);
}

// Binary search over XP_FLOORS, not a linear walk and never a float inverse.
// The closed form would need a 1/1.33 power, and a float root lands on the
// wrong side of an exact boundary (xp 18 must be level 2, not level 1). The
// search returns the greatest level whose floor is <= xp, which is exact for
// every integer total.
function levelForXp(experience) {
  const xp = Math.max(0, Number(experience) || 0);
  let lo = 1;
  let hi = C.MAX_LEVEL;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xp >= XP_FLOORS[mid]) lo = mid; else hi = mid - 1;
  }
  return lo;
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

// Lose a random slice of what the current level is WORTH -- 0.5% to 10% of
// xpToNext(level), rolled per death.
//
// Takes a [0,1] draw rather than calling Math.random() itself, for the same
// reason creatureLevel.js's rollCreatureLevel does: a formula that generates
// its own randomness cannot be tested against literal expected values, and
// this repo's dominant test failure is assertions derived from the same
// constants as the code. The caller owns the draw; this stays pure.
//
// The level's worth is taken from levelWorth(level) rather than by calling
// xpToNext(level), because xpToNext deliberately returns Infinity at
// MAX_LEVEL -- an infinite raw loss would silently become "everything above
// the floor", i.e. a flat 100% penalty for max-level players only. levelWorth
// is the SAME function xpToNext evaluates below MAX_LEVEL, so the two cannot
// drift; the previous stand-in here was a second, hand-inlined copy of the
// curve (`XP_BASE * level`) and it became silently wrong the moment the curve
// stopped being linear.
//
// The clamp is what preserves the never-de-level guarantee, and it now does
// real work: the loss is derived from the level's total cost, so it can
// exceed the progress actually made. A player who just levelled up loses
// nothing. `lost` is reported AFTER clamping, so it never over-reports.
function applyDeathPenalty(experience, level, unit) {
  const floor = xpFloor(level);
  const xp = Math.max(floor, Number(experience) || 0);
  const lvl = clamp(Math.floor(Number(level) || 1), 1, C.MAX_LEVEL);

  const u = Number.isFinite(unit) ? clamp(unit, 0, 1) : 0;
  const fraction = C.DEATH_PENALTY_MIN + u * (C.DEATH_PENALTY_MAX - C.DEATH_PENALTY_MIN);
  const worth = levelWorth(lvl);

  const lost = Math.min(Math.floor(fraction * worth), xp - floor);
  return { experience: xp - lost, lost };
}

module.exports = {
  derivePlayerStats, xpFloor, xpToNext, levelForXp, xpForKill,
  applyDeathPenalty, DEFAULT_PROGRESSION,
};
