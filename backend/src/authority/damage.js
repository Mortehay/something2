// The SINGLE mitigation path for damage dealt to an equipped actor (players).
// Both the melee resolver (world.js) and the projectile resolver
// (projectiles.js) must call this — they must never compute damage
// independently, or the two paths drift.

const { effectMagnitude, SHOCK } = require('./effects');

const MIN_DAMAGE = 1;    // damage floor: nothing is ever fully negated
const RESIST_CAP = 0.8;  // resistance ceiling: nothing is ever immune
const ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const NO_MITIGATION = { defense: 0, resistances: {} };

// SOMET-290 — how long a creature remembers who hit it, in MILLISECONDS
// (world.js's `this.now` is a millisecond clock; every `until`/`_interruptedUntil`
// style field in this authority is stamped against it).
//
// This number replaces the previous "clear provocation on any tick with no
// target" rule, which was coupled to target state and could therefore only be
// too sticky or too eager: as a plain boolean it first leaked permanently (one
// arrow made a deer a charger for the world's uptime), and the fix for that
// made it evaporate on the very next tick whenever the shooter was outside
// aggro range — which is every ranged weapon in the catalog (darts 350 …
// arbalest 850) against a 300px skittish aggro radius.
//
// 10s is long enough for a creature to cross its own leash toward whoever shot
// it (a skittish creature covers ~460px in that time) and short enough that a
// player who leaves and comes back later meets prey again rather than a
// grudge. Every fresh hit re-arms it, so a real fight never expires mid-fight.
const PROVOKE_MEMORY_MS = 10000;

// Actor tags, in the SAME `p:<userId>` / `c:<id>` form the frame descriptors
// and projectiles.js's `hitIds` already use. A tag rather than a bare id
// because both players and creatures deal damage and a creature id is a uuid
// while a userId is an integer — comparing them untagged would be a type
// coincidence away from a creature retaliating against the wrong actor.
//
// A null id yields null, i.e. "unattributed", which isProvokedBy below matches
// against NOBODY. See the note there for why that is the safe direction now
// that provocation grants acquisition reach rather than only a movement band.
function playerKey(userId) { return userId == null ? null : `p:${userId}`; }
function creatureKey(id) { return id == null ? null : `c:${id}`; }

// Is `target` currently retaliating against the actor tagged `key`?
//
// THE read side of provocation — creatures.js's skittish branch and its
// target-acquisition both go through this rather than touching `_provokedBy`,
// so the field's shape is owned by one module.
//
//  - no record, or an expired one -> false. `!(until > now)` rather than
//    `until <= now` so a NaN `until` (a caller that passed a garbage clock)
//    reads as calm rather than as angry forever.
//  - a record with a null `by` (damage from an unattributed source: a burn
//    whose applier is gone, a hand-rolled test hit) matches NOBODY, and a null
//    `key` (asking about "no actor") is never a match either.
//
// That last rule is the SOMET-290 follow-up (finding 2) and it reversed. While
// provocation only re-banded a skittish creature's MOVEMENT, "an unattributed
// hit provokes against everyone" was the mild direction: the worst case was a
// deer that stopped running. It stopped being mild once provocation also
// granted acquisition out to the leash radius — an unnamed source would make a
// creature acquire and chase an innocent player standing well outside its aggro
// radius, blamed for a hit nobody landed. Between "a creature that does not
// answer a hit nobody can be blamed for" and "a creature that attacks a
// bystander", the first is the one a player can make sense of.
//
// Both `damageCreatureById` and `applyDamage` still DEFAULT `source` to null,
// so this is also what keeps the next unthreaded caller from silently shipping
// bystander aggression: it ships a creature that ignores that one damage
// source, which is visible and boring, instead of one that hunts strangers.
function isProvokedBy(target, key, now) {
  const p = target && target._provokedBy;
  if (!p) return false;
  if (!(p.until > now)) return false;
  return p.by != null && p.by === key;
}

// THE write side, so `_provokedBy`'s shape has exactly one author. Two callers:
// applyDamage below (any landed hit) and creatures.js's cornered rule (a
// retreat the terrain refused, which is provocation without damage).
//
// The most recent provoker wins — an engagement is with whoever is hitting you
// now — and each hit re-arms the memory, so a real fight never expires
// mid-fight.
function provoke(target, source, now) {
  target._provokedBy = {
    by: source ?? null,
    // A caller with no clock (a direct unit-test hit) gets an expiry that never
    // arrives, which is the pre-expiry behaviour rather than a creature that is
    // instantly calm again.
    until: Number.isFinite(now) ? now + PROVOKE_MEMORY_MS : Infinity,
  };
}

