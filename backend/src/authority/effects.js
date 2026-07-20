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
const CHILL_MAGNITUDE = 0.3; // fractional move-speed reduction

const SHOCK_DURATION_MS = 2000;
const SHOCK_MAGNITUDE = 1;   // shock's effect is an interrupt, not a scalar

// Effect kinds that act on a fixed periodic interval rather than being read
// passively by whatever consumes them. Only BURN ticks today; CHILL/SHOCK
// are read via hasEffect()/effectMagnitude() by movement/cast-bar code.
const TICK_INTERVAL_MS = { [BURN]: BURN_TICK_MS };

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

module.exports = {
  applyEffect,
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
};
