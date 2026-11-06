// Sprint (hold Shift), the client's half. The SERVER decides (backend world.js:
// _sprintFor); this module is the same rule, so the local player can predict it and
// the reconcile replay can move by it. The numbers are the server's -- a mismatch is
// a rubber-band, which is why they live in one tested place on each side and
// sprint.test.js pins them to the server's exports.
export const SPRINT_MULT = 1.5;
export const SPRINT_DRAIN = 8;     // stamina per second moved
export const SPRINT_START = 10;    // stamina needed to begin
export const SPRINT_UNLOCK = 20;   // after running dry, stamina needed to begin again
const ROOT_BELOW = 0.05;           // a speed multiplier this low is a root

// Should this frame sprint?
//   shift      the key is held          moving   a movement key is held
//   stamina    last known pool          active   we were sprinting last frame
//   locked     the server's lockout flag (cleared by stamina >= SPRINT_UNLOCK)
//   speedMult  the server's slow/aura multiplier for us (a root is ~0)
//   channeling a channelled skill is held   stunned  we are stunned (frame says so)
export function sprintWanted({
  shift, moving, stamina, active = false, locked = false, speedMult = 1, channeling = false, stunned = false,
}) {
  if (!shift || !moving || channeling || stunned) return false;
  if (speedMult > 0 && speedMult < ROOT_BELOW) return false;
  const s = Number.isFinite(stamina) ? stamina : 0;
  if (locked && s < SPRINT_UNLOCK) return false;
  if (!active && s < SPRINT_START) return false;
  return s > 0;
}

// The stamina after `dt` seconds of sprinting (the server's frame overwrites it).
export function drainStamina(stamina, dt) {
  return Math.max(0, stamina - SPRINT_DRAIN * dt);
}

export function speedWithSprint(speed, sprint) {
  return sprint ? speed * SPRINT_MULT : speed;
}
