// Procedural 'shine' idle effect for props (Props v2). An approved GPU-box
// prop whose entity type has idle_fx 'shine' gets a soft diagonal glint that
// sweeps across its opaque pixels once per SHINE_PERIOD_MS, taking
// SHINE_SWEEP_MS, and nothing the rest of the time. Pure, no canvas: the
// renderer (RenderSystem._drawShine) asks this whether to draw this frame.

export const SHINE_PERIOD_MS = 4500;
export const SHINE_SWEEP_MS = 600;
// Peak opacity of the glint pass ('lighter' composite) -- kept <= 0.45.
export const SHINE_ALPHA = 0.4;
// Band width as a fraction of the sprite's extent along the sweep diagonal:
// a thin streak, not a sheen over the whole sprite.
export const SHINE_BAND_FRACTION = 0.28;

// null while idle (most frames), else { t } with t in [0, 1): how far the band
// has travelled across the sprite. `phaseSeed` is the same 32-bit position
// hash sway uses (swayPhaseSeed), so neighbouring props glint out of step.
export function shineBand(timeMs, phaseSeed) {
  const t = Number.isFinite(timeMs) ? timeMs : 0;
  const seed = Number.isFinite(phaseSeed) ? phaseSeed >>> 0 : 0;
  const offset = (seed / 4294967296) * SHINE_PERIOD_MS;
  const local = (((t + offset) % SHINE_PERIOD_MS) + SHINE_PERIOD_MS) % SHINE_PERIOD_MS;
  return local < SHINE_SWEEP_MS ? { t: local / SHINE_SWEEP_MS } : null;
}

// The band on a w x h sprite at sweep progress t, along the 45-degree
// diagonal in units of (x+y)/2 (the sprite spans 0..(w+h)/2): centre m and
// half-width half. It starts wholly before the top-left corner (t = 0) and
// ends wholly past the bottom-right (t = 1).
export function shineGeometry(t, w, h) {
  const extent = (w + h) / 2;
  const half = (SHINE_BAND_FRACTION * extent) / 2;
  return { m: -half + t * (extent + 2 * half), half };
}
