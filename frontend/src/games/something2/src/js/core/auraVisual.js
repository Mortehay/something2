// SOMET-604. Pure aura visual maths. The admin preview uses it now; S5's
// in-game renderer MUST import the same functions, so the author tunes
// against what the game draws (the vfxPreview rule).
export function auraPulse(def, ms) {
  const period = Number(def.pulse_ms) || 0;
  if (period <= 0) return { scale: 1, alpha: 0.35 };
  const phase = (ms % period) / period;                   // 0..1
  const wave = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI); // 0 at 0 and 1, 1 at 0.5
  return { scale: 0.9 + 0.1 * wave, alpha: 0.25 + 0.2 * wave };
}
export function auraParticleFx(def, ms) {
  const life = Number(def.particle_lifetime_ms) || 300;
  return { fx: { def, x: 0, y: 0, nx: 1, ny: 0, startedAt: Math.floor(ms / life) * life }, t: (ms % life) / life };
}
