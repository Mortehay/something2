import { skillDamagePreview } from "../core/skillsData.js";

const fmt = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));

// One tooltip line describing skill damage, or null for buffs / non-damaging skills.
export function damageLine(skill, weaponDamage = 0) {
  const p = skillDamagePreview(skill, weaponDamage);
  if (!p) return null;
  const pct = fmt(p.scaling * 100);
  const baseText = p.hits > 1 ? `${fmt(p.base)} x ${p.hits} hits` : fmt(p.base);
  if (!(p.weaponDamage > 0)) return `Damage ${baseText} (no weapon bonus)`;
  const totalText = p.hits > 1 ? `${fmt(p.total)} total` : fmt(p.total);
  return `Damage ${baseText} + ${pct}% weapon (${fmt(p.weaponDamage)}) = ${totalText}`;
}
