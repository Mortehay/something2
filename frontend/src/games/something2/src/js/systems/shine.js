// Procedural 'shine' idle effect for props (Props v2). An approved GPU-box
// prop whose entity type has idle_fx 'shine' gets a soft diagonal glint that
// sweeps across its opaque pixels once per SHINE_PERIOD_MS, taking
// SHINE_SWEEP_MS, and nothing the rest of the time. Pure, no canvas: the
// renderer (RenderSystem._drawShine) asks this whether to draw this frame.

export const SHINE_PERIOD_MS = 4500;
export const SHINE_SWEEP_MS = 600;
// Peak opacity of the glint pass ('lighter' composite) -- kept <= 0.45.
export const SHINE_ALPHA = 0.4;

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
