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
  const resist = Math.min(RESIST_CAP, (mit.resistances && mit.resistances[el]) || 0);
  const final = Math.max(MIN_DAMAGE, raw2 * (1 - resist));
  target.hp -= final;
  return final;
}

module.exports = { applyDamage, MIN_DAMAGE, RESIST_CAP, ELEMENTS, NO_MITIGATION };
