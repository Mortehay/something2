import { describe, it, expect } from 'vitest';
import { particlesAt, capParticles, effectSeed, MAX_LIVE_PARTICLES } from '../vfx.js';

// Slice C (SOMET-160): particle determinism and the live cap. Both are named
// in the item as required tests, and both are things a screenshot cannot show.
const fx = (over = {}) => ({
  x: 100, y: 200, nx: 1, ny: 0, startedAt: 5000,
  ...over,
  def: {
    shape: 'burst', color: '#fff', duration_ms: 300,
    particle_count: 10, particle_spread: 6.283, particle_speed: 100,
    particle_gravity: 40, particle_lifetime_ms: 300, particle_size: 2,
    ...(over.def || {}),
  },
});

describe('particle determinism', () => {
  it('same effect and same progress -> identical positions', () => {
    // The whole reason particlesAt is a pure function of a seed rather than
    // calling Math.random() in the draw loop: a random call there would make
    // the same effect jitter every frame AND differ between two clients
    // watching the same fight.
    expect(particlesAt(fx(), 0.4)).toEqual(particlesAt(fx(), 0.4));
  });

  it('is stable across repeated calls at the same instant', () => {
    const e = fx();
    const a = particlesAt(e, 0.25);
    const b = particlesAt(e, 0.25);
    const c = particlesAt(e, 0.25);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('two effects at different places/times differ', () => {
    // A shared seed would make every simultaneous impact draw the identical
    // spray, which reads as a rendering bug rather than as many hits.
    const a = particlesAt(fx({ x: 100, startedAt: 5000 }), 0.5);
    const b = particlesAt(fx({ x: 400, startedAt: 5000 }), 0.5);
    expect(a).not.toEqual(b);
    expect(effectSeed(fx({ x: 100 }))).not.toBe(effectSeed(fx({ x: 400 })));
  });

  it('advances with progress and fades', () => {
    const e = fx();
    const early = particlesAt(e, 0.1);
    const late = particlesAt(e, 0.9);
    expect(Math.hypot(late[0].dx, late[0].dy)).toBeGreaterThan(Math.hypot(early[0].dx, early[0].dy));
    expect(late[0].alpha).toBeLessThan(early[0].alpha);
  });

  it('gravity pulls DOWN (+y is down in world space)', () => {
    const heavy = particlesAt(fx({ def: { particle_gravity: 500, particle_speed: 0 } }), 1);
    expect(heavy[0].dy).toBeGreaterThan(0);
    const floaty = particlesAt(fx({ def: { particle_gravity: -500, particle_speed: 0 } }), 1);
    expect(floaty[0].dy).toBeLessThan(0);
  });

  it('an effect with no particles yields an empty array, not a crash', () => {
    expect(particlesAt(fx({ def: { particle_count: 0 } }), 0.5)).toEqual([]);
    expect(particlesAt(fx({ def: { particle_count: undefined } }), 0.5)).toEqual([]);
    expect(particlesAt(null, 0.5)).toEqual([]);
  });

  it('clamps progress rather than extrapolating past the lifetime', () => {
    const e = fx();
    expect(particlesAt(e, 1)).toEqual(particlesAt(e, 5));
    expect(particlesAt(e, 0)).toEqual(particlesAt(e, -3));
  });
});

describe('live particle cap', () => {
  const burst = (n, i) => fx({ startedAt: 1000 + i, def: { particle_count: n } });

  it('leaves a list under budget untouched', () => {
    const list = [burst(10, 1), burst(10, 2)];
    expect(capParticles(list).length).toBe(2);
  });

  it('enforces the budget under a burst of simultaneous impacts', () => {
    // 60 effects x 64 particles = 3840, an order of magnitude over budget --
    // the crowded-fight case the design flags as the real risk.
    const list = Array.from({ length: 60 }, (_, i) => burst(64, i));
    const capped = capParticles(list);
    const total = capped.reduce((n, e) => n + e.def.particle_count, 0);
    expect(total).toBeLessThanOrEqual(MAX_LIVE_PARTICLES);
    expect(capped.length).toBeGreaterThan(0);
  });

  it('evicts OLDEST first, keeping what the player is looking at', () => {
    const list = Array.from({ length: 10 }, (_, i) => burst(64, i));
    const capped = capParticles(list);
    // The newest (highest startedAt) must survive; the oldest must not.
    const times = capped.map((e) => e.startedAt);
    expect(Math.max(...times)).toBe(1009);
    expect(times).not.toContain(1000);
  });

  it('returns a NEW array so a draw loop is never mutated mid-iteration', () => {
    const list = [burst(10, 1)];
    expect(capParticles(list)).not.toBe(list);
    const over = Array.from({ length: 60 }, (_, i) => burst(64, i));
    capParticles(over);
    expect(over.length).toBe(60);
  });

  it('keeps particle-free effects, which cost nothing', () => {
    const geometry = fx({ def: { particle_count: 0 } });
    const list = [...Array.from({ length: 60 }, (_, i) => burst(64, i)), geometry];
    expect(capParticles(list)).toContain(geometry);
  });
});
