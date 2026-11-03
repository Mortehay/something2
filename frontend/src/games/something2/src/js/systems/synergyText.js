// Tooltip lines for a skill's synergies, built from synergyHints(). Pure.
import { synergyHints } from "../core/skillsData.js";

export const SYNERGY_MAX_LINES = 2;
const fmtMult = (m) => `x${Number(m).toFixed(2)}`;
const list = (tags) => (tags || []).join(" / ");

export function synergyLines(skill) {
  const h = synergyHints(skill);
  const lines = [];
  for (const p of h.primes.slice(0, SYNERGY_MAX_LINES)) lines.push(`Starts: ${p.name} (-> ${list(p.to)}, ${fmtMult(p.mult)})`);
  for (const f of h.finishes.slice(0, SYNERGY_MAX_LINES)) lines.push(`Finishes: ${f.name} (after ${list(f.from)}, ${fmtMult(f.mult)})`);
  return lines;
}
