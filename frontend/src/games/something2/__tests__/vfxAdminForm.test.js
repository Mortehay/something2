import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptyVfxForm, vfxToForm, vfxFormToPayload, validateVfxForm, VFX_SHAPES, MAX_PARTICLE_COUNT,
} from '../vfxForm.js';
import { buildPayload, formFromType, emptyForm, VFX_MOMENTS } from '../itemTypeForm.js';

// Slice E (SOMET-162): the admin form's half of the contract.
describe('vfx effect form', () => {
  it('round-trips an effect through form and back to a payload', () => {
    const row = {
      id: 3, name: 'sweep_arc', shape: 'arc', color: '#ff0000', width: 3, duration_ms: 240,
      ease: 'in', fade: false, follows_weapon: true,
      particle_count: 8, particle_spread: 1.2, particle_speed: 90,
      particle_gravity: 25, particle_lifetime_ms: 280, particle_size: 3,
    };
    const payload = vfxFormToPayload(vfxToForm(row));
    for (const k of Object.keys(row)) {
      if (k === 'id') continue;
      expect(payload[k], k).toEqual(row[k]);
    }
  });

  // emptyVfxForm() starts with a blank name on purpose (a new effect is
  // unnamed), so every other check has to be exercised against a form that
  // already has one -- otherwise each case just re-asserts the name rule.
  const named = (over = {}) => ({ ...emptyVfxForm(), name: 'zz_test', ...over });

  it('rejects what the database would reject, before the round trip', () => {
    // The DB CHECK is the backstop; a raw constraint violation reaches the
    // admin as a 500 with a Postgres string in it.
    expect(validateVfxForm(named({ name: '' }))).toMatch(/Name/);
    expect(validateVfxForm(named({ shape: 'hologram' }))).toMatch(/shape/);
    expect(validateVfxForm(named({ ease: 'bouncy' }))).toMatch(/ease/);
    expect(validateVfxForm(named({ particle_count: '9999' }))).toMatch(/between 0 and/);
    expect(validateVfxForm(named({ particle_count: '2.5' }))).toMatch(/whole number/);
    expect(validateVfxForm(named({ particle_lifetime_ms: '0' }))).toMatch(/life/i);
    expect(validateVfxForm(named({ duration_ms: '0' }))).toMatch(/Duration/);
    expect(validateVfxForm(named())).toBe(null);
  });

  it('accepts the ceiling exactly, and refuses one past it', () => {
    expect(validateVfxForm(named({ particle_count: String(MAX_PARTICLE_COUNT) }))).toBe(null);
    expect(validateVfxForm(named({ particle_count: String(MAX_PARTICLE_COUNT + 1) }))).not.toBe(null);
  });

  it('offers exactly the shapes the renderer draws', () => {
    // A shape the editor offers but the renderer skips would save fine and
    // then draw nothing.
    const render = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/js/systems/RenderSystem.js'), 'utf8',
    );
    for (const shape of VFX_SHAPES) expect(render).toContain(`"${shape}"`);
  });
});

describe('weapon binding dropdowns', () => {
  it('carries bindings out of a stored type and back into a payload', () => {
    // Without this the dropdown is inert: it would render the stored value,
    // and saving would drop it.
    const t = {
      name: 'halberd', category: 'weapon', kind: 'melee', reach: 190, arc_width: 1.8,
      vfx: { attack: 'slash_heavy', miss: 'generic_whiff' },
    };
    expect(formFromType(t).vfx).toEqual({ attack: 'slash_heavy', miss: 'generic_whiff' });
    expect(buildPayload(formFromType(t)).vfx).toEqual({ attack: 'slash_heavy', miss: 'generic_whiff' });
  });

  it('drops an empty selection instead of storing ""', () => {
    // An empty string resolves to nothing and would silently defeat the
    // kind-level fallback that keeps an unbound weapon visible.
    const f = { ...emptyForm(), name: 'x', vfx: { attack: 'slash_light', miss: '' } };
    expect(buildPayload(f).vfx).toEqual({ attack: 'slash_light' });
  });

  it('sends a vfx key on every category, so a category switch cannot strand bindings', () => {
    for (const category of ['weapon', 'armor', 'ammo']) {
      const f = { ...emptyForm(), name: 'x', category, slot: 'chest', defense: 1, stackable: true };
      expect(buildPayload(f).vfx, category).toBeDefined();
    }
  });

  it('offers miss only for melee and trail only for projectiles', () => {
    // A projectile cannot whiff at the moment of firing; a melee swing has no
    // trail. Offering either would invite dead data.
    const miss = VFX_MOMENTS.find(m => m.key === 'miss');
    const trail = VFX_MOMENTS.find(m => m.key === 'trail');
    expect(miss.appliesTo).toBe('melee');
    expect(trail.appliesTo).toBe('projectile');
    expect(VFX_MOMENTS.find(m => m.key === 'attack').appliesTo).toBe('any');
  });
});
