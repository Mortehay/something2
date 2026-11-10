// Amber Stance on the client: pure rules. Game keeps the state (its own amber,
// the arrival it sent ready / break for, the fades) and RenderSystem draws.
//
// Wire shape (Task 2): each sealed player in a `state` frame carries
// `amber: { a: arrivalId, ms: endsInMs, v: variant|null }`; the key is absent
// otherwise, so every frame REPLACES the previous value.

export const AMBER_FADE_MS = 400;

// The inputs that end a seal once ready was sent. Interaction keys (inventory,
// chat, menus, equip, interact) are deliberately not here.
const BREAK_INPUTS = new Set(['move', 'attack', 'skill', 'ground']);

// Whole seconds left, rounded up: the number above the head.
export function countdownText(ms) {
  const n = Number(ms);
  return String(Math.ceil((Number.isFinite(n) && n > 0 ? n : 0) / 1000));
}

// Overlay opacity `msSinceEnd` after the amber left the snapshot: 1 -> 0 linearly.
export function fadeAlpha(msSinceEnd) {
  const t = Number(msSinceEnd);
  if (!Number.isFinite(t) || t <= 0) return 1;
  return t >= AMBER_FADE_MS ? 0 : 1 - t / AMBER_FADE_MS;
}

// GET /api/status-visuals rows by subject key (`amber_stance_<variant>`).
// A missing or failed response gives an empty library (every variant draws the fallback).
export function indexStatusVisuals(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) if (row && row.key) out[row.key] = row;
  return out;
}

// `amber_stance_<variant>`, built once per variant: the renderer asks every frame.
const VARIANT_KEYS = new Map();
function variantKey(variant) {
  let k = VARIANT_KEYS.get(variant);
  if (k === undefined) {
    k = `amber_stance_${variant}`;
    if (VARIANT_KEYS.size < 64) VARIANT_KEYS.set(variant, k);
  }
  return k;
}

// The approved sprite row of an amber variant, or null: null variant (nothing
// approved when sealed), a variant not in the library, or a row with no sprite
// all draw the code fallback.
export function amberSheetFor(variant, statusVisualsByKey) {
  if (variant === null || variant === undefined || !statusVisualsByKey) return null;
  const row = statusVisualsByKey[variantKey(variant)];
  return row && typeof row.sprite_image === 'string' && row.sprite_image ? row : null;
}

// True only when sealed, ready was sent for THIS arrival, and the input is a
// move, an attack, a skill or a ground click. `ready` is the arrival id the
// client sent amberReady for (null if none).
export function shouldBreak({ amber, ready, input }) {
  return !!amber && ready !== null && ready !== undefined && ready === amber.a && BREAK_INPUTS.has(input);
}

// A snapshot's `amber` field, normalised; null when absent or malformed.
export function snapshotAmber(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const a = Number(raw.a);
  if (raw.a === null || raw.a === undefined || !Number.isFinite(a)) return null;
  const ms = Number(raw.ms);
  const v = raw.v === null || raw.v === undefined ? null : raw.v;
  return { a, ms: Number.isFinite(ms) && ms > 0 ? ms : 0, v };
}

// The server's ms ticked down locally since the frame arrived (`frameAt`), never below 0.
export function amberRemainingMs(amber, frameAt, now) {
  if (!amber) return 0;
  const ms = Number(amber.ms);
  if (!Number.isFinite(ms)) return 0;
  const since = Math.max(0, (Number(now) || 0) - (Number(frameAt) || 0));
  return Math.max(0, ms - since);
}
