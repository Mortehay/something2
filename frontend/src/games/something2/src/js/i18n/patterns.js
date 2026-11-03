// Fallback translation for server names that are built from templates at runtime and are
// not (or cannot be) listed one by one in uk/content.js. Returns the Ukrainian text, or
// null when no pattern matches. Not wired into t(): i18n.js can call it on a dictionary miss:
//
//   const hit = ...dictionary lookup...;  if (hit === en) { const p = translatePattern(en); if (p) return fill(p, params); }
import { UK } from "./uk/index.js";

const own = (k) => Object.prototype.hasOwnProperty.call(UK, k);
const look = (k) => (own(k) && typeof UK[k] === "string" ? UK[k] : null);

const STAT_ABBR_UK = { STR: "СИЛ", DEX: "СПР", CON: "СТА", INT: "ІНТ", WIS: "МУД", CHA: "ХАР" };

export function translatePattern(en) {
  if (typeof en !== "string" || !en) return null;
  let m;
  // "Sinew (STR)" -- passive label with the stat it grants.
  if ((m = /^(.+) \((STR|DEX|CON|INT|WIS|CHA)\)$/.exec(en))) {
    const base = look(m[1]);
    if (base) return `${base} (${STAT_ABBR_UK[m[2]]})`;
  }
  // "Spire of Trials: Floor 12"
  if ((m = /^Spire of Trials: Floor (\d+)$/.exec(en))) return `Шпиль Випробувань: поверх ${m[1]}`;
  // "<Dungeon>: <Room>" -- translate both halves.
  if ((m = /^(.+?): (.+)$/.exec(en))) {
    const a = look(m[1]);
    const b = look(m[2]);
    if (a && b) return `${a}: ${b}`;
  }
  // "<Place> Waypoint"
  if ((m = /^(.+) Waypoint$/.exec(en))) {
    const place = look(m[1]);
    if (place) return `Шляхова точка: ${place}`;
  }
  // "<Biome> Reach" / "<Biome> Frontier"
  if ((m = /^(.+) (Reach|Frontier)$/.exec(en))) {
    const biome = look(m[1]);
    if (biome) return `${biome} (${m[2] === "Reach" ? "окраїна" : "рубіж"})`;
  }
  // "Beast Brute" etc.: "<Line> <Rung>" -> lower-cased rung after the line adjective.
  if ((m = /^(\w+) (Swarm|Skirmisher|Line|Ranged|Caster|Brute|Heavy|Champion|Apex)$/.exec(en))) {
    const line = look(`${m[1]} Swarm`);
    const rung = look(m[2]);
    if (line && rung) return `${line.split(" ")[0]} ${rung.toLowerCase()}`;
  }
  // "<tier>-<family>" gear ladder not in the dictionary: nothing safe to guess.
  return null;
}
