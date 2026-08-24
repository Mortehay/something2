// The Druid's charm rules (spec 8.2). PURE -- no database, no clock, no
// randomness -- matching charm's siblings (playerStats.js, lifeCost.js,
// statComposition.js).

// A creature costs its LEVEL against the budget, and the budget bounds the SUM
// of what is held rather than the count: "a level-40 druid can hold one
// level-20 creature or four level-5 ones" (spec 8.2). Halved charisma, floored,
// so an odd CHA never buys a fractional creature.
//
// `effectiveCharisma` is composeStats(...).charisma -- the COMPOSED total
// (class base + tree + gear), never the raw player_progression column. A budget
// computed off the raw snapshot would ignore every charisma point the tree
// grants, which is the "green tests over a dead feature" shape this epic has
// now shipped seven times.
//
// `treeCharmBonus` is composeStats(...).rules.treeCharmBonus (contract §2).
// The Druid's own start node grants +1 and ks_cha_pack_leader grants +3, and
// SOMET-472 made start-node grants actually reach composeStats -- so this
// argument is live data, not the placeholder literal the plan's §6.5 allowed
// before T6 landed. It still degrades to 0 rather than to NaN for a caller
// composing a class with no rules at all.
function charmBudget(effectiveCharisma, treeCharmBonus = 0) {
  const cha = Number(effectiveCharisma);
  const base = Number.isFinite(cha) && cha > 0 ? Math.floor(cha / 2) : 0;
  const bonus = Number(treeCharmBonus);
  return base + (Number.isFinite(bonus) ? Math.trunc(bonus) : 0);
}

// `activeSummonLevels` is the level of every summon the druid is ALREADY
// holding; `candidateLevel` is the one being added.
//
// The comparison is on the TOTAL, deliberately. A per-creature check ("is this
// one within budget?") would pass for every level-1 creature forever, and the
// budget's whole purpose is to stop an unbounded swarm -- the failure mode a
// count-based or per-item rule ships green.
function canSummon(activeSummonLevels, candidateLevel, budget) {
  const cand = Number(candidateLevel);
  if (!Number.isFinite(cand) || cand < 1) return { ok: false, reason: 'bad_level' };
  const levels = Array.isArray(activeSummonLevels) ? activeSummonLevels : [];
  let held = 0;
  for (const l of levels) {
    const n = Number(l);
    if (Number.isFinite(n) && n > 0) held += n;
  }
  const cap = Number(budget);
  if (!Number.isFinite(cap) || held + cand > cap) return { ok: false, reason: 'over_budget' };
  return { ok: true, reason: null };
}

// The PLAYER pacify (spec 8.2), and the window that follows it.
//
// PLAYER_CHARM_IMMUNITY_MS MUST exceed PLAYER_CHARM_MS. It is what guarantees
// the pacified player 4 seconds of freedom per charm no matter how many druids
// are aiming at them, and it is also what makes it safe to store the charm in
// effects.js's refresh-semantics Map at all: a second charm can never reach
// applyEffect while the first is still live. See applyCharm's comment in
// authority/effects.js, which spells out the shock-interrupt precedent this
// follows.
const PLAYER_CHARM_MS = 4000;
const PLAYER_CHARM_IMMUNITY_MS = 8000;

module.exports = { charmBudget, canSummon, PLAYER_CHARM_MS, PLAYER_CHARM_IMMUNITY_MS };
