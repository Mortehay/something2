import { describe, it, expect } from 'vitest';
import {
  emptyVfxForm, vfxToForm, vfxFormToPayload, validateVfxForm, validateSpriteFile, spriteSheetHint,
  touchSprite, clearedSpriteForm, MAX_SPRITE_FRAMES, MAX_SPRITE_BYTES,
} from '../vfxForm.js';

describe('vfx form: sprite fields', () => {
  it('a new effect has no sprite', () => {
    const f = emptyVfxForm();
    expect(f.sprite_image).toBe('');
    expect(f.sprite_touched).toBe(false);
    const p = vfxFormToPayload({ ...f, name: 'x' });
    expect(Object.keys(p).filter(k => k.startsWith('sprite_'))).toEqual([]);
  });

  it('round-trips a stored sprite through the form', () => {
    const row = { name: 'a', shape: 'ring', sprite_image: 'vfx/x.png', sprite_frames: 8, sprite_size: 320, sprite_additive: true };
    const form = vfxToForm(row);
    expect(form).toMatchObject({ sprite_image: 'vfx/x.png', sprite_frames: '8', sprite_size: '320', sprite_additive: true });
    expect(form.sprite_touched).toBe(false);
    expect(vfxFormToPayload(touchSprite(form))).toMatchObject({ sprite_image: 'vfx/x.png', sprite_frames: 8, sprite_size: 320, sprite_additive: true });
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

  it('vfxToForm -> vfxFormToPayload round-trips sprite_loop, sprite_fps and sprite_stretch', () => {
    const form = vfxToForm({ name: 'a', shape: 'bolt', sprite_loop: true, sprite_fps: 12, sprite_stretch: true });
    expect(form).toMatchObject({ sprite_loop: true, sprite_fps: '12', sprite_stretch: true });
    expect(vfxFormToPayload(touchSprite(form))).toMatchObject({ sprite_loop: true, sprite_fps: 12, sprite_stretch: true });
  });

  it('empty fps becomes null; a new effect defaults to no loop, no fps, no stretch', () => {
    const f = emptyVfxForm();
    expect(f).toMatchObject({ sprite_loop: false, sprite_fps: '', sprite_stretch: false });
    expect(vfxFormToPayload(touchSprite({ ...f, name: 'x' }))).toMatchObject({ sprite_loop: false, sprite_fps: null, sprite_stretch: false });
    expect(vfxToForm({ name: 'old', shape: 'arc', sprite_fps: null })).toMatchObject({ sprite_fps: '' });
  });
});

// The approved-sprite revert: a card opened before an effect sprite was approved holds a stale
// snapshot. Saving an unrelated field must send NO sprite key -- the API reads a missing
// sprite_image as "leave all seven sprite columns alone".
describe('vfx form: sprite_touched omit-key rule', () => {
  const stored = { name: 'a', shape: 'ring', sprite_image: 'vfx/x.png', sprite_frames: 8, sprite_size: 320,
    sprite_additive: true, sprite_loop: true, sprite_fps: 12, sprite_stretch: true };
  const spriteKeys = (p) => Object.keys(p).filter(k => k.startsWith('sprite_')).sort();
  const ALL = ['sprite_additive', 'sprite_fps', 'sprite_frames', 'sprite_image', 'sprite_loop', 'sprite_size', 'sprite_stretch'];

  it('an untouched form sends no sprite_* keys, even with a sprite or after other edits', () => {
    expect(spriteKeys(vfxFormToPayload(vfxToForm(stored)))).toEqual([]);
    expect(spriteKeys(vfxFormToPayload({ ...vfxToForm(stored), width: '9', color: '#000000' }))).toEqual([]);
    expect(spriteKeys(vfxFormToPayload({ ...vfxToForm({ name: 'b', shape: 'arc' }) }))).toEqual([]);
    expect(vfxFormToPayload(vfxToForm(stored))).not.toHaveProperty('sprite_image');
  });

  it('a pick (touch with no change) sends all seven sprite keys', () => {
    const p = vfxFormToPayload(touchSprite(vfxToForm(stored)));
    expect(spriteKeys(p)).toEqual(ALL);
    expect(p).toMatchObject({ sprite_image: 'vfx/x.png', sprite_loop: true, sprite_fps: 12, sprite_stretch: true });
  });

  it('a frames edit sends the sprite keys with the new frames', () => {
    const p = vfxFormToPayload(touchSprite(vfxToForm(stored), { sprite_frames: '4' }));
    expect(spriteKeys(p)).toEqual(ALL);
    expect(p.sprite_frames).toBe(4);
  });

  it("clear sends sprite_image '' (never null) with every sprite field reset", () => {
    const f = clearedSpriteForm(vfxToForm(stored));
    expect(f.sprite_touched).toBe(true);
    expect(vfxFormToPayload(f)).toMatchObject({ sprite_image: '', sprite_frames: 1, sprite_size: 0,
      sprite_additive: false, sprite_loop: false, sprite_fps: null, sprite_stretch: false });
  });
});
