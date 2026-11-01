// Procedural 'drift' idle effect for props (SOMET-677). An approved GPU-box
// prop whose entity type has idle_fx 'drift' floats a few pixels left/right
// and up/down in slow motion -- a calm alternative to the shine glint. The
// renderer just draws the image at its rect shifted by (driftX, driftY): no
// transform, no offscreen canvas, so it costs what a plain prop costs. Pure.
//
// x and y run on different periods (4:3), tracing a slow Lissajous loop that
// repeats every 15.6 s, so the motion does not read as a mechanical bob.

export const DRIFT_X_PX = 1.5;
export const DRIFT_Y_PX = 1;
export const DRIFT_X_PERIOD_MS = 5200;
export const DRIFT_Y_PERIOD_MS = 3900;

const TWO_PI = Math.PI * 2;

// `phaseSeed` is the 32-bit position hash sway uses (swayPhaseSeed), so
// neighbouring props drift out of step. y takes its phase from the other
// half of the hash, so a prop's x and y are not locked together either.
function wave(timeMs, phaseSeed, periodMs, shift) {
  const t = Number.isFinite(timeMs) ? timeMs : 0;
  const seed = Number.isFinite(phaseSeed) ? phaseSeed >>> 0 : 0;
  const phase = (((seed >>> shift) & 0xffff) / 65536) * TWO_PI;
  return Math.sin(((t % periodMs) / periodMs) * TWO_PI + phase);
}

// Horizontal offset in draw pixels at `timeMs` (|dx| <= DRIFT_X_PX). Always finite.
export function driftX(timeMs, phaseSeed) {
  return DRIFT_X_PX * wave(timeMs, phaseSeed, DRIFT_X_PERIOD_MS, 0);
}

// Vertical offset in draw pixels at `timeMs` (|dy| <= DRIFT_Y_PX). Always finite.
export function driftY(timeMs, phaseSeed) {
  return DRIFT_Y_PX * wave(timeMs, phaseSeed, DRIFT_Y_PERIOD_MS, 16);
}
