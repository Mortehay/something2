// The Cultist's resource substitution (spec 8.3, contract §2). PURE -- no
// database, no clock, no randomness -- for the same reason playerStats.js is:
// the caller owns the state, this module owns the arithmetic.
//
// SCOPE. This module decides HOW MUCH life a cast costs and WHETHER it can be
// paid. It deliberately does not decide WHO pays in life: that is one flag on
// the player object, resolved once at join, and read at the single cost gate in
// authority/world.js. Two gates is exactly what spec 8.3 forbids.

const LIFE_COST_RATIO = 0.6;

// Rounded UP, never down. A 1-mana spell rounding to 0 would make the whole
// cheap end of the catalog free for exactly one class, and free casting is not
// a discount, it is a different game.
//
// `lifeCostMultiplier` is contract §2's second argument: it is
// `composeStats(...).rules.lifeCostMultiplier`, i.e. the product of every
// passive-tree rule grant the character holds. The Cultist's tree START node
// already grants 0.9 (SOMET-471 / contract §6.11), and the CON keystones
// "Blood Pact" (0.75) and "Sanguine Rite" (0.8) lower it further.
//
// Anything non-finite or non-positive resolves to 1: a NULL arriving from a
// character whose tree row is missing must mean "no discount", never "no cost".
function lifeCostFor(manaCost, lifeCostMultiplier = 1) {
  const cost = Number(manaCost);
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  const raw = Number(lifeCostMultiplier);
  const mult = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return Math.ceil(cost * LIFE_COST_RATIO * mult);
}

// A cast that would leave the cultist below 1 HP is REFUSED, not lethal
// (spec 8.3).
//
// The bound is `>= 1`, not `> 0`, and that is not a rounding preference: hp is
// a float on the live path (resistances, shock's +25% vulnerability and AoE
// falloff all produce fractions), so `> 0` would happily leave a caster on
// 0.4 hp -- alive by the comparison, dead to the next burn tick, and killed by
// their own spell either way.
//
// A non-finite input refuses. A NaN hp pool means something upstream is already
// broken, and casting into that state would turn a visible bug into a dead
// character.
function canPayLife(currentHp, cost) {
  const hp = Number(currentHp);
  const c = Number(cost);
  if (!Number.isFinite(hp) || !Number.isFinite(c)) return false;
  return hp - c >= 1;
}

module.exports = { LIFE_COST_RATIO, lifeCostFor, canPayLife };
