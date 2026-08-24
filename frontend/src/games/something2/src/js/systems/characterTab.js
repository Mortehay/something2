// Character tab: PURE formatting for the inventory panel's fifth tab
// (SOMET-483, spec §10.2). Same split inventoryPanel.js already uses -- this
// module computes strings and rects and never touches a canvas, which is what
// makes every line below a unit test rather than a screenshot.
//
// F2 RULE (inherited from the deleted CharacterSheet.jsx's header, kept alive
// by the source-text guard in this module's test file): NOTHING here
// re-implements a backend formula. xpFloor, xpToNext, respecCost and the
// six-stat breakdown all arrive as data from the server --
// composeStats().sources for the breakdown, GET /api/progression (or the
// websocket frame) for the curve numbers. The one arithmetic this module does
// perform is summing the server's OWN three parts (base + tree + gear) for the
// headline total, precisely so the total and its breakdown cannot disagree.

export const CHAR_STAT_KEYS = [
  "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma",
];

export const STAT_ABBR = {
  strength: "STR", dexterity: "DEX", constitution: "CON",
  intelligence: "INT", wisdom: "WIS", charisma: "CHA",
};

const DASH = "—";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Integers print bare; a fraction keeps up to 2dp with no trailing zeros, so
// a mana regen of 12.50 reads "12.5" and one of 10 reads "10".
function trimNumber(n) {
  if (!Number.isFinite(n)) return DASH;
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

function mult(n) {
  return Number.isFinite(n) ? `x${n.toFixed(2)}` : DASH;
}

export function statTotal(entry) {
  if (!entry || typeof entry !== "object") return null;
  return num(entry.base) + num(entry.tree) + num(entry.gear);
}

export function formatStatBreakdown(statKey, entry) {
  const abbr = STAT_ABBR[statKey] || String(statKey || "?").slice(0, 3).toUpperCase();
  const total = statTotal(entry);
  if (total === null) return `${abbr} ${DASH}`;
  // The base part is always shown, even at 0, because "where did this number
  // come from" is the whole point of the line. A zero tree/gear part is noise.
  const parts = [`${num(entry.base)} base`];
  if (num(entry.tree) !== 0) parts.push(`${num(entry.tree)} tree`);
  if (num(entry.gear) !== 0) parts.push(`${num(entry.gear)} gear`);
  return `${abbr} ${total} = ${parts.join(" + ")}`;
}

// Highest and lowest effective stat. Ties break toward the class main stat, as
// spec §10.2 states for both ends. When every stat is equal there is no lowest
// one -- returning the same key for both would read as a bug, so weak is null
// and the caller renders a dash.
export function strongAndWeak(sources, mainStat) {
  if (!sources) return { strong: null, weak: null };
  const totals = CHAR_STAT_KEYS
    .map((k) => ({ key: k, total: statTotal(sources[k]) }))
    .filter((e) => e.total !== null);
  if (totals.length === 0) return { strong: null, weak: null };

  const max = Math.max(...totals.map((e) => e.total));
  const min = Math.min(...totals.map((e) => e.total));
  const pick = (value) => {
    const tied = totals.filter((e) => e.total === value).map((e) => e.key);
    return tied.includes(mainStat) ? mainStat : tied[0];
  };
  return { strong: pick(max), weak: max === min ? null : pick(min) };
}

function labelled(sources, key) {
  if (!key) return DASH;
  return `${STAT_ABBR[key]} ${statTotal(sources[key])}`;
}

export function formatHighlights(sources, mainStat) {
  const { strong, weak } = strongAndWeak(sources, mainStat);
  return `Strong: ${labelled(sources, strong)}    Weak: ${labelled(sources, weak)}`;
}

export function formatHeader(character) {
  const className = (character && character.className) || null;
  const level = character && character.level != null ? character.level : DASH;
  return `${className || "Unknown class"} — Level ${level}`;
}

// Eight rows, not seven: SOMET-495 made maxStamina a derived number like the
// other two pools (playerStats.js), and the HUD already draws a stamina bar --
// omitting it here would be the one pool the sheet cannot explain.
const DERIVED_FIELDS = [
  ["Max HP", "maxHp", trimNumber],
  ["Max mana", "maxMana", trimNumber],
  ["Max stamina", "maxStamina", trimNumber],
  ["Melee", "meleeMult", mult],
  ["Spell", "spellMult", mult],
  ["Cooldown", "cooldownMult", mult],
  ["Mana regen", "manaRegen", trimNumber],
  ["Sell price", "priceMult", mult],
];

export function derivedRows(stats) {
  return DERIVED_FIELDS.map(([label, key, fmt]) => {
    const raw = stats ? Number(stats[key]) : NaN;
    return `${label.padEnd(14)}${Number.isFinite(raw) ? fmt(raw) : DASH}`;
  });
}

// --- Modifier captions -----------------------------------------------------
// `detail` is NOT a unit suffix. statComposition.js#detailOf sets it to the
// NOUN the grant acts on -- the stat key for `stat`, the pool for `resource`,
// the element for `damage`/`resist`, the status for `status`, the rule name for
// `rule`. The unit belongs to the KIND, and getting that pairing wrong is the
// difference between "+35% fire damage" and "+35 fire":
//
//   stat      flat points on one of the six stats
//   resource  FLAT points on a pool ("+150 maximum life" is 150 hit points)
//   damage    a PERCENT, additive between grants (statComposition.js's PERCENT)
//   resist    PERCENTAGE POINTS, and a NEGATIVE value is a deliberate keystone
//             drawback -- it renders with its minus sign, never as an absolute
//   status    presence only; `value` is the authored 1 and means nothing
//   rule      the label is authored as prose that already states the effect
//
// A node's `label` is the NODE's label and is repeated across every grant it
// carries (a "Vigour" node grants +2 to a stat AND +8 hp, and both modifiers
// are labelled "Vigour"), so dropping the detail here would render two
// indistinguishable rows.
const POOL_NOUN = { hp: "max hp", mana: "max mana", stamina: "max stamina" };
const STATUS_PHRASE = { burn: "your hits burn", chill: "your hits chill", shock: "your hits shock" };

function signed(raw) {
  return `${raw < 0 ? "-" : "+"}${trimNumber(Math.abs(raw))}`;
}

export function formatModifier(mod) {
  const label = String((mod && mod.label) || "unknown");
  const kind = mod && mod.kind;
  const detail = mod && mod.detail != null ? String(mod.detail) : "";

  // A rule keystone's label is authored as a full sentence ("Clarity -- mana
  // regeneration also restores 20% as much life"), so a bare number appended
  // to it would say less than the label already does.
  if (kind === "rule") return label;

  if (kind === "status") {
    const phrase = STATUS_PHRASE[detail] || (detail ? `your hits ${detail}` : "");
    return phrase ? `${label}  ${phrase}` : label;
  }

  // `== null` first, deliberately: Number(null) is 0 and passes isFinite, so
  // coercing first would print "+0" for a modifier that carries no value at
  // all -- a fabricated number where the honest answer is the label alone.
  const rawValue = mod ? mod.value : null;
  const raw = rawValue == null || rawValue === "" ? NaN : Number(rawValue);
  if (!Number.isFinite(raw)) return label;

  if (kind === "stat") {
    const abbr = STAT_ABBR[detail];
    return abbr ? `${label}  ${signed(raw)} ${abbr}` : `${label}  ${signed(raw)}`;
  }
  if (kind === "resource") {
    const noun = POOL_NOUN[detail] || detail;
    return noun ? `${label}  ${signed(raw)} ${noun}` : `${label}  ${signed(raw)}`;
  }
  if (kind === "damage") {
    return detail ? `${label}  ${signed(raw)}% ${detail} damage` : `${label}  ${signed(raw)}%`;
  }
  if (kind === "resist") {
    return detail ? `${label}  ${signed(raw)}% ${detail} resist` : `${label}  ${signed(raw)}%`;
  }
  // An unrecognised kind still gets its number rather than being dropped: a
  // kind added server-side must degrade to "label +N", never to silence.
  return detail ? `${label}  ${signed(raw)} ${detail}` : `${label}  ${signed(raw)}`;
}

export const NO_MODIFIERS_TEXT = "No modifiers yet — allocate passives or equip gear.";

// Server order is preserved deliberately: re-sorting client-side would make
// the list disagree with the composeStats() output it claims to be showing.
export function modifierRows(modifiers) {
  const list = Array.isArray(modifiers) ? modifiers : [];
  if (list.length === 0) return [{ text: NO_MODIFIERS_TEXT, source: null }];
  return list.map((m) => ({ text: formatModifier(m), source: (m && m.source) || null }));
}

// Position inside the current level. `xpToNext` is Infinity at max level on the
// backend and serialises as null over JSON, so this checks Number.isFinite
// against the raw field and never coerces it through Number() first (that
// would turn null into 0 and silently divide by it). Two distinct "nothing to
// show" cases, deliberately not conflated: no xpFloor at all (still loading)
// gives an EMPTY bar, not "MAX LEVEL".
export function xpBar(character) {
  const experience = num(character && character.experience);
  const floorRaw = character ? character.xpFloor : null;
  if (typeof floorRaw !== "number") return { into: 0, need: 0, pct: 0 };
  const into = Math.max(0, experience - floorRaw);
  const toNext = character.xpToNext;
  if (!Number.isFinite(toNext)) return { into, need: 0, pct: 100 };
  const pct = toNext > 0 ? Math.round((into / toNext) * 100) : 0;
  return { into, need: toNext, pct };
}

export function xpLoaded(character) {
  return !!character && typeof character.xpFloor === "number";
}

export function formatXpLabel(bar, loaded) {
  if (!loaded) return "Loading…";
  return bar.need > 0 ? `${bar.into} / ${bar.need} XP` : "MAX LEVEL";
}

export function formatPoints(passivePoints) {
  return `Passive points: ${num(passivePoints)}`;
}
