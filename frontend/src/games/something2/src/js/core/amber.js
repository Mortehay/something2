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
  // SOMET-769: a variant the admin set to draw as code has no sheet as far as the game is concerned.
  return row && row.display !== 'code' && typeof row.sprite_image === 'string' && row.sprite_image ? row : null;
}

// True when sealed and the input is a move, an attack, a skill or a ground
// click. It does not wait for ready: moving ends the seal at any time.
export function shouldBreak({ amber, input }) {
  return !!amber && BREAK_INPUTS.has(input);
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

// The orbit around a sealed crystal: points circling its base on a flat 2:1
// isometric ellipse on the ground, so the motion reads as a turn about the
// VERTICAL axis. Relative to the centre (the feet): x right, y down on screen.
// `front` (y > 0, the near / lower half on screen) is drawn after the crystal,
// the far half before it; `depth` is y / ry in [-1, 1] (far -> near).
export const AMBER_ORBIT_PERIOD_MS = 3000;
const ORBIT_TWO_PI = Math.PI * 2;

// A reusable buffer for orbitPoints: allocate once, refill every frame.
export function orbitBuffer(n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { x: 0, y: 0, front: false, depth: 0 };
  return out;
}

// Fills out[0..count) with `count` points evenly spread round the ellipse
// (rx, ry), turning once every AMBER_ORBIT_PERIOD_MS, offset by `phase`
// radians. Returns the count filled. Non-finite inputs collapse to 0.
export function orbitPoints(tMs, count, rx, ry, phase, out) {
  const n = Math.min(count | 0, out.length);
  const t = Number.isFinite(tMs) ? tMs : 0;
  const a = Number.isFinite(rx) ? rx : 0;
  const b = Number.isFinite(ry) ? ry : 0;
  const ph = Number.isFinite(phase) ? phase : 0;
  const base = ((t % AMBER_ORBIT_PERIOD_MS) / AMBER_ORBIT_PERIOD_MS) * ORBIT_TWO_PI + ph;
  for (let i = 0; i < n; i++) {
    const ang = base + (i * ORBIT_TWO_PI) / n;
    const s = Math.sin(ang);
    const p = out[i];
    p.x = a * Math.cos(ang);
    p.y = b * s;
    p.front = p.y > 0;
    p.depth = b > 0 ? p.y / b : 0;
  }
  return n;
}

// A per-arrival orbit phase in [0, 2pi), so neighbouring sealed players do not
// circle in lockstep: golden-ratio steps spread consecutive ids round the ring.
export function amberOrbitPhase(arrivalId) {
  const n = Number(arrivalId);
  if (arrivalId === null || arrivalId === undefined || !Number.isFinite(n)) return 0;
  const f = (n * 0.6180339887498949) % 1;
  return (f < 0 ? f + 1 : f) * ORBIT_TWO_PI;
}
