import { describe, it, expect } from 'vitest';
import {
  emptyVfxForm, vfxToForm, vfxFormToPayload, validateVfxForm, validateSpriteFile, spriteSheetHint,
  MAX_SPRITE_FRAMES, MAX_SPRITE_BYTES,
} from '../vfxForm.js';

describe('vfx form: sprite fields', () => {
  it('a new effect has no sprite', () => {
    const f = emptyVfxForm();
    expect(f.sprite_image).toBe('');
    expect(vfxFormToPayload({ ...f, name: 'x' })).toMatchObject({
      sprite_image: null, sprite_frames: 1, sprite_size: 0, sprite_additive: false,
    });
  });

  it('round-trips a stored sprite through the form', () => {
    const row = { name: 'a', shape: 'ring', sprite_image: 'vfx/x.png', sprite_frames: 8, sprite_size: 320, sprite_additive: true };
    const form = vfxToForm(row);
    expect(form).toMatchObject({ sprite_image: 'vfx/x.png', sprite_frames: '8', sprite_size: '320', sprite_additive: true });
    expect(vfxFormToPayload(form)).toMatchObject({ sprite_image: 'vfx/x.png', sprite_frames: 8, sprite_size: 320, sprite_additive: true });
  });

  it('an old row without sprite columns loads as "no sprite"', () => {
    expect(vfxToForm({ name: 'old', shape: 'arc' })).toMatchObject({ sprite_image: '', sprite_frames: '1', sprite_size: '0' });
  });

  it('validates frames and size', () => {
    const ok = { ...emptyVfxForm(), name: 'x' };
    expect(validateVfxForm(ok)).toBeNull();
    expect(validateVfxForm({ ...ok, sprite_frames: '0' })).toMatch(/frames/);
    expect(validateVfxForm({ ...ok, sprite_frames: '2.5' })).toMatch(/frames/);
    expect(validateVfxForm({ ...ok, sprite_frames: String(MAX_SPRITE_FRAMES + 1) })).toMatch(/frames/);
    expect(validateVfxForm({ ...ok, sprite_size: '-1' })).toMatch(/size/i);
    expect(validateVfxForm({ ...ok, sprite_size: '5000' })).toMatch(/size/i);
    expect(validateVfxForm({ ...ok, sprite_frames: '12', sprite_size: '400' })).toBeNull();
  });
});

describe('sprite file checks', () => {
  it('accepts a small PNG and refuses everything else with a reason', () => {
    expect(validateSpriteFile({ type: 'image/png', size: 1000 })).toBeNull();
    expect(validateSpriteFile(null)).toMatch(/PNG/);
    expect(validateSpriteFile({ type: 'image/jpeg', size: 1000 })).toMatch(/PNG/);
    expect(validateSpriteFile({ type: 'image/png', size: MAX_SPRITE_BYTES + 1 })).toMatch(/KB/);
  });

  it('spriteSheetHint says how the strip is cut', () => {
    expect(spriteSheetHint(256, 64, 4)).toBe('4 frames of 64x64px');
    expect(spriteSheetHint(64, 64, 1)).toBe('1 frame of 64x64px');
    expect(spriteSheetHint(10, 5, 3)).toMatch(/last 1px/);
    expect(spriteSheetHint(3, 5, 8)).toMatch(/cannot hold 8 frames/);
    expect(spriteSheetHint(0, 0, 4)).toBeNull();
  });
});
