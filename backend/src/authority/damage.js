// The SINGLE mitigation path for damage dealt to an equipped actor (players).
// Both the melee resolver (world.js) and the projectile resolver
// (projectiles.js) must call this — they must never compute damage
// independently, or the two paths drift.

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

module.exports = { applyDamage, MIN_DAMAGE, RESIST_CAP, ELEMENTS, NO_MITIGATION };
