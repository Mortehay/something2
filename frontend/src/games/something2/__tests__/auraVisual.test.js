import { describe, it, expect } from 'vitest';
import { auraPulse, auraParticleFx } from '../src/js/core/auraVisual.js';

describe('aura pulse', () => {
  it('pulse_ms 0 is a steady aura', () => {
    expect(auraPulse({ pulse_ms: 0 }, 123)).toEqual({ scale: 1, alpha: 0.35 });
  });
  it('breathes between 0.9 and 1.0 of the radius over one period', () => {
    const def = { pulse_ms: 1000 };
    expect(auraPulse(def, 0).scale).toBeCloseTo(0.9, 6);
    expect(auraPulse(def, 500).scale).toBeCloseTo(1.0, 6);
    expect(auraPulse(def, 1000).scale).toBeCloseTo(0.9, 6);
  });
  it('particle fx loops over the particle lifetime and is deterministic', () => {
    const def = { particle_lifetime_ms: 400 };
    expect(auraParticleFx(def, 900)).toEqual(auraParticleFx(def, 900));
    expect(auraParticleFx(def, 900).t).toBeCloseTo(0.25, 6); // (900 % 400) / 400
  });
});
