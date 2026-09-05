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
// SOMET-513. statComposition.js is a PURE leaf module (no requires of its own),
// so this cannot cycle. RULE_IDENTITIES is imported rather than re-declared
// precisely because it is derived from RULE_COMBINE: a rule added there is
// present here automatically, and the two cannot drift.
const { RULE_IDENTITIES } = require('./statComposition.js');

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

// SOMET-495. The tree's `resource` grants, as a FLAT addition to a pool.
//
// It rides the derived bundle for the identical reason lifeCostMultiplier
// does, one comment up: `stats` is the only bundle every re-derive path
// already refreshes, so an allocated "+150 maximum life" is live the instant
// applyDerivedStats runs and a respec that drops it shrinks the pool again.
// A progression object with no tree context -- DEFAULT_PROGRESSION, a unit-test
// literal, a row read before the tree was seeded -- has no `pools` and
// contributes 0, which is what keeps every pre-495 number unmoved.
//
// Deliberately NOT clamped to >= 0 here: `pools` is composeStats' sum, and a
// future drawback node granting -20 hp must be able to shrink the pool. The
// floor that matters is on the RESULT (a pool of at least 1), applied below,
// so no combination of grants can produce a zero or negative maximum.
function poolGrant(progression, key) {
  const pools = progression == null ? null : progression.pools;
  const v = pools == null ? undefined : pools[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// SOMET-495. `damage` / `resist` / `status` grants, carried onto the derived
// bundle UNCHANGED -- this module composes no number from them, it is only the
// courier, because `stats` is the one bundle the authority refreshes on every
// re-derive (join, level-up, socket, allocate, respec).
//
// Each is defaulted to a shape its consumer can read without a guard: an empty
// resist map merges as nothing, and an absent multiplier would be `undefined`,
// which multiplies to NaN. The four fallbacks below are what let every unit
// test that builds a bare progression literal keep working untouched.
const NO_DAMAGE_MULT = Object.freeze({
  physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1,
});
const NO_RESISTS = Object.freeze({});
const NO_STATUSES = Object.freeze([]);

function damageMultOf(progression) {
  const m = progression == null ? null : progression.damageMult;
  return m && typeof m === 'object' ? m : NO_DAMAGE_MULT;
}

function resistsOf(progression) {
  const r = progression == null ? null : progression.resists;
  return r && typeof r === 'object' ? r : NO_RESISTS;
}

function hitStatusesOf(progression) {
  const s = progression == null ? null : progression.hitStatuses;
  return Array.isArray(s) ? s : NO_STATUSES;
}

// SOMET-513. composeStats' whole `rules` aggregate, carried onto the derived
// bundle UNCHANGED -- this module composes nothing from it, it is only the
// courier, exactly like damageMult/resists/hitStatuses above.
//
// WHY ONE PASSTHROUGH OBJECT AND NOT ONE NAMED FIELD PER RULE. The passive
// tree epic (SOMET-512) takes the vocabulary from four rules to thirteen.
// `ruleLifeCostMultiplier` below is the pre-495 shape -- one accessor per rule
// -- and nine more copies of it would be nine copies of the same three-line
// guard, each an independent chance to forget one. The aggregates SOMET-495
// added chose the other shape and that is the one that scales.
//
// WHY IT RIDES `stats` AT ALL. `stats` is the only bundle every re-derive path
// already refreshes -- join, level-up, chest XP, socket, allocate, respec all
// go through derivePlayerStats and then applyDerivedStats. A rule written onto
// the player object instead would be set once at join and go stale the moment
// a node was allocated: the silent half-wired shape this epic exists to stop.
//
// A progression object with no tree context -- DEFAULT_PROGRESSION, a unit-test
// literal, a row read before the tree was seeded -- has no `rules` and gets
// RULE_IDENTITIES: every rule present, at the value that means "no node
// allocated". Consumers therefore read `stats.rules.attackSpeedMult` and get a
// number, never `undefined` (which multiplies to NaN).
function rulesOf(progression) {
  const r = progression == null ? null : progression.rules;
  return r && typeof r === 'object' ? r : RULE_IDENTITIES;
}

// SOMET-514. THE CONSUMER of the tree's `cooldownFloor` rule.
//
// This rule was declared in RULE_KEYS from the start, naming THIS function as
// its consumer -- and no such read existed. cooldownMult was floored with the
// bare C.MIN_COOLDOWN_MULT constant, so `ks_dex_fleet` ("your cooldown floor
// drops from 0.40 to 0.32") did nothing, and so did the ARCHER'S START NODE,
// whose only grant is cooldownFloor 0.38. Every Archer began the game with no
// class identity whatsoever. See passive_rules.test.js's source gate, which
// now makes that state unshippable.
//
// The combine mode is `min` with a NULL identity, deliberately: a player with
// no such node allocated must land on C.MIN_COOLDOWN_MULT, not on 0. A 0 floor
// removes the bound entirely and lets a stack of haste drive the attack
// interval toward zero.
//
// `n > 0` rather than `Number.isFinite(n)` for exactly that reason -- null, 0
// and a negative all mean "no usable floor" and all fall back to the constant.
function cooldownFloorOf(progression) {
  const v = rulesOf(progression).cooldownFloor;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : C.MIN_COOLDOWN_MULT;
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
    // SOMET-495: class base, then the stat scaling, then the tree's flat
    // grant -- in that order and all three, which is the whole content of
    // "a +10 hp node raises maxHp by 10 on top of everything else".
    // Floored at 1: a pool of 0 is a player who cannot exist, and Math.max on
    // the RESULT is what lets poolGrant stay unclamped for drawback nodes.
    maxHp: Math.max(1, poolBase(classPools, 'maxHp', C.HP_BASE)
      + C.HP_PER_CON * above('constitution') + poolGrant(progression, 'hp')),
    maxMana: Math.max(0, poolBase(classPools, 'maxMana', C.MANA_BASE)
      + C.MANA_PER_INT * above('intelligence') + poolGrant(progression, 'mana')),
    // Stamina has no stat that scales it and no per-class base -- it is the one
    // pool the tree alone moves. It was a bare constant in world.js until
    // SOMET-495; it lives here now so every re-derive path refreshes it by the
    // same route as hp and mana, rather than being written once at join.
    maxStamina: Math.max(1, C.STAMINA_BASE + poolGrant(progression, 'stamina')),
    meleeMult: round4(1 + C.MELEE_PER_STR * above('strength')),
    spellMult: round4(1 + C.SPELL_PER_INT * above('intelligence')),
    // Lower is faster. Floored so attack rate stays bounded.
    // SOMET-514: the floor is the tree's `cooldownFloor` rule when a node
    // supplies one, and C.MIN_COOLDOWN_MULT otherwise. Until this ticket it
    // was always the constant, which is what made the Archer's start node and
    // ks_dex_fleet inert.
    cooldownMult: Math.max(
      cooldownFloorOf(progression),
      round4(1 / (1 + C.HASTE_PER_DEX * above('dexterity'))),
    ),
    // SOMET-519. The RESOLVED floor, carried so the authority can bound the
    // cooldown AFTER it has applied attackSpeedMult/castSpeedMult.
    //
    // Flooring `cooldownMult` above is not enough on its own: the authority
    // divides it by a speed multiplier, and `Math.max(floor, x) / speed` is
    // unbounded below. Exposing the same resolved number both places read is
    // what stops world.js re-deriving its own floor from C.MIN_COOLDOWN_MULT
    // and silently ignoring a player's cooldownFloor node.
    cooldownFloor: cooldownFloorOf(progression),
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
    //
    // SOMET-513: this is now ALSO reachable as `rules.lifeCostMultiplier`. The
    // named field is kept deliberately -- lifeCost.js and its call sites read
    // it, and rewriting them is not this epic's business. The two are the same
    // value from the same source (`progression.rules`), so they cannot
    // disagree; do not add a second named field for any other rule.
    lifeCostMultiplier: ruleLifeCostMultiplier(progression),
    // SOMET-513. The whole rules aggregate, for the nine rules SOMET-512 adds.
    // See rulesOf's header for why this is one object rather than nine fields.
    rules: rulesOf(progression),
    // SOMET-495, carried the same way and for the same reason. Read by
    // world.js's weaponDamage (damageMult), by the mitigation rebuild in
    // world.js (resists) and by effects.js's applyHitStatuses at every player
    // hit site (hitStatuses). Nothing here derives a number from them.
    damageMult: damageMultOf(progression),
    resists: resistsOf(progression),
    hitStatuses: hitStatusesOf(progression),
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
