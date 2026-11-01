import { skillDamagePreview } from "../core/skillsData.js";

const fmt = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));

const ATTRIBUTE_ABBR = {
  strength: "STR", dexterity: "DEX", constitution: "CON",
  intelligence: "INT", wisdom: "WIS", charisma: "CHA",
};

// "Scales with STR" for a damaging skill whose attribute is known, else null.
// Every skill names the attribute its damage grows with (5% per point above base,
// plus whatever the passive tree adds for that attribute), so a player can see
// which stat -- and which passive sector -- makes THIS skill hit harder.
export function scalesWithLine(skill) {
  if (!skill || skill.type === "buff") return null;
  const abbr = ATTRIBUTE_ABBR[skill.attribute];
  return abbr ? `Scales with ${abbr}` : null;
}

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
