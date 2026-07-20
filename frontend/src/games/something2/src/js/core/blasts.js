// AoE detonation ("blast") render store. Pure and canvas-free so the lifetime
// and projection maths are unit-testable under vitest's `node` env.
//
// The server emits detonations on a single tick's `state` frame and never
// repeats them, so the client keeps its own short-lived list and animates each
// entry off its arrival time.

import { ISO_K } from "./iso.js";

// How long a blast ring is drawn for, in ms.
export const BLAST_MS = 250;

// Append this tick's detonations. Each is stamped with its ARRIVAL time (not a
// server timestamp): the ring is a client-side flourish, and arrival time is
// the only clock both ends agree on without clock sync.
export function addBlasts(blasts, detonations, nowMs) {
  if (!Array.isArray(detonations)) return blasts;
  for (const d of detonations) {
    if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
    blasts.push({
      x: d.x,
      y: d.y,
      radius: Number.isFinite(d.radius) ? d.radius : 0,
      element: d.element || null,
      startedAt: nowMs,
    });
  }
  return blasts;
}

// Drop finished blasts. Returns a NEW array (callers reassign) so a blast can
// never be mutated out from under an in-progress draw loop.
export function pruneBlasts(blasts, nowMs, lifetimeMs = BLAST_MS) {
  if (!Array.isArray(blasts) || blasts.length === 0) return blasts || [];
  return blasts.filter((b) => nowMs - b.startedAt < lifetimeMs);
}

// 0 at spawn -> 1 at expiry, clamped. The ring expands from 0 to its full
// radius and fades out over this same 0..1.
export function blastProgress(blast, nowMs, lifetimeMs = BLAST_MS) {
  if (!blast || !(lifetimeMs > 0)) return 1;
  const t = (nowMs - blast.startedAt) / lifetimeMs;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// A world-space circle of radius R projects to an AXIS-ALIGNED ellipse in iso
// screen space, not a circle. Substituting (cx + R·cosθ, cy + R·sinθ) into
// worldToScreen gives
//   x = X0 + R·√2·ISO_K·cos(θ+45°)
//   y = Y0 + R·√2·ISO_K/2·sin(θ+45°)
// i.e. semi-axes (R·√2·ISO_K, half that) — the same 2:1 ratio as a tile
// diamond. Returns the horizontal semi-axis; the vertical one is half of it.
export function blastScreenRadiusX(worldRadius) {
  return (Number.isFinite(worldRadius) ? worldRadius : 0) * Math.SQRT2 * ISO_K;
}

// THE element palette. One function, used by the projectile draw, the blast
// ring, and the status-effect tint (via statusEffects.js) — so a burn reads as
// belonging to the fire bolt that caused it. Adding a second palette elsewhere
// is how a fire projectile and a burn tint end up different colours.
//
// `lightning` deliberately resolves to the same yellow the default already
// was, so this table adds fire and ice without restyling anything that was
// already on screen.
const ELEMENT_COLORS = {
  arcane: "#9b5de5",     // violet
  fire: "#f4763b",       // orange
  ice: "#5bc0f8",        // blue
  lightning: "#f4d35e",  // yellow
};
const DEFAULT_ELEMENT_COLOR = "#f4d35e";

export function elementColor(element) {
  return ELEMENT_COLORS[element] || DEFAULT_ELEMENT_COLOR;
}
