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
      // SOMET-326: the launch anchor this blast inherited from its projectile,
      // so a detonation goes off at the height the shot was flying at rather
      // than flat on the ground. Validation lives in attackAnchor.js.
      o: d.o,
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

// THE element palette moved to core/elements.js in SOMET-329, where it is fed
// by the server's `elements` catalog instead of being hardcoded here.
//
// Re-exported rather than relocated at every call site: this module's own
// warning -- that a second palette elsewhere is how a fire projectile and a
// burn tint end up different colours -- applies equally to a second IMPORT
// PATH, and `elementColor` from blasts.js is what the draw loop, the status
// tint and their tests already reach for.
export { elementColor } from "./elements.js";


// SOMET-523. The screen geometry of a player's leech aura, as a pure function.
//
// Split out of RenderSystem so it can be tested without a canvas -- the ring
// is the only thing that tells a Cultist which creatures are feeding them, and
// "it looked right in one screenshot" is not a test.
//
// Returns null when there is nothing to draw. A NULL RETURN IS THE FEATURE:
// Canvas 2D silently DROPS a path with non-finite coordinates -- no error,
// nothing rendered -- so a missing or malformed `aura` reaching ellipse() as
// NaN would delete the draw, and depending on ordering can take the rest of
// the pass with it. Everything is filtered here rather than trusted, and
// ellipse() additionally THROWS on a negative radius (see RenderSystem's own
// note), which would break the whole frame rather than one ring.
export function auraRingGeometry(player, worldToScreen) {
  if (!player) return null;
  const radius = Number(player.aura);
  if (!Number.isFinite(radius) || radius <= 0) return null;
  const cx = Number(player.x);
  const cy = Number(player.y);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const s = worldToScreen(cx, cy);
  if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return null;
  // A world circle projects to a 2:1 ellipse on the iso ground plane, never a
  // circle: stroking a circle here would claim the aura reaches further
  // north/south than it actually leeches.
  const rx = blastScreenRadiusX(radius);
  if (!Number.isFinite(rx) || rx <= 0) return null;
  return { x: s.x, y: s.y, rx, ry: rx / 2 };
}