// Reduce `raw` by the target's mitigation, apply it to target.hp, return the
// amount actually dealt. `element` defaults to 'physical'; an element with no
// matching resistance takes full (post-defense) damage.
//
// `now` is the world clock and `source` the attacker's tag (playerKey/
// creatureKey above) — both only feed the provocation stamp below, so a caller
// that deals damage nobody can be blamed for may omit them. Omitting `source`
// records a provocation that matches no actor, i.e. nobody is retaliated
// against; see isProvokedBy for why that is the direction an unthreaded caller
// should fail in.
function applyDamage(target, raw, element, mit = NO_MITIGATION, now = undefined, source = null) {
  const el = ELEMENTS.includes(element) ? element : 'physical';
  const defense = mit.defense || 0;
  const raw2 = raw - defense;
  // Defence in depth: the API validator rejects a non-finite/out-of-range
  // resistance at write time, but clamp again here so a value that reaches
  // this path some other way (a stale row from before the validator existed,
  // a future write path that forgets to validate) can't turn into NaN
  // damage. NaN would flow through raw2 * (1 - resist) -> Math.max(1, NaN)
  // -> NaN, which never satisfies hp <= 0, making the target permanently
  // immortal.
  const rawResist = (mit.resistances && mit.resistances[el]) || 0;
  const resist = Number.isFinite(rawResist) ? Math.min(RESIST_CAP, Math.max(0, rawResist)) : 0;
  const candidate = raw2 * (1 - resist);
  const final = Math.max(MIN_DAMAGE, Number.isFinite(candidate) ? candidate : MIN_DAMAGE);
  target.hp -= final;
  // SOMET-290. Being hit is what turns a skittish creature from prey into a
  // fighter, and this is the ONE place a hit lands: the melee arc (world.js),
  // a direct projectile, an AoE detonation (projectiles.js) and the burn tick
  // all funnel through here. Stamping it at those call sites instead would be
  // the same rule-on-one-of-several-write-paths failure that shipped SOMET-153.
  //
  // Set unconditionally rather than only when `final > 0`: a hit absorbed to
  // nothing is still an attack, and a creature that shrugs off being struck
  // reads as broken. Harmless on players and on every other chase style —
  // nothing but isProvokedBy above reads it.
  //
  // WHO and UNTIL WHEN, not a bare boolean. The boolean could not express the
  // one thing the rule is about — a shot from beyond aggro range, which is how
  // a deer is normally hit — without also blaming a bystander who happened to
  // be standing nearby when it landed.
  provoke(target, source, now);
  return final;
}

// Shock's damage-vulnerability rider, layered IN FRONT of applyDamage rather
// than inside it.
//
// Two properties depend on that placement, and both are load-bearing:
//
//  1. Vulnerability scales the RAW damage, so mitigation still applies on top
//     (+25% then -50% resistance, not the other way round). Applying it AFTER
//     mitigation would let a shocked target's resistance be partly bypassed —
//     a resisted element would gain damage the resistance never sees. The
//     resistance-interaction test in authority_damage.test.js pins the order.
//  2. applyDamage keeps exactly ONE responsibility (reduction) and stays the
//     single reduction path. Folding an amplifier into it would give the
//     function two jobs and make "the one mitigation path" a half-truth.
//
// `now` is the world clock, threaded from the caller exactly like every other
// effect read — this module reads no clock of its own. A caller that omits it
// gets no vulnerability rather than a wrong one (`until > undefined` is false),
// so every damage site passes it explicitly; see the call sites in world.js,
// creatures.js and projectiles.js.
function shockVulnerability(target, now) {
  return effectMagnitude(target, SHOCK, now) || 0;
}

function applyDamageWithEffects(target, raw, element, mit = NO_MITIGATION, now, source = null) {
  return applyDamage(target, raw * (1 + shockVulnerability(target, now)), element, mit, now, source);
}

// Removes up to `amount` mana, clamped at 0, and returns how much was actually
// drained.
//
// A target with NO mana pool (every creature — mana is a player-only resource)
// is a no-op: this must not throw, and must not CREATE a `mana` property on
// something that never had one. A created-then-clamped `mana: 0` would leak
// into the creature snapshot and make every creature look like an
// out-of-mana caster to any consumer that duck-types on the field.
function drainMana(target, amount) {
  if (!target || typeof target.mana !== 'number' || !Number.isFinite(target.mana)) return 0;
  const before = target.mana;
  target.mana = Math.max(0, before - amount);
  return before - target.mana;
}

module.exports = {
  applyDamage, applyDamageWithEffects, drainMana,
  MIN_DAMAGE, RESIST_CAP, ELEMENTS, NO_MITIGATION,
  // SOMET-290: the provocation vocabulary lives with the funnel that stamps
  // it, so the shape of `_provokedBy` has exactly one owner. creatures.js
  // imports the reader; every damage site builds its tag with the two key
  // helpers rather than formatting one by hand.
  isProvokedBy, provoke, playerKey, creatureKey, PROVOKE_MEMORY_MS,
};
