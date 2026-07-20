// The SINGLE mitigation path for damage dealt to an equipped actor (players).
// Both the melee resolver (world.js) and the projectile resolver
// (projectiles.js) must call this — they must never compute damage
// independently, or the two paths drift.

const { effectMagnitude, SHOCK } = require('./effects');

const MIN_DAMAGE = 1;    // damage floor: nothing is ever fully negated
const RESIST_CAP = 0.8;  // resistance ceiling: nothing is ever immune
const ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const NO_MITIGATION = { defense: 0, resistances: {} };

// Reduce `raw` by the target's mitigation, apply it to target.hp, return the
// amount actually dealt. `element` defaults to 'physical'; an element with no
// matching resistance takes full (post-defense) damage.
function applyDamage(target, raw, element, mit = NO_MITIGATION) {
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

function applyDamageWithEffects(target, raw, element, mit = NO_MITIGATION, now) {
  return applyDamage(target, raw * (1 + shockVulnerability(target, now)), element, mit);
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
};
