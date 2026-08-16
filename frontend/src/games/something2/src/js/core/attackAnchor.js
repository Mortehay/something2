// SOMET-326. The vertical anchor every attack visual is drawn at: how far ABOVE
// the projected ground point a swing, a shot, a blast, a trail or an impact
// spark sits, in screen pixels.
//
// One function, used by all of them. Before this slice the same expression --
// `s.y - ISO_TILE_H / 2` -- was written out at TEN separate sites in
// RenderSystem, which is how they came to disagree with the actors they belong
// to: half a TILE is 50% of a 64px player but 67% of a 48px creature, so a
// creature's attacks and every hit spark landing on one drew at its neck.
//
// The number is resolved SERVER-side (authority/attackOrigin.js) from the
// actor's own body height and the weapon's authored origin, and arrives on the
// frame as `o`. It is not recomputed here: a projectile in flight has no actor
// to measure, and its shooter may already be dead or out of view.

import { ISO_TILE_H } from "./constants.js";

// What an attack lifts by when the frame carries no anchor. Deliberately the
// exact constant this slice retired, so a frame from a server that predates
// SOMET-326 -- or any descriptor that somehow reaches here without one --
// draws precisely where it always did rather than dropping to the ground.
export const LEGACY_ATTACK_LIFT = ISO_TILE_H / 2;

// Negative lifts are rejected rather than clamped to 0: 0 is `feet`, a real
// authored origin, so silently coercing junk into it would look like a
// deliberate choice instead of a bug. The legacy default is the safer answer.
//
// The typeof gate is load-bearing and was added because the test below caught
// its absence: `Number(null)` and `Number('')` are both 0, which is finite and
// non-negative, so a Number()-first version accepted a MISSING anchor as a
// valid `feet` and put every such attack on the ground. `o` crosses the wire
// as a JSON number, so demanding one costs nothing.
export function attackLift(o) {
  if (typeof o !== "number") return LEGACY_ATTACK_LIFT;
  return Number.isFinite(o) && o >= 0 ? o : LEGACY_ATTACK_LIFT;
}

// The drawing y for a point already projected by worldToScreen. Screen y grows
// downward, so lifting is a subtraction.
export function anchorY(screenY, o) {
  return screenY - attackLift(o);
}
