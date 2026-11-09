// The in-game admin menu's character grants: what the form sends to the server's debugAdmin
// handler (backend/src/authority/adminTools.js). Pure, so the rules are testable in the node vitest
// env (the component is not). Each builder returns { action, opts } or { error }; the limits are the
// server's, stated here so a wrong value is refused before a round trip (the server clamps anyway).

export const MAX_GOLD_GRANT = 1_000_000_000;
export const MAX_XP_GRANT = 100_000_000_000;
export const MAX_POINTS_GRANT = 1000;
export const MAX_LEVEL_INPUT = 10_000;
export const MAX_ITEM_LEVEL = 200;
export const MAX_ITEM_QTY = 9999;
// The server clamps both to its own caps (enchant config, skill-leveling config); these only refuse nonsense early.
export const MAX_ENCHANT_INPUT = 15;
export const MAX_SKILL_LEVEL_INPUT = 15;

export const GOLD_PRESETS = Object.freeze([1_000, 100_000, 10_000_000, 1_000_000_000]);
export const LEVEL_PRESETS = Object.freeze([10, 30, 60, 100]);
export const XP_PRESETS = Object.freeze([1_000, 100_000, 10_000_000]);
export const ENCHANT_PRESETS = Object.freeze([3, 6, 10, 15]);
export const SKILL_LEVEL_PRESETS = Object.freeze([1, 5, 10, 15]);
// white / blue / yellow / foxy, the server's RARITIES; foxy is the legendary one.
export const RARITY_OPTIONS = Object.freeze([
  Object.freeze({ value: 'white', label: 'White (common)' }),
  Object.freeze({ value: 'blue', label: 'Blue (magic)' }),
  Object.freeze({ value: 'yellow', label: 'Yellow (rare)' }),
  Object.freeze({ value: 'foxy', label: 'Foxy (legendary)' }),
]);

// "1,000" / " 1000 " / 1e6 -> 1000 / 1000 / 1000000; anything else -> NaN.
export function parseWhole(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.floor(raw) : NaN;
  const s = String(raw ?? '').replace(/[\s,_]/g, '');
  if (s === '' || !/^[0-9]+(\.[0-9]+)?(e[0-9]+)?$/i.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? Math.floor(n) : NaN;
}

function whole(raw, max, what) {
  const n = parseWhole(raw);
  if (!Number.isFinite(n) || n < 1) return { error: `${what} must be a positive whole number` };
  if (n > max) return { error: `${what} is at most ${max.toLocaleString('en-US')}` };
  return { n };
}

export function goldAction(raw) {
  const r = whole(raw, MAX_GOLD_GRANT, 'Gold');
  return r.error ? r : { action: 'gold', opts: { amount: r.n } };
}

export function levelAction(raw) {
  const r = whole(raw, MAX_LEVEL_INPUT, 'Level');
  return r.error ? r : { action: 'level', opts: { level: r.n } };
}

export function xpAction(raw) {
  const r = whole(raw, MAX_XP_GRANT, 'XP');
  return r.error ? r : { action: 'xp', opts: { amount: r.n } };
}

export function pointsAction(raw) {
  const r = whole(raw, MAX_POINTS_GRANT, 'Passive points');
  return r.error ? r : { action: 'points', opts: { amount: r.n } };
}

export function restoreAction() {
  return { action: 'restore', opts: {} };
}

export function itemAction({ itemTypeId, rarity = 'white', level = 1, quantity = 1, enchantLevel = 0 } = {}) {
  const id = parseWhole(itemTypeId);
  if (!Number.isFinite(id) || id < 1) return { error: 'Pick an item' };
  if (!RARITY_OPTIONS.some((o) => o.value === rarity)) return { error: 'Pick a rarity' };
  const lvl = whole(level, MAX_ITEM_LEVEL, 'Item level');
  if (lvl.error) return lvl;
  const qty = whole(quantity, MAX_ITEM_QTY, 'Quantity');
  if (qty.error) return qty;
  // 0 (or empty) is a plain weapon; a weapon with a level lies there already enchanted. The server ignores it
  // for anything that is not a weapon.
  const plusRaw = parseWhole(enchantLevel === '' || enchantLevel == null ? 0 : enchantLevel);
  if (!Number.isFinite(plusRaw) || plusRaw < 0 || plusRaw > MAX_ENCHANT_INPUT) return { error: `Enchant level must be 0 to ${MAX_ENCHANT_INPUT}` };
  return { action: 'item', opts: { itemTypeId: id, rarity, level: lvl.n, quantity: qty.n, enchantLevel: plusRaw } };
}

// Skill gems: one skill, every gem of your own class, or every gem there is. Ownership only; no requirement
// or price is checked (the server grants them, see adminTools.grantGems).
export function gemAction({ skillId, scope } = {}) {
  if (scope === 'class' || scope === 'all') return { action: 'gem', opts: { scope } };
  if (typeof skillId !== 'string' || skillId === '') return { error: 'Pick a skill' };
  return { action: 'gem', opts: { skillId } };
}

// A skill's paid level, 0..15 (0 removes it).
export function skillLevelAction({ skillId, level } = {}) {
  if (typeof skillId !== 'string' || skillId === '') return { error: 'Pick a skill' };
  const n = level === '' || level == null ? NaN : parseWhole(level);
  if (!Number.isFinite(n) || n < 0 || n > MAX_SKILL_LEVEL_INPUT) return { error: `Skill level must be 0 to ${MAX_SKILL_LEVEL_INPUT}` };
  return { action: 'skillLevel', opts: { skillId, level: n } };
}

// Gear (weapon, armour) takes a rarity and rolls affixes; everything else is a plain stack.
export function isGearCategory(category) {
  return category === 'weapon' || category === 'armor';
}

// The picker's list: the search matches the name or the category, and the list stays short enough to scroll.
export function filterItems(items, query, limit = 200) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query || '').trim().toLowerCase();
  const out = q
    ? list.filter((t) => String(t.name || '').toLowerCase().includes(q) || String(t.category || '').toLowerCase().includes(q))
    : list;
  return out.slice(0, limit);
}

// The skill picker's list: the search matches the name, the id or the class; sorted by class, then unlock level.
export function filterSkills(skills, query, limit = 200) {
  const list = Array.isArray(skills) ? skills : [];
  const q = String(query || '').trim().toLowerCase();
  const out = q
    ? list.filter((s) => [s.nameEn, s.id, s.class].some((v) => String(v || '').toLowerCase().includes(q)))
    : list;
  return [...out]
    .sort((a, b) => String(a.class).localeCompare(String(b.class)) || (a.reqLvl || 0) - (b.reqLvl || 0) || String(a.nameEn).localeCompare(String(b.nameEn)))
    .slice(0, limit);
}

// A line for the menu's log: the server's own text, with the outcome marked.
export function logLine(msg) {
  const text = msg && typeof msg.text === 'string' ? msg.text : 'no answer';
  return { ok: !!(msg && msg.ok), text };
}
