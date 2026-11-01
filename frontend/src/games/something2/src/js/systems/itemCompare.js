// Pure weapon/armor comparison for item tooltips. No canvas, no DOM.
// Uses only fields the client item types carry (core/inventory.js maps them):
// damage, cooldown, reach, range, mana_cost, stamina_cost, element, defense,
// resistances, slot, category.

const GREEN = "#4ade80";
const RED = "#f87171";
const GREY = "#9ca3af";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round1 = (n) => Math.round(n * 10) / 10;

function dpsOf(t) {
  const d = num(t.damage);
  const c = num(t.cooldown);
  return c > 0 ? d / c : 0;
}

function judge(delta, higherIsBetter) {
  if (Math.abs(delta) < 1e-9) return null;
  return (delta > 0) === higherIsBetter;
}

function row(label, cand, eq, higherIsBetter, fmt = (n) => String(round1(n))) {
  const delta = round1(cand - eq);
  return { label, value: round1(cand), delta, better: judge(delta, higherIsBetter), text: fmt(cand) };
}

export function isComparable(type) {
  return !!type && (type.category === "weapon" || type.category === "armor");
}

// Which equipment slot a candidate is compared against.
export function comparisonSlot(type) {
  if (!isComparable(type)) return null;
  if (type.category === "weapon") return "main_hand";
  return type.slot || null;
}

// -> [{label, value, delta, better, text}]. [] when not comparable or the
// categories differ. equippedType may be null (empty slot: compared to zeros).
export function compareItems(candidateType, equippedType) {
  if (!isComparable(candidateType)) return [];
  if (equippedType && equippedType.category !== candidateType.category) return [];
  const eq = equippedType || {};
  const out = [];
  if (candidateType.category === "weapon") {
    out.push(row("Damage", num(candidateType.damage), num(eq.damage), true));
    out.push(row("Cooldown", num(candidateType.cooldown), num(eq.cooldown), false, (n) => `${round1(n)}s`));
    out.push(row("DPS", dpsOf(candidateType), dpsOf(eq), true, (n) => n.toFixed(1)));
    const reachOf = (t) => num(t.reach) || num(t.range);
    if (reachOf(candidateType) || reachOf(eq)) {
      out.push(row(candidateType.range && !candidateType.reach ? "Range" : "Reach", reachOf(candidateType), reachOf(eq), true));
    }
    if (num(candidateType.mana_cost) || num(eq.mana_cost)) {
      out.push(row("Mana cost", num(candidateType.mana_cost), num(eq.mana_cost), false));
    }
    if (num(candidateType.stamina_cost) || num(eq.stamina_cost)) {
      out.push(row("Stamina cost", num(candidateType.stamina_cost), num(eq.stamina_cost), false));
    }
    const el = (t) => (t.element ? t.element : "physical");
    if (el(candidateType) !== el(eq)) {
      out.push({ label: "Element", value: el(candidateType), delta: 0, better: null, text: `${el(candidateType)} (was ${el(eq)})`, textOnly: true });
    }
  } else {
    out.push(row("Defense", num(candidateType.defense), num(eq.defense), true));
    const cr = candidateType.resistances || {};
    const er = eq.resistances || {};
    const els = [...new Set([...Object.keys(cr), ...Object.keys(er)])];
    for (const el of els) {
      if (!num(cr[el]) && !num(er[el])) continue;
      out.push(row(`${el} res`, num(cr[el]), num(er[el]), true, (n) => `${round1(n)}%`));
    }
  }
  return out;
}

function signed(n) {
  return `${n > 0 ? "+" : ""}${round1(n)}`;
}

// -> tooltip lines [{text,color,font}] to append. Empty when nothing to
// compare or when the candidate IS the equipped item.
export function compareLines(candidateItem, candidateType, equippedItem, equippedType) {
  if (!isComparable(candidateType)) return [];
  if (candidateItem && equippedItem && candidateItem.id != null && candidateItem.id === equippedItem.id) return [];
  const rows = compareItems(candidateType, equippedType || null);
  if (rows.length === 0) return [];
  const lines = [{
    text: `vs equipped: ${equippedType ? (equippedType.name || "unknown") : "nothing"}`,
    color: GREY,
    font: "italic 11px monospace",
  }];
  for (const r of rows) {
    const color = r.better === true ? GREEN : r.better === false ? RED : GREY;
    const text = r.textOnly ? `${r.label}: ${r.text}` : `${r.label} ${r.text} (${signed(r.delta)})`;
    lines.push({ text, color, font: "11px monospace" });
  }
  return lines;
}
