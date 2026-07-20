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
// THE ONE EXCEPTION TO THE REFRESH RULE ABOVE: shock's interrupt.
//
// "Refreshes rather than stacks" is the right rule for a DOT and a slow, but it
// has a consequence that only bites for effects which remove player control:
// under sustained fire, a REFRESHED effect is a PERMANENT effect. A storm staff
// on a 1.10s cooldown re-applying a 2s shock every shot would hold a player
// interrupted forever, and every test in this file would stay green while it
// happened — refresh semantics would be working exactly as specified.
//
// So the interrupt does NOT live in the effects Map. It is gated by a separate
// per-target immunity window that is stamped ONCE when an interrupt lands and
// is deliberately NOT refreshed by later hits: it runs to completion, and only
// then may the next shock interrupt again. See applyShockInterrupt.
//
// If you are reading this because the non-refreshing branch looks like a bug:
// it is not. It is the entire point, and `shock cannot chain-lock` in
// authority_effects.test.js fails if you "fix" it.

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

// How long a landed interrupt takes the target's actions away. Short by design:
// the design spec calls it "a ~0.4s interrupt", and it is meant to read as a
// stagger rather than a stun.
const SHOCK_INTERRUPT_MS = 400;
// How long after a landed interrupt the target cannot be interrupted again.
//
// This MUST exceed the fastest lightning weapon's cooldown (the storm staff's
// 1100ms — lightning is exactly one weapon) or the exception is decorative:
// every shot would land while the window had already lapsed, re-interrupting
// forever, which is precisely the chain-lock the window exists to prevent.
// `the immunity window exceeds the fastest lightning weapon cooldown` in
// authority_effects.test.js ties this constant to the real catalog value so a
// future rebalance of the storm staff cannot silently break it.
//
// At 3000ms against a 400ms interrupt, a target under perfectly sustained
// lightning keeps control ~87% of the time.
const SHOCK_IMMUNITY_MS = 3000;

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
    const expired = e.until <= now;
    const interval = TICK_INTERVAL_MS[key];
    if (interval) {
      // ADVANCE BEFORE EVICTING. An effect whose lifetime is an exact multiple
      // of its interval (burn: 4000ms / 1000ms) crosses its FINAL interval on
      // the very tick where `now` reaches `until`. Deleting on expiry before
      // touching the accumulator therefore drops that last tick at every tick
      // rate: burn shipped 3 ticks / 6 damage against a designed 4 / 8, and
      // shock's drain shipped 1 tick / 5 mana against a designed 2 / 10.
      //
      // Only the portion of dt during which the effect was actually ALIVE is
      // accumulated: the tick covers (now - dtMs, now], and the effect is alive
      // up to `until`. Clamping the tail is what stops a huge dt arriving long
      // after expiry from banking ticks for time the effect was already over
      // (see `an expired SHOCK is evicted without firing a drain tick`), while
      // still crediting the sliver of dt that lands exactly on the boundary.
      //
      // The live-path branch uses dtMs UNCHANGED rather than the algebraically
      // identical `Math.min(now, e.until) - (now - dtMs)`: at a tick rate whose
      // dt is not exact in binary (30Hz -> 33.333…ms) that round-trip loses a
      // few ulps every tick, and the accumulated drift is enough to lose a tick
      // over a 2s window — which is exactly the tick-rate independence this
      // module exists to guarantee.
      const liveDtMs = expired ? dtMs - (now - e.until) : dtMs;
      if (liveDtMs > 0) {
        e.elapsed += liveDtMs;
        while (e.elapsed >= interval) {
          e.elapsed -= interval;
          fired.push({ target, key, magnitude: e.magnitude, sourceId: e.sourceId, now });
        }
      }
    }
    if (expired) target.effects.delete(key);
  }
  return fired;
}

// The live effect KEYS on `target`, for broadcast to the client.
//
// KEYS ONLY, deliberately. The client needs to know WHAT is active so it can
// tint the entity and list it on the HUD; it has no use for `until`, `elapsed`,
// `magnitude` or `sourceId`, and shipping those would (a) put the server's
// timing internals on the wire, where a client could read exactly when a slow
// expires, and (b) grow the 20Hz state frame by an object per effect per actor.
//
// Expired-but-not-yet-evicted entries are filtered out here rather than trusted
// to have been swept: tickEffects only evicts entries it walks, and an entity
// that has not been ticked since its effect lapsed would otherwise broadcast a
// tint that the server no longer applies to anything.
//
// Returns null (not []) when nothing is active, so callers can omit the field
// from the frame entirely — the overwhelmingly common case is an actor with no
// effects at all, and an `"effects":[]` on every player on every tick is pure
// waste. Every consumer must therefore read it as `p.effects || []`.
function activeEffectKeys(target, now) {
  if (!target || !target.effects || target.effects.size === 0) return null;
  let keys = null;
  for (const [key, e] of target.effects) {
    if (e.until <= now) continue;
    (keys || (keys = [])).push(key);
  }
  return keys;
}

// Attempts to interrupt `target`. Returns true if the interrupt LANDED, false
// if the target was still inside its immunity window.
//
// Both windows live in plain numeric fields rather than the effects Map,
// because they are governed by the opposite rule to everything in that Map:
//
//   _interruptedUntil  — when the target regains control.
//   _shockImmuneUntil  — when the target may be interrupted again.
//
// THE NON-REFRESH IS DELIBERATE. A hit arriving inside the immunity window
// returns early and stamps NOTHING — it does not extend the interrupt, and it
// does not push the immunity window forward either. The window runs to
// completion from the moment the interrupt landed, so the target is guaranteed
// (SHOCK_IMMUNITY_MS - SHOCK_INTERRUPT_MS) of control per interrupt no matter
// how fast it is being shot. Re-stamping either field here — the natural
// "refresh like everything else" edit — restores the chain-lock.
//
// `now` is passed in, never read from a clock, like every other function here.
function applyShockInterrupt(target, now) {
  if (target._shockImmuneUntil > now) return false; // undefined > now is false
  target._interruptedUntil = now + SHOCK_INTERRUPT_MS;
  target._shockImmuneUntil = now + SHOCK_IMMUNITY_MS;
  return true;
}

// True when `target` is free to act. Allocation-free, and safe on a target that
// has never been interrupted (`undefined > now` is false).
function canAct(target, now) {
  return !(target._interruptedUntil > now);
}

// Clears an in-progress interrupt WITHOUT clearing the immunity window.
// Used on respawn: a player who just died must not get up still staggered.
// The immunity deliberately survives, so respawning cannot be used to shed the
// window and eat a fresh interrupt immediately — that would make death a way to
// be chain-locked at the spawn point.
function clearInterrupt(target) {
  target._interruptedUntil = 0;
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
  // The interrupt attempt rides along HERE, in the one element->rider mapping,
  // for the same reason the rider table itself does: every path that deals
  // elemental damage already calls this, so no damage path can be riderless.
  // Wiring it into the projectile direct hit alone would leave the storm
  // staff's own AoE detonation — most of what it actually does — unable to
  // interrupt. applyShockInterrupt itself decides whether it lands.
  if (spec.key === SHOCK) applyShockInterrupt(target, now);
  return spec.key;
}

module.exports = {
  applyEffect,
  applyElementEffect,
  ELEMENT_EFFECTS,
  tickEffects,
  hasEffect,
  effectMagnitude,
  activeEffectKeys,
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
  applyShockInterrupt,
  canAct,
  clearInterrupt,
  SHOCK_INTERRUPT_MS,
  SHOCK_IMMUNITY_MS,
};
