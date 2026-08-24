// The ONE rarity palette (SOMET-490).
//
// Two consumers read it: the inventory panel, which tints a held item's cell,
// and the ground-item glow, which tints a dropped item's halo. They must agree.
// A ground glow that says "foxy" over a panel that says "blue" is worse than no
// glow at all -- a player trusts the world before they trust a menu, so a drift
// between the two palettes actively misinforms rather than merely under-informs.
// Hence one module, imported by both, with no second copy of any hex anywhere.
//
// Grade vocabulary matches backend/src/authority/rarity.js RARITIES exactly.

export const RARITY_COLORS = {
  white: "#d6d9e0",
  blue: "#4a9eff",
  yellow: "#f5c518",
  foxy: "#ff7a1a",
};

// White is deliberately absent from the GLOWING set. If an ordinary drop got a
// pale halo, every drop would look notable and the signal would carry no
// information at all -- the glow's whole job is to mark the *exception*.
export const GLOWING_RARITIES = ["blue", "yellow", "foxy"];

// The grade's colour, or null when the grade is unknown/absent. Callers that
// must render something regardless fall back to their own pre-rarity colour,
// which is what keeps a pre-SOMET-480 item pixel-identical to how it looked
// before this feature existed.
export function rarityColor(rarity) {
  return Object.prototype.hasOwnProperty.call(RARITY_COLORS, rarity)
    ? RARITY_COLORS[rarity]
    : null;
}

// The glow colour, or null for white / unknown / missing -- i.e. "draw nothing
// extra". Separate from rarityColor because white DOES have a palette entry
// (the panel tints a white item's cell border with it) but must never glow.
export function rarityGlowColor(rarity) {
  return GLOWING_RARITIES.includes(rarity) ? RARITY_COLORS[rarity] : null;
}

// "#rrggbb" + alpha -> "rgba(r,g,b,a)". The glow needs a gradient whose stops
// fade to transparent, and canvas gradient stops take a colour string, not a
// colour plus an alpha. Returns null for anything that is not a 6-digit hex so
// a bad palette edit draws nothing rather than a silently-ignored stop.
export function withAlpha(hex, alpha) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ""));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
