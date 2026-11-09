// SOMET-500 / SOMET-502 -- how ONE item instance is decorated wherever it is
// listed. PURE: nothing here touches a canvas, so every rule below is a unit
// test rather than a screenshot.
//
// FOUR SURFACES SHOW THE SAME INSTANCE, and until now only two of them said so:
//
//   inventory grid   inventoryPanel.js   -- rarity-coloured cell border
//   ground loot      RenderSystem#drawRarityGlow (SOMET-490) -- rarity halo
//   buyback shelf    storageWindows.js (merchant window) -- once drew EVERY row as plain
//   account chest    storageWindows.js (chest window)    -- once drew EVERY row as plain
//
// The obvious fix for the last two is `import { rarityGlowColor }` in each,
// which is a third and a fourth copy of the same one-liner plus a fourth
// hand-picked neutral fallback. SOMET-502's own note asks for the opposite
// ("a shared helper would stop a fourth"), so this is that helper, and the
// inventory grid is switched onto it too rather than left as a fifth reading of
// the palette.
//
// WHY THE NEUTRAL IS A PARAMETER. Each list already has a border colour of its
// own -- slate in the catalogue and the carry list, amber on the buyback shelf
// and in the chest, near-black in the grid -- and the ticket's own criterion is
// that a row with NO grade keeps rendering exactly as it does today. A shared
// helper with a baked-in fallback would repaint every legacy row instead.
import { rarityGlowColor } from "../core/rarityColors.js";
import { t, getLang } from "../i18n/i18n.js";
import { artIcon } from "./gameArt.js";

// The border colour for a cell or a row showing one instance.
//
// White, absent and unrecognised grades all return `neutral` untouched --
// rarityGlowColor deliberately excludes white (see rarityColors.js: a halo on
// every ordinary drop carries no information), and the same reasoning holds
// here: a border every row has is not a signal. That is also what makes an
// instance-less listing row -- the generated base catalogue, a pre-SOMET-498
// chest row -- pixel-identical to how it rendered before this module existed.
export function rarityBorderColor(rarity, neutral) {
  return rarityGlowColor(rarity) || neutral;
}

// The generated icon for an item TYPE (SOMET-600), or null when there is
// none -- every caller falls back to its own pre-existing text/initials, the
// same contract gameArt.js documents for skills and passive labels. Shared
// so the inventory grid, the shop shelf and the sell column all key the same
// icon off the same type.id rather than three readings of artIcon.
export function itemIcon(art, type) {
  return type && type.id != null ? artIcon(art, "item", type.id) : null;
}

// Which normalised field a grant kind reads its `detail` from. The client-side
// twin of backend/src/services/statComposition.js's DETAIL_KEY, and it has to
// stay in step with it: an affix arrives from the server as
// {affixTypeId, key, label, value, effect:{type, stat|pool|element|status}},
// while formatModifier -- the function the Character tab captions equipped-gear
// modifiers with -- wants {label, value, kind, detail}.
const DETAIL_KEY = {
  stat: "stat",
  resource: "pool",
  damage: "element",
  resist: "element",
  status: "status",
  rule: "rule",
};

// One wire affix -> the modifier shape formatModifier reads.
//
// A kind this table does not know keeps its label and its value: formatModifier
// falls through to "label +N", which is the same degradation the Character tab
// applies. Silence would be worse -- an affix added server-side would vanish
// from the shelf rather than read slightly generically.
export function affixModifier(affix) {
  const effect = (affix && affix.effect) || {};
  const key = DETAIL_KEY[effect.type];
  return {
    label: affix ? affix.label : null,
    value: affix ? affix.value : null,
    kind: effect.type,
    detail: key ? effect[key] : null,
  };
}

// Clip to a pixel budget WITHOUT a canvas.
//
// ctx.measureText would be exact, but these panels are drawn in monospace at a
// known size and the recording-context stubs the panel tests drive have no text
// metrics -- a helper that only works in a browser is a helper the tests cannot
// pin. 0.6em is the advance of every monospace face the client ships, and the
// budget is a floor rather than a fit: over-clipping loses a character, while
// under-clipping runs the caption under the Buy button.
export const MONOSPACE_ADVANCE = 0.6;
export const ELLIPSIS = "…";

export function clipToWidth(text, availablePx, fontPx) {
  const s = String(text == null ? "" : text);
  const advance = Number(fontPx) * MONOSPACE_ADVANCE;
  if (!Number.isFinite(advance) || advance <= 0) return "";
  const maxChars = Math.floor(Number(availablePx) / advance);
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars - 1)}${ELLIPSIS}`;
}

// ---- affixes (backend/seeds/data/affixTypes.js) ----------------------------------------------------------------
// An affix of the expanded catalog carries its own tooltip line in effect.text ("+{v}% Attack Speed") and, for the
// ones with tiers, effect.tiers ([{ ilvl, min, max }] ascending). The original twelve have neither and keep the
// modifier path above.

// The rolled number as a player reads it: whole when the effect says so (or it is whole), else one decimal.
export function affixValueText(value, effect) {
  const v = value == null || value === "" ? NaN : Number(value);
  if (!Number.isFinite(v)) return "";
  if ((effect && effect.int) || Number.isInteger(v)) return String(Math.round(v));
  return String(Math.round(v * 10) / 10);
}

// 1 = the best tier, tiers.length = the lowest; null for an affix with no tiers. Twin of the server's tierOf.
export function affixTier(effect, value) {
  const tiers = effect && Array.isArray(effect.tiers) ? effect.tiers : null;
  if (!tiers || tiers.length === 0) return null;
  const v = Number(value);
  let idx = 0;
  for (let i = 0; i < tiers.length; i += 1) if (v >= Number(tiers[i].min) - 1e-9) idx = i;
  return tiers.length - idx;
}

// The tooltip line for one wire affix, or null when it has no text of its own (the caller falls back to
// affixModifier + formatModifier). `tier` is shown as "T1".."Tn".
export function affixTooltipLine(affix) {
  const effect = affix && affix.effect;
  if (!effect || typeof effect.text !== "string" || effect.text === "") return null;
  const tier = affixTier(effect, affix.value);
  const text = t(effect.text, { v: affixValueText(affix.value, effect) });
  return { text: tier ? `${text}  T${tier}` : text, tier, top: tier === 1 };
}

// "Brutal Iron Sword of Celerity": an item's name from its first prefix and first suffix (a label that starts with
// "of" is a suffix). English only: the Ukrainian words would need the base name declined to agree with them, so
// there the base name stays and the lines below say the rest.
export function itemDisplayName(baseName, affixes) {
  if (getLang() !== "en" || !Array.isArray(affixes) || affixes.length === 0) return baseName;
  const labels = affixes.map((a) => a && a.label).filter(Boolean);
  const prefix = labels.find((l) => !/^of\b/i.test(l));
  const suffix = labels.find((l) => /^of\b/i.test(l));
  return [prefix, baseName, suffix].filter(Boolean).join(" ");
}
