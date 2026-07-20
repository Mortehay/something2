// Transient status-effect module. `now` is always passed in by the caller
// (the world tick) and never read internally — same convention as loot.js —
// so this module is pure, deterministic under test, and cannot drift out of
// sync with the tick clock.
//
// One entry per (target, effectKey): re-applying an effect REFRESHES its
// expiry/magnitude/source rather than adding a new entry. This bounds
// target.effects by the number of distinct effect KINDS (currently 3), not
// by how often a weapon can trigger one — a fast-firing weapon re-applying
// BURN every 100ms must still leave exactly one entry, not one per hit. (A
// prior slice needed MAX_DROP_QTY to cap exactly this class of unbounded-
// growth bug; this module avoids it by construction via Map keying instead
// of a clamp.)
//
// BURN deals damage on a fixed interval (BURN_TICK_MS), accumulated per
// entry across calls to tickEffects, regardless of how often tickEffects is
// called or how large a single dt is. If burn instead fired once per
// tickEffects() call, its DPS would silently scale with the server's tick
// rate (e.g. 20Hz -> 30Hz would make every fire weapon 50% stronger with no
// test noticing).
//
// NOTE for a later task (shock interrupt, T7): that feature needs a
// per-target immunity window stamped once and deliberately NOT refreshed —
// the one exception to the refresh rule above. It does not live here yet,
// but nothing in this module's shape (Map keyed by effectKey, entries with
// their own `until`) prevents adding a second, non-refreshing Map for it.

const BURN = 'burn';
const CHILL = 'chill';
const SHOCK = 'shock';

const BURN_DURATION_MS = 4000;
const BURN_MAGNITUDE = 2;    // damage dealt per burn tick (pre-mitigation)
const BURN_TICK_MS = 1000;   // fixed interval between burn damage ticks

const CHILL_DURATION_MS = 3000;
// This is a MULTIPLIER on the entity's base move speed, consumed by world.js's
// stepEffects as `speed = baseSpeed * magnitude` while chilled — it is NOT the
// fraction subtracted. 0.6 means a chilled entity moves at 60% of base speed,
// i.e. a 40% slow (per the elements design spec's "movement speed × 0.6").
// Do not read this as "0.6 = a 60% slow": that reduction/multiplier mixup is
// exactly how this constant previously shipped at 0.3 (a 70% slow) while
// every doc and design intent said 40%.
const CHILL_MAGNITUDE = 0.6;

const SHOCK_DURATION_MS = 2000;
// Shock carries THREE riders (the design's deliberate concentration of power
// into lightning, paid for by the storm staff's damage-per-mana). Only ONE of
// them fits in the entry's single `magnitude` field, so the split is:
//
//   magnitude          -> the damage-vulnerability FRACTION (0.25 = +25% taken).
//                         Read passively by damage.js's applyDamageWithEffects.
//   SHOCK_MANA_DRAIN   -> a periodic drain, fired by tickEffects like burn's DOT.
//   the interrupt      -> T7; gated by its own non-refreshing immunity window.
//
// This is a fraction ADDED to 1, not a multiplier like CHILL_MAGNITUDE. The two
// constants read alike and mean different things; see applyDamageWithEffects.
const SHOCK_MAGNITUDE = 0.25;
// Mana removed per shock tick. Half the player's 10/s regen (world.js's
// PLAYER_MANA_REGEN), so sustained lightning halves a caster's effective regen
// rather than emptying the pool outright — mana becomes contested, not deleted.
const SHOCK_MANA_DRAIN = 5;
const SHOCK_TICK_MS = 1000;  // fixed interval between mana-drain ticks

// Effect kinds that act on a fixed periodic interval rather than being read
// passively by whatever consumes them. BURN deals damage; SHOCK drains mana.
// CHILL is purely passive, read via effectMagnitude() by movement code.
//
// Both intervals are FIXED here rather than derived from the tick rate, for the
// same reason burn's is: an action fired once per tickEffects() call would make
// its throughput scale with the server's tick rate, so a 20Hz -> 30Hz change
// would silently strengthen every fire and lightning weapon by 50%.
const TICK_INTERVAL_MS = { [BURN]: BURN_TICK_MS, [SHOCK]: SHOCK_TICK_MS };

