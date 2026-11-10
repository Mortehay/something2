import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { AURA_SIDES, AURA_SHAPES, AURA_LIMITS, emptyAuraForm, auraToForm, auraFormToPayload, validateAuraForm, touchSprite, clearedSpriteForm } from '../auraForm.js';

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
    [{ target_side: 'enemies', dot_dps: '-1' }, /DoT/],
    [{ target_side: 'enemies', dot_dps: 'Infinity' }, /DoT/],
    [{ target_side: 'enemies', damage_mult: '1.1' }, /Damage/], [{ target_side: 'enemies', defense_mult: '1.1' }, /Defense/],
    [{ target_side: 'enemies', speed_mult: '1.1' }, /Speed/], [{ target_side: 'enemies', speed_mult: '0' }, /Speed/], [{ particle_count: '65' }, /Particles/], [{ color: 'gold' }, /Colour/],
  ])('rejects %j before a round trip', (over, re) => {
    expect(validateAuraForm({ ...emptyAuraForm(), name: 'x', radius: '200', ...over })).toMatch(re);
  });
  it('the form and the API agree on enemies mults: 1 and 0.5 pass, above 1 fails, allies may exceed 1', () => {
    for (const [side, v, ok] of [['enemies', '1', true], ['enemies', '0.5', true], ['enemies', '1.1', false], ['allies', '1.5', true]]) {
      const f = { ...emptyAuraForm(), name: 'x', radius: '200', target_side: side, speed_mult: v };
      expect(validateAuraForm(f) === null).toBe(ok);
      expect(backend.auraEffectError(auraFormToPayload(f)) === null).toBe(ok);
    }
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

describe('aura form sprite fields', () => {
  const base = { ...emptyAuraForm(), name: 'x', radius: '200' };
  it('an untouched form has no sprite keys at all (a null/blank would CLEAR the stored sprite)', () => {
    const p = auraFormToPayload(base);
    expect('sprite_image' in p).toBe(false);
    const stored = auraToForm({ name: 'x', radius: 200, sprite_image: 'vfx/a.png', sprite_frames: 4, sprite_additive: true, sprite_fps: 8 });
    const sp = auraFormToPayload(stored);
    expect(Object.keys(sp).filter(k => k.startsWith('sprite_'))).toEqual([]);
  });
  it('auraToForm carries the stored sprite columns', () => {
    const f = auraToForm({ name: 'x', radius: 200, sprite_image: 'vfx/a.png', sprite_frames: 4, sprite_additive: true, sprite_fps: 8 });
    expect(f).toMatchObject({ sprite_image: 'vfx/a.png', sprite_frames: '4', sprite_additive: true, sprite_fps: '8', sprite_touched: false });
    expect(auraToForm({ name: 'x' })).toMatchObject({ sprite_image: '', sprite_frames: '1', sprite_additive: false, sprite_fps: '' });
  });
  it('picking a sprite sends all four columns', () => {
    const f = touchSprite({ ...base, sprite_image: 'vfx/a.png', sprite_frames: '4', sprite_additive: true, sprite_fps: '12' });
    expect(auraFormToPayload(f)).toMatchObject({ sprite_image: 'vfx/a.png', sprite_frames: 4, sprite_additive: true, sprite_fps: 12 });
  });
  it('clearing sends sprite_image "" (not null) with reset columns', () => {
    const f = clearedSpriteForm({ ...auraToForm({ name: 'x', radius: 200, sprite_image: 'vfx/a.png', sprite_frames: 4 }) });
    const p = auraFormToPayload(f);
    expect(p.sprite_image).toBe('');
    expect(p).toMatchObject({ sprite_frames: 1, sprite_additive: false, sprite_fps: null });
    expect(validateAuraForm(f)).toBeNull();
  });
  it('editing frames alone on a stored sprite still sends the key, so the API applies it', () => {
    const f = touchSprite(auraToForm({ name: 'x', radius: 200, sprite_image: 'vfx/a.png' }), { sprite_frames: '6' });
    expect(auraFormToPayload(f)).toMatchObject({ sprite_image: 'vfx/a.png', sprite_frames: 6 });
  });
  it.each([[{ sprite_frames: '0' }], [{ sprite_frames: '65' }], [{ sprite_frames: '1.5' }], [{ sprite_frames: '' }],
    [{ sprite_fps: '0' }], [{ sprite_fps: '61' }]])('rejects %j on a sprite', (over) => {
    expect(validateAuraForm(touchSprite({ ...base, sprite_image: 'vfx/a.png' }, over))).toMatch(/Sprite/);
  });
});
