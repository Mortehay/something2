import { skillDamagePreview } from "../core/skillsData.js";
import { t } from "../i18n/i18n.js";

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
  return abbr ? t("Scales with {attr}", { attr: t(abbr) }) : null;
}

// One tooltip line describing skill damage, or null for buffs / skills without numbers.
// A share of the damage scales with the weapon held (see skillDamagePreview); with
// nothing in hand that share is simply lost.
export function damageLine(skill, weaponDamage = 0) {
  const p = skillDamagePreview(skill, weaponDamage);
  if (!p) return null;
  const pct = fmt(p.scaling * 100);
  const baseText = p.hits > 1 ? t("{base} x {hits} hits", { base: fmt(p.base), hits: p.hits }) : fmt(p.base);
  if (!(p.weaponDamage > 0)) return t("Damage {base} (no weapon bonus)", { base: baseText });
  const shown = p.hits > 1 ? `${baseText} (${t("{total} total", { total: fmt(p.total) })})` : baseText;
  return t("Damage {base} ({pct}% scales with your weapon, {wd})", { base: shown, pct, wd: fmt(p.weaponDamage) });
}