// Refreshes (never stacks) the (target, key) effect entry. `existing.elapsed`
// is preserved across a refresh so re-applying BURN mid-interval neither
// resets the DOT cadence nor lets spamming the same weapon produce extra
// ticks.
function applyEffect(target, key, { durationMs, magnitude, sourceId, now }) {
  if (!target.effects) target.effects = new Map();
  const existing = target.effects.get(key);
  target.effects.set(key, {
    magnitude,
    sourceId,
    until: now + durationMs,
    elapsed: existing ? existing.elapsed : 0,
  });
}

// Allocation-free: no array/object created on the hot read path used by the
// tick loop.
function hasEffect(target, key, now) {
  const e = target.effects && target.effects.get(key);
  return !!e && e.until > now;
}

function effectMagnitude(target, key, now) {
  const e = target.effects && target.effects.get(key);
  return e && e.until > now ? e.magnitude : 0;
}

// Advances every live effect on `target` by dtMs, evicts anything whose
// expiry has passed `now`, and fires periodic actions (currently only
// BURN's damage tick) whose accumulated elapsed time has crossed their
// fixed interval — possibly more than once if dtMs spans multiple
// intervals. Returns the list of fired actions; does not apply damage
// itself (route that through damage.js's applyDamage so mitigation is
// still respected). `ctx` is threaded through unused for now so a later
// task can pass world/mitigation lookups without changing this signature.
function tickEffects(target, dtMs, now, ctx) {
  const fired = [];
  if (!target.effects || target.effects.size === 0) return fired;

  for (const [key, e] of target.effects) {
    if (e.until <= now) {
      target.effects.delete(key);
      continue;
    }
    const interval = TICK_INTERVAL_MS[key];
    if (!interval) continue;
    e.elapsed += dtMs;
    while (e.elapsed >= interval) {
      e.elapsed -= interval;
      fired.push({ target, key, magnitude: e.magnitude, sourceId: e.sourceId, now });
    }
  }
  return fired;
}

// element -> the status rider it carries.
//
// `arcane` is DELIBERATELY absent, and so is `physical`. Arcane is the
// pure-damage generalist; carrying no rider is the counterweight to its
// straight-line damage profile. Its absence here is the design, not an
// oversight — do not "fix" it by adding an entry.
const ELEMENT_EFFECTS = {
  fire: { key: BURN, durationMs: BURN_DURATION_MS, magnitude: BURN_MAGNITUDE },
  ice: { key: CHILL, durationMs: CHILL_DURATION_MS, magnitude: CHILL_MAGNITUDE },
  lightning: { key: SHOCK, durationMs: SHOCK_DURATION_MS, magnitude: SHOCK_MAGNITUDE },
};

// Applies `element`'s rider to `target`, if it has one. ONE mapping, called
// from every path that already deals elemental damage — the melee arc (against
// creatures and players), the projectile direct hit, and the AoE detonation —
// so no damage path can pick its own rider table and no element can end up
// riderless in one path but not another. A rider wired only into the direct
// hit would leave AoE staves riderless, which is most of what a staff does.
//
// Duration is NEVER scaled by the caller's damage falloff: a target clipped by
// the edge of a blast still burns for the full time. A duration scaled toward
// zero at the blast edge would tick zero times — an inert mechanic wearing a
// working one's clothes.
//
// Deliberately NOT called from inside applyDamage, tempting as that is: burn's
// own damage tick routes through applyDamage with element 'fire', so a rider
// there would re-apply and refresh burn from its own tick, forever.
function applyElementEffect(target, element, now, sourceId) {
  const spec = ELEMENT_EFFECTS[element];
  if (!spec) return null;
  applyEffect(target, spec.key, {
    durationMs: spec.durationMs, magnitude: spec.magnitude, sourceId, now,
  });
  return spec.key;
}

module.exports = {
  applyEffect,
  applyElementEffect,
  ELEMENT_EFFECTS,
  tickEffects,
  hasEffect,
  effectMagnitude,
  BURN,
  CHILL,
  SHOCK,
  BURN_DURATION_MS,
  BURN_MAGNITUDE,
  BURN_TICK_MS,
  CHILL_DURATION_MS,
  CHILL_MAGNITUDE,
  SHOCK_DURATION_MS,
  SHOCK_MAGNITUDE,
  SHOCK_MANA_DRAIN,
  SHOCK_TICK_MS,
};
