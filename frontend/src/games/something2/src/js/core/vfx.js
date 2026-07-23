// Attack-VFX render store. Pure and canvas-free — mirrors core/blasts.js — so
// the lifetime, easing and iso projection maths are unit-testable under
// vitest's `node` environment, with RenderSystem as a thin consumer.
//
// The server emits attacks on a single tick's `state` frame and never repeats
// them, so the client keeps its own short-lived list and animates each entry
// off its ARRIVAL time.

// Used when an effect row carries no usable duration. Matches the column
// default in the vfx_effects migration.
export const DEFAULT_DURATION_MS = 180;

// The effect library, keyed by the name the server sends. Rows without a name
// are unreferenceable, so they are dropped rather than indexed under
// `undefined`.
export function indexEffects(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (r && typeof r.name === "string" && r.name) out[r.name] = r;
  }
  return out;
}

function duration(def) {
  const d = def && Number(def.duration_ms);
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_DURATION_MS;
}

// Append this tick's attacks. Each is stamped with its ARRIVAL time (not a
// server timestamp): arrival is the only clock both ends agree on without
// clock sync, the same reasoning addBlasts documents.
//
// An event whose name is not in the library is DROPPED, not drawn blank: vfx
// bindings are jsonb with no FK, so renaming a vfx_effects row orphans every
// binding pointing at it. That has to degrade to nothing rather than throw
// inside the socket handler.
export function addEffects(list, events, nowMs, defs) {
  if (!Array.isArray(events)) return list;
  for (const e of events) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    const def = e.v && defs ? defs[e.v] : null;
    if (!def) continue;
    let nx = Number.isFinite(e.nx) ? e.nx : 0;
    let ny = Number.isFinite(e.ny) ? e.ny : 0;
    // A zero vector would make atan2 return 0 and point the swing due east.
    // Due south is the same fallback the server's vectorFromFacing uses.
    if (nx === 0 && ny === 0) { nx = 0; ny = 1; }
    list.push({
      def,
      x: e.x, y: e.y,
      nx, ny,
      reach: Number.isFinite(e.reach) ? e.reach : 0,
      arc: Number.isFinite(e.arc) ? e.arc : 0,
      hit: e.hit === true,
      startedAt: nowMs,
    });
  }
  return list;
}

// Drop finished effects. Returns a NEW array (callers reassign) so an effect
// can never be mutated out from under an in-progress draw loop. Compares RAW
// elapsed time, never eased progress — easing is a display curve, and pruning
// off it would make an 'out' effect vanish early.
export function pruneEffects(list, nowMs) {
  if (!Array.isArray(list) || list.length === 0) return list || [];
  return list.filter((fx) => nowMs - fx.startedAt < duration(fx.def));
}

export function ease(t, mode) {
  if (mode === "out") return 1 - (1 - t) * (1 - t);
  if (mode === "in") return t * t;
  return t;                                    // 'linear' and anything unknown
}

// 0 at spawn -> 1 at expiry, clamped, then eased by the effect's own curve.
// This is what the geometry animates along (a wedge sweeping open).
export function effectProgress(fx, nowMs) {
  if (!fx) return 1;
  const d = duration(fx.def);
  const t = (nowMs - fx.startedAt) / d;
  return ease(t < 0 ? 0 : t > 1 ? 1 : t, fx.def && fx.def.ease);
}

// Opacity, on RAW time. Deliberately NOT eased: an eased alpha on a fast 'out'
// effect drops to near-zero almost immediately and the swing reads as a
// flicker rather than a sweep.
export function effectAlpha(fx, nowMs) {
  if (!fx || !fx.def || fx.def.fade === false) return 1;
  const t = (nowMs - fx.startedAt) / duration(fx.def);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - c;
}

// A world direction (nx, ny) as the PARAMETRIC angle of the iso ground-plane
// ellipse.
//
// worldToScreen sends a world circle (R·cosθ, R·sinθ) to
//     x = X0 + R·√2·ISO_K·cos(θ + π/4)
//     y = Y0 + R·√2·ISO_K/2·sin(θ + π/4)
// (the same derivation blastScreenRadiusX documents), and canvas ellipse()
// draws (x + rx·cos φ, y + ry·sin φ). So φ = θ + π/4.
//
// Passing the raw world angle to ellipse() instead points every swing 45° off
// the direction the player aimed.
export function isoArcAngle(nx, ny) {
  return Math.atan2(ny, nx) + Math.PI / 4;
}
