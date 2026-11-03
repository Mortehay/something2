// Client-side view logic for weapon enchanting and paid skill levels.
//
// PURE: no canvas, no sockets. Everything here turns "what the server told us" (the
// join frame's `enchant` / `skillLeveling` config, the inventory, the wallet) into
// "what the panel should show and whether its button may be pressed". The server
// re-checks every one of these rules; this module only keeps the UI honest and
// stops a click that is certain to be refused.

import { t } from "../i18n/i18n.js";

// How long the second click of a dangerous enchant stays armed.
export const ENCHANT_CONFIRM_MS = 4000;

export function enchantLevelOf(item) {
  const n = Number(item && item.enchantLevel);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// "+7 steel-sword" for an enchanted weapon, the plain name otherwise.
export function enchantedName(name, level) {
  const n = t(String(name || "Unknown Item"));
  return level > 0 ? `+${level} ${n}` : n;
}

// The damage bonus a level gives, as a whole percent (+5 -> 40 with 8% per level).
export function damageBonusPercent(level, cfg) {
  if (!cfg || !(level > 0)) return 0;
  return Math.round(level * cfg.damagePerLevel * 100);
}

// A weapon's damage at `level`, for the tooltip.
export function enchantedDamage(baseDamage, level, cfg) {
  const base = Number(baseDamage) || 0;
  if (!cfg || !(level > 0)) return base;
  return Math.round(base * (1 + cfg.damagePerLevel * level) * 100) / 100;
}

// 'standard' | 'blessed' | null: which enchant scroll a catalog name is.
function scrollKindOf(name, cfg) {
  if (!cfg) return null;
  if (name === cfg.scrollItemName) return "standard";
  if (cfg.blessedScrollItemName && name === cfg.blessedScrollItemName) return "blessed";
  return null;
}

// Can a scroll of `kind` be spent on a weapon that is at `level`? The standard scroll always;
// the blessed one only once the NEXT level is past the safe zone (inside it a miss cannot hurt).
export function scrollFitsLevel(kind, level, cfg) {
  if (kind === "standard") return true;
  return kind === "blessed" && level + 1 > cfg.safeMaxLevel;
}

// The scroll stack to spend on a weapon at `level`, or null. The blessed scroll is only ever used when
// asked for ({ blessed: true }) -- it is dear, and it must never be spent by accident.
export function findScroll(inventory, cfg, level = 0, { blessed = false } = {}) {
  if (!inventory || !cfg) return null;
  const want = blessed ? "blessed" : "standard";
  if (!scrollFitsLevel(want, level, cfg)) return null;
  for (const it of inventory.items || []) {
    const type = inventory.types && inventory.types.get(it.typeId);
    if (!type || !((it.quantity || 1) > 0)) continue;
    if (scrollKindOf(type.name, cfg) === want) return it;
  }
  return null;
}

// Scrolls carried: of one `kind` ('standard' | 'blessed'), or of every kind when omitted.
export function scrollCount(inventory, cfg, kind = null) {
  if (!inventory || !cfg) return 0;
  let n = 0;
  for (const it of inventory.items || []) {
    const type = inventory.types && inventory.types.get(it.typeId);
    const k = type && scrollKindOf(type.name, cfg);
    if (k && (kind == null || kind === k)) n += Math.max(1, it.quantity || 1);
  }
  return n;
}

// Scrolls of the kind in use that would actually work on a weapon at `level`.
export function usableScrollCount(inventory, cfg, level, { blessed = false } = {}) {
  const kind = blessed ? "blessed" : "standard";
  return scrollFitsLevel(kind, level, cfg) ? scrollCount(inventory, cfg, kind) : 0;
}

// What pressing "Enchant" on `itemId` would do. `ok` says whether the button may be
// pressed; when it may not, `reason` says why (and is shown on the disabled button).
//
//   { ok, reason, itemId, scrollId, scrolls, level, nextLevel, chancePct, danger, maxed }
export function enchantPlan(inventory, itemId, cfg, { blessed = false } = {}) {
  const none = { ok: false, reason: "", itemId, scrollId: null, scrolls: 0, level: 0, nextLevel: 0, chancePct: 0, danger: false, maxed: false };
  if (!cfg || !inventory || itemId == null) return none;
  const item = (inventory.items || []).find((i) => i.id === itemId);
  const type = item && inventory.types && inventory.types.get(item.typeId);
  if (!item || !type || type.category !== "weapon") return none;

  const level = enchantLevelOf(item);
  const base = { ...none, level };
  if (level >= cfg.maxLevel) {
    return { ...base, maxed: true, reason: t("Maximum +{n}", { n: cfg.maxLevel }) };
  }
  const nextLevel = level + 1;
  const chancePct = Number(cfg.chances[nextLevel]) || 0;
  const danger = nextLevel > cfg.safeMaxLevel;
  // A blessed scroll only means something where a miss would burn the weapon.
  const useBlessed = blessed && danger;
  const scroll = findScroll(inventory, cfg, level, { blessed: useBlessed });
  const scrolls = usableScrollCount(inventory, cfg, level, { blessed: useBlessed });
  const plan = { ...base, nextLevel, chancePct, danger, blessed: useBlessed, scrolls, scrollId: scroll ? scroll.id : null };
  if (!scroll) return { ...plan, reason: useBlessed ? t("No blessed scroll") : t("No enchant scroll") };
  return { ...plan, ok: true };
}

// The button's text. `armed` is the dangerous-enchant second-click state.
export function enchantButtonLabel(plan, armed = false) {
  if (!plan) return "";
  if (plan.maxed) return plan.reason;
  if (!plan.ok) return plan.reason || t("Enchant");
  if (plan.danger && plan.blessed) {
    return armed
      ? t("Click again: {pct}% or back to +3", { pct: plan.chancePct })
      : `${t("Blessed enchant +{n} ({pct}%)", { n: plan.nextLevel, pct: plan.chancePct })} 🛡`;
  }
  if (plan.danger) {
    return armed
      ? t("Click again: {pct}% or it BURNS", { pct: plan.chancePct })
      : `${t("Enchant +{n} ({pct}%)", { n: plan.nextLevel, pct: plan.chancePct })} ⚠`;
  }
  return t("Enchant +{n} (safe)", { n: plan.nextLevel });
}

// A danger-zone enchant needs a second click; a safe one does not.
export function needsConfirm(plan) { return !!(plan && plan.ok && plan.danger); }

// The line a result frame becomes in the toast.
export function enchantResultMessage(msg, weaponName = "weapon") {
  if (!msg) return "";
  if (msg.outcome === "success") return `✨ ${t("{name} is now +{level}!", { name: t(weaponName), level: msg.level })}`;
  if (msg.outcome === "destroyed") return `🔥 ${t("The scroll failed — your {name} burned to ash.", { name: t(weaponName) })}`;
  if (msg.outcome === "reset") return `🛡 ${t("The blessed scroll failed — your {name} fell back to +{level}.", { name: t(weaponName), level: msg.level })}`;
  if (msg.outcome === "safe_fail") return t("The scroll fizzled. {name} is unchanged.", { name: t(weaponName) });
  return "";
}

// Apply an `enchanted` result frame to the inventory mirror, in place.
//   * the scroll stack shrinks (or goes, when it was the last)
//   * a success raises the weapon's level
//   * a burn removes the weapon and whatever slot held it
// Returns the weapon's name (read before it may be removed) for the toast.
export function applyEnchantResult(inventory, msg) {
  if (!inventory || !msg) return "weapon";
  const weapon = (inventory.items || []).find((i) => i.id === msg.itemId);
  const type = weapon && inventory.types && inventory.types.get(weapon.typeId);
  const name = (type && type.name) || "weapon";

  const scroll = (inventory.items || []).find((i) => i.id === msg.scrollId);
  if (scroll) {
    if (Number(msg.scrollsLeft) > 0) scroll.quantity = Number(msg.scrollsLeft);
    else inventory.items = inventory.items.filter((i) => i.id !== msg.scrollId);
  }
  if (msg.destroyed) {
    inventory.items = inventory.items.filter((i) => i.id !== msg.itemId);
    for (const [slot, id] of Object.entries(inventory.equipment || {})) {
      if (id === msg.itemId) delete inventory.equipment[slot];
    }
  } else if ((msg.outcome === "success" || msg.outcome === "reset") && weapon) {
    weapon.enchantLevel = Number(msg.level) || 0;
  }
  return name;
}

// ---------------------------------------------------------------- skill levels

export function skillLevelOf(levels, skillId) {
  const n = levels instanceof Map ? levels.get(skillId) : levels && levels[skillId];
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// What the "Upgrade" button on a skill should show.
//
//   { level, max, maxed, cost, canAfford, disabled, label, bonusPct }
//
// `disabled` is true at the cap (button blocked) and when the gold is short.
// `tier` is the skill's tier (1..5, carried on every catalog skill): a stronger skill
// has a dearer price table. The tables come from the server (`costsByTier`), so this
// never computes a price; an older config with only `costs` prices every skill alike.
export function skillUpgradePlan(levels, skillId, gold, cfg, tier = 1) {
  if (!cfg) return { level: 0, max: 0, maxed: false, cost: 0, canAfford: false, disabled: true, label: "", bonusPct: 0 };
  const level = skillLevelOf(levels, skillId);
  const max = cfg.maxLevel;
  const bonusPct = Math.round(level * cfg.powerPerLevel * 100);
  if (level >= max) {
    return { level, max, maxed: true, cost: 0, canAfford: false, disabled: true, label: t("MAX Lv {n}", { n: max }), bonusPct };
  }
  const table = (cfg.costsByTier && cfg.costsByTier[tier]) || cfg.costs || [];
  const cost = Number(table[level]) || 0;          // table[i] is the price of level i+1
  const canAfford = (Number(gold) || 0) >= cost;
  return {
    level, max, maxed: false, cost, canAfford, disabled: !canAfford,
    label: t("Upgrade → Lv {n}  {cost}g", { n: level + 1, cost: cost.toLocaleString() }), bonusPct,
  };
}
