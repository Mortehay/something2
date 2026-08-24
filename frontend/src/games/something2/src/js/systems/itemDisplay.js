// SOMET-500 / SOMET-502 -- how ONE item instance is decorated wherever it is
// listed. PURE: nothing here touches a canvas, so every rule below is a unit
// test rather than a screenshot.
//
// FOUR SURFACES SHOW THE SAME INSTANCE, and until now only two of them said so:
//
//   inventory grid   inventoryPanel.js   -- rarity-coloured cell border
//   ground loot      RenderSystem#drawRarityGlow (SOMET-490) -- rarity halo
//   buyback shelf    RenderSystem#renderShop   -- drew EVERY row as plain
//   account chest    RenderSystem#renderBank   -- drew EVERY row as plain
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
import { formatModifier } from "./characterTab.js";

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

export const AFFIX_SEPARATOR = "  ·  ";

// Every rolled affix on one line, or "" when the item has none (which is also
// what an instance-less row and a white item give, so a caller can branch on
// the empty string alone).
//
// Reuses formatModifier rather than formatting here, deliberately: the shelf
// and the character sheet describe the same rolled number, and "of Might +7
// STR" on one screen beside "Might: 7" on the other is the drift both tickets'
// third acceptance criterion is written against.
export function affixLine(affixes) {
  const list = Array.isArray(affixes) ? affixes : [];
  if (list.length === 0) return "";
  return list.map((a) => formatModifier(affixModifier(a))).join(AFFIX_SEPARATOR);
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

// Where a list row's three text lines sit, relative to the row's top edge.
//
// Shared by renderShop and renderBank so a stored item and a shelved item are
// laid out identically -- the same reason renderBank borrowed the shop's tab
// strip and paging strip. A row with NO affixes keeps the two-line geometry it
// has always had (6 / 22), so nothing about a legacy row moves; the three-line
// variant only ever applies to a row that could not previously exist, because
// no listing carried an affix before this change.
export const AFFIX_FONT_PX = 10;

export function rowTextOffsets(hasAffixes) {
  return hasAffixes
    ? { name: 3, sub: 16, affix: 28 }
    : { name: 6, sub: 22, affix: null };
}
