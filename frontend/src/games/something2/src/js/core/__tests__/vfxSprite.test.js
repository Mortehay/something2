import { describe, it, expect } from 'vitest';
import {
  spriteKey, spriteFrameCount, spriteFrameAt, spriteSourceRect, spriteWorldSize, spriteLayout,
} from '../vfx.js';
import { telegraphsFromFrame } from '../worldTelegraphs.js';

describe('sprite sheet helpers', () => {
  it('spriteKey names the image only for a real asset key', () => {
    expect(spriteKey({ sprite_image: 'vfx/a.png' })).toBe('vfx:vfx/a.png');
    expect(spriteKey({ sprite_image: '' })).toBeNull();
    expect(spriteKey({ sprite_image: null })).toBeNull();
    expect(spriteKey({})).toBeNull();
    expect(spriteKey(null)).toBeNull();
  });

  it('spriteFrameCount is at least 1 and at most 64', () => {
    expect(spriteFrameCount({ sprite_frames: 8 })).toBe(8);
    expect(spriteFrameCount({ sprite_frames: 0 })).toBe(1);
    expect(spriteFrameCount({ sprite_frames: -3 })).toBe(1);
    expect(spriteFrameCount({ sprite_frames: 'x' })).toBe(1);
    expect(spriteFrameCount({ sprite_frames: 1000 })).toBe(64);
    expect(spriteFrameCount(undefined)).toBe(1);
  });

  it('spriteFrameAt plays the strip once and holds the last frame', () => {
    const def = { sprite_frames: 4 };
    expect(spriteFrameAt(def, 0)).toBe(0);
    expect(spriteFrameAt(def, 0.26)).toBe(1);
    expect(spriteFrameAt(def, 0.5)).toBe(2);
    expect(spriteFrameAt(def, 0.99)).toBe(3);
    expect(spriteFrameAt(def, 1)).toBe(3);
    expect(spriteFrameAt(def, 7)).toBe(3);
    expect(spriteFrameAt(def, -1)).toBe(0);
    expect(spriteFrameAt(def, NaN)).toBe(0);
    expect(spriteFrameAt({ sprite_frames: 1 }, 0.9)).toBe(0);
  });

  it('spriteSourceRect cuts whole-pixel frames and clamps the index', () => {
    expect(spriteSourceRect(256, 64, 4, 0)).toEqual({ sx: 0, sy: 0, sw: 64, sh: 64 });
    expect(spriteSourceRect(256, 64, 4, 3)).toEqual({ sx: 192, sy: 0, sw: 64, sh: 64 });
    expect(spriteSourceRect(256, 64, 4, 9)).toEqual({ sx: 192, sy: 0, sw: 64, sh: 64 });
    // 10 px into 3 frames: 3 px each, the spare pixel is dropped rather than bled in.
    expect(spriteSourceRect(10, 5, 3, 2)).toEqual({ sx: 6, sy: 0, sw: 3, sh: 5 });
    expect(spriteSourceRect(100, 50, 0, 0)).toEqual({ sx: 0, sy: 0, sw: 100, sh: 50 });
  });

  it('spriteWorldSize: the effect own size, else the reach across, else a default', () => {
    expect(spriteWorldSize({ sprite_size: 300 }, 50)).toBe(300);
    expect(spriteWorldSize({ sprite_size: 0 }, 150)).toBe(300);
    expect(spriteWorldSize({}, 0)).toBe(64);
    expect(spriteWorldSize({}, null)).toBe(64);
    expect(spriteWorldSize(null, NaN)).toBe(64);
  });

  it('spriteLayout: rings lie on the ground, strips run along the aim, the rest stand up', () => {
    expect(spriteLayout('ring')).toBe('ground');
    for (const s of ['line', 'bolt', 'arc']) expect(spriteLayout(s)).toBe('along');
    for (const s of ['burst', 'block', 'unknown']) expect(spriteLayout(s)).toBe('billboard');
  });
});

describe('telegraph frames carry the safe middle of a ring', () => {
  const base = { creatureId: 'c1', skill: 'Lava Ring', x: 10, y: 20, radius: 300, ms: 500, telegraphMs: 1400 };
  it('keeps a valid inner radius', () => {
    expect(telegraphsFromFrame({ telegraphs: [{ ...base, inner: 110 }] })[0].inner).toBe(110);
  });
  it('drops an inner radius that is not smaller than the radius, or not positive', () => {
    expect(telegraphsFromFrame({ telegraphs: [{ ...base, inner: 300 }] })[0].inner).toBeUndefined();
    expect(telegraphsFromFrame({ telegraphs: [{ ...base, inner: 0 }] })[0].inner).toBeUndefined();
    expect(telegraphsFromFrame({ telegraphs: [{ ...base, inner: 'x' }] })[0].inner).toBeUndefined();
    expect(telegraphsFromFrame({ telegraphs: [base] })[0].inner).toBeUndefined();
  });
});
