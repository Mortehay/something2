// Client-side reading of the server's status-effect broadcast.
//
// The server sends effect KEYS only (see activeEffectKeys in
// backend/src/authority/effects.js) — no durations, no magnitudes, no expiry
// timestamps. So everything here is a pure key -> presentation lookup, with no
// timers and no state: the client's picture of who is burning is exactly the
// last frame it was told about, and it goes away when the server stops saying
// it.
//
// This module is canvas-free ON PURPOSE. Vitest runs under env `node` with no
// jsdom in this repo, so anything inside RenderSystem is verified only by
// `npm run build` plus a browser pass. Every decision worth asserting about —
// which colour an effect is, what the HUD line says, how an unknown key is
// handled — lives here where a unit test can reach it.

import { elementColor } from "./blasts.js";

// Effect key -> the element that causes it. These keys are the server's
// exported BURN / CHILL / SHOCK constants; they are a wire contract, so
// renaming one here without renaming it there silently stops every tint.
export const EFFECT_ELEMENT = {
  burn: "fire",
  chill: "ice",
  shock: "lightning",
};

// Drawn/listed in this order regardless of the order the server happened to
// iterate its Map in, so a player under two effects sees a stable HUD line and
// a stable ring order rather than something that flickers between frames.
export const EFFECT_ORDER = ["burn", "chill", "shock"];

// Short HUD labels. Deliberately the player-facing word rather than the wire
// key: "Slowed" says what chill does, "chill" only says what it is called.
const EFFECT_LABEL = {
  burn: "Burning",
  chill: "Slowed",
  shock: "Shocked",
};

// Filter to keys this client understands, in EFFECT_ORDER.
//
// An unknown key is DROPPED rather than drawn in the fallback colour. A server
// that adds a fourth effect before the client ships would otherwise paint it
// with lightning's yellow and read to the player as a shock — a wrong tint is
// worse than no tint, because the player acts on it.
export function normalizeEffects(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  return EFFECT_ORDER.filter((k) => keys.includes(k));
}

// The colour for one effect key, routed through the SAME elementColor table
// the projectiles and blast rings use — a burn tint and the fire bolt that
// caused it must not be two different oranges. Returns null for an unknown
// key so callers skip it rather than drawing a default.
export function effectColor(key) {
  const element = EFFECT_ELEMENT[key];
  return element ? elementColor(element) : null;
}

// The HUD line for the local player's own effects, or null to draw nothing.
// Null (not "") so the caller can omit the line entirely rather than pushing a
// blank row into the HUD box, which would make the panel jump a row taller
// whenever anything touched the player.
export function effectHudLine(keys) {
  const active = normalizeEffects(keys);
  if (active.length === 0) return null;
  return active.map((k) => EFFECT_LABEL[k]).join("  ");
}
