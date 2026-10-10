import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { AURA_SIDES, AURA_SHAPES, AURA_LIMITS, emptyAuraForm, auraToForm, auraFormToPayload, validateAuraForm } from '../auraForm.js';

const backend = createRequire(import.meta.url)('../../../../../backend/src/services/auraEffects.js');

describe('aura form', () => {
  it('uses the exact vocabulary and limits the API enforces', () => {
    expect(AURA_SIDES).toEqual(backend.AURA_SIDES);
    expect(AURA_SHAPES).toEqual(backend.AURA_SHAPES);
    expect(AURA_LIMITS).toEqual({ ...backend.AURA_LIMITS });
  });
  it('a new form is valid once named, and defaults to a neutral allies ring', () => {
    const f = { ...emptyAuraForm(), name: 'x', radius: '200' };
    expect(validateAuraForm(f)).toBeNull();
    const p = auraFormToPayload(f);
    expect(p).toMatchObject({ target_side: 'allies', radius: 200, damage_mult: 1, defense_mult: 1, speed_mult: 1, dot_dps: 0, shape: 'ring' });
    expect(backend.auraEffectError(p)).toBeNull();
  });
  it.each([
    [{ radius: '0' }, /Radius/], [{ radius: '-5' }, /Radius/], [{ radius: '' }, /Radius/],
    [{ radius: '26000' }, /Radius/], [{ damage_mult: '0' }, /Damage/], [{ tick_ms: '50' }, /Tick/],
    [{ target_side: 'enemies', dot_dps: '-1' }, /DoT/], [{ particle_count: '65' }, /Particles/], [{ color: 'gold' }, /Colour/],
  ])('rejects %j before a round trip', (over, re) => {
    expect(validateAuraForm({ ...emptyAuraForm(), name: 'x', radius: '200', ...over })).toMatch(re);
  });
  it('switching enemies -> allies drops a leftover DoT: valid, and the payload sends dot_dps 0', () => {
    const f = { ...emptyAuraForm(), name: 'x', target_side: 'enemies', dot_dps: '5' };
    expect(validateAuraForm(f)).toBeNull();
    expect(auraFormToPayload(f).dot_dps).toBe(5);
    const allies = { ...f, target_side: 'allies' };
    expect(validateAuraForm(allies)).toBeNull();
    expect(auraFormToPayload(allies).dot_dps).toBe(0);
  });
  it('round-trips a stored row, including a genuine 0 dps and pulse 0', () => {
    const row = { id: 1, name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25, defense_mult: 1.2,
      speed_mult: 1.1, dot_dps: 0, dot_element: 'physical', tick_ms: 1000, shape: 'ring', color: '#d4a017', pulse_ms: 0,
      particle_count: 0, particle_spread: 6.283, particle_speed: 100, particle_gravity: 0, particle_lifetime_ms: 300, particle_size: 2 };
    const p = auraFormToPayload(auraToForm(row));
    expect(p.radius).toBe(260);
    expect(p.damage_mult).toBe(1.25);
    expect(p.pulse_ms).toBe(0);
  });
});
