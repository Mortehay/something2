// Tooltip lines for a skill's synergies, built from synergyHints(). Pure.
import { synergyHints } from "../core/skillsData.js";
import { t } from "../i18n/i18n.js";

export const SYNERGY_MAX_LINES = 2;
const fmtMult = (m) => `x${Number(m).toFixed(2)}`;
const list = (tags) => (tags || []).join(" / ");

export function synergyLines(skill) {
  const h = synergyHints(skill);
  const lines = [];
  for (const p of h.primes.slice(0, SYNERGY_MAX_LINES)) lines.push(t("Starts: {name} (-> {to}, {mult})", { name: t(p.name), to: list(p.to), mult: fmtMult(p.mult) }));
  for (const f of h.finishes.slice(0, SYNERGY_MAX_LINES)) lines.push(t("Finishes: {name} (after {from}, {mult})", { name: t(f.name), from: list(f.from), mult: fmtMult(f.mult) }));
  return lines;
}
