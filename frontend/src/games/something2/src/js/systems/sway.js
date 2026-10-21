// Procedural wind sway for props (Props v2). An approved GPU-box prop is ONE
// clean static image; when its entity type has `sway`, RenderSystem shears it
// horizontally about its base: x' = x + k * (y - baseY). Pure, no canvas.

export const SWAY_AMPLITUDE = 0.035;
export const SWAY_PERIOD_MS = 2800;

const TWO_PI = Math.PI * 2;

// A stable 32-bit hash of a world position, so every prop keeps its own phase
// frame to frame and neighbouring props sway out of step.
export function swayPhaseSeed(x, y) {
  let h = Math.imul((Math.round(Number(x)) || 0) | 0, 0x27d4eb2d) ^ Math.imul((Math.round(Number(y)) || 0) | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// The horizontal shear k at `timeMs` for a prop with `phaseSeed`
// (|k| <= SWAY_AMPLITUDE). Always finite: Canvas 2D silently ignores a
// transform with a non-finite entry.
export function swayShear(timeMs, phaseSeed) {
  const t = Number.isFinite(timeMs) ? timeMs : 0;
  const seed = Number.isFinite(phaseSeed) ? phaseSeed >>> 0 : 0;
  const phase = (seed / 4294967296) * TWO_PI;
  return SWAY_AMPLITUDE * Math.sin(((t % SWAY_PERIOD_MS) / SWAY_PERIOD_MS) * TWO_PI + phase);
}
