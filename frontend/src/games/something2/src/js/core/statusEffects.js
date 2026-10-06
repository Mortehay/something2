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

export const EFFECT_ORDER = ["burn", "chill", "shock"];

const EFFECT_LABEL = {
  burn: "Burning",
  chill: "Slowed",
  shock: "Shocked",
};

export const STATUS_EFFECT_CATALOG = {
  burn: { nameEn: "Burning", nameUk: "Горіння", icon: "🔥", category: "debuff", color: elementColor("fire") },
  chill: { nameEn: "Slowed", nameUk: "Уповільнення", icon: "❄️", category: "debuff", color: elementColor("ice") },
  shock: { nameEn: "Shocked", nameUk: "Шок", icon: "⚡", category: "debuff", color: elementColor("lightning") },
  victors_boon: { nameEn: "Victor's Boon", nameUk: "Благословення Переможця", icon: "👑", category: "buff", color: "#ffd166" },
  steel_tempering: { nameEn: "Steel Tempering", nameUk: "Загартування Сталі", icon: "🛡️", category: "buff", color: "#4ade80" },
  arcane_barrier: { nameEn: "Arcane Barrier", nameUk: "Аркановий Бар'єр", icon: "🔮", category: "buff", color: "#a55eea" },
  frenzy: { nameEn: "Frenzy", nameUk: "Лють", icon: "🩸", category: "buff", color: "#eb3b5a" },
  poison: { nameEn: "Poisoned", nameUk: "Отруєння", icon: "☠️", category: "debuff", color: "#20bf6b" },
};

export function getStatusEffectDetails(key) {
  if (STATUS_EFFECT_CATALOG[key]) return STATUS_EFFECT_CATALOG[key];
  return null;
}

export function normalizeEffects(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const known = new Set(EFFECT_ORDER);
  const present = new Set(keys.filter((k) => known.has(k)));
  return EFFECT_ORDER.filter((k) => present.has(k));
}

export function effectColor(key) {
  const element = EFFECT_ELEMENT[key];
  return element ? elementColor(element) : null;
}

export function effectHudLine(keys) {
  const active = normalizeEffects(keys);
  if (active.length === 0) return null;
  return active.map((k) => EFFECT_LABEL[k]).join("  ");
}

