// SOMET-768: which sprite animations the player lets the game play. Pure --
// the Settings panel lists ANIMATION_GROUPS, uiPrefs stores the booleans, and
// RenderSystem / Game read them at the sprite-or-fallback branches they gate.
//
// A key that is OFF falls back to what the game drew before that sprite
// family existed: an action -> the idle row (or one still frame when idle is
// off too), an effect sheet -> its drawn shape, an aura sheet -> its ring, a
// buff/status sheet -> its drawn glow or crystal, prop motion -> a still prop,
// a tile atlas -> the tile's still image. Nothing here touches pure-JS
// effects (sprint wind, weapon glow): they are not sprite animations.

// Sheet actions (systems/sheetActions.js) -- the key IS the action name, so
// RenderSystem can look an action up directly.
export const ACTION_KEYS = Object.freeze(["idle", "walk", "attack", "cast", "damage", "death", "use"]);
export const FAMILY_KEYS = Object.freeze(["vfx", "auras", "buffs", "props", "tiles"]);
export const ANIMATION_KEYS = Object.freeze([...ACTION_KEYS, ...FAMILY_KEYS]);

export const ALL_ANIMATIONS_ON = Object.freeze(Object.fromEntries(ANIMATION_KEYS.map((k) => [k, true])));

// What the Settings tab shows: label and hint are English source strings
// (translated through t() where they are rendered).
export const ANIMATION_GROUPS = Object.freeze([
  {
    title: "Characters & creatures",
    rows: [
      { key: "idle", label: "Idle", hint: "Breathing and shifting while standing. Off: one still frame." },
      { key: "walk", label: "Walk", hint: "Legs moving while walking. Off: the idle pose slides along." },
      { key: "attack", label: "Attack", hint: "The swing or shot. Off: the idle pose." },
      { key: "cast", label: "Cast", hint: "The casting gesture. Off: the idle pose." },
      { key: "damage", label: "Hit", hint: "The flinch on taking damage. Off: the idle pose." },
      { key: "death", label: "Death", hint: "The death animation and the corpse it leaves. Off: the creature simply disappears." },
      { key: "use", label: "Use", hint: "Opening chests and using things. Off: the idle pose." },
    ],
  },
  {
    title: "Effects",
    rows: [
      { key: "vfx", label: "Skill effects", hint: "Drawn effect sheets for attacks and skills. Off: the simple drawn shapes and particles." },
      { key: "auras", label: "Auras", hint: "Drawn aura discs under creatures. Off: plain rings." },
      { key: "buffs", label: "Buffs & statuses", hint: "Buff art on characters and the amber seal crystal. Off: the simple drawn versions." },
    ],
  },
  {
    title: "World",
    rows: [
      { key: "props", label: "Prop motion", hint: "Swaying bushes, drifting and glinting props. Off: still props." },
      { key: "tiles", label: "Tile animation", hint: "Animated ground tiles such as water. Off: the tile's still image." },
    ],
  },
]);

// Anything unknown or malformed is ON, field by field: a missing or
// hand-edited value can never silently hide art.
export function normalizeAnimations(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const k of ANIMATION_KEYS) out[k] = typeof r[k] === "boolean" ? r[k] : true;
  return out;
}

export function withAllAnimations(on) {
  const out = {};
  for (const k of ANIMATION_KEYS) out[k] = Boolean(on);
  return out;
}

export function allAnimationsOn(a) {
  return ANIMATION_KEYS.every((k) => !a || a[k] !== false);
}

export function anyAnimationOn(a) {
  return ANIMATION_KEYS.some((k) => !a || a[k] !== false);
}

export function sameAnimations(a, b) {
  const x = normalizeAnimations(a);
  const y = normalizeAnimations(b);
  return ANIMATION_KEYS.every((k) => x[k] === y[k]);
}
