import { describe, it, expect } from 'vitest';
import { drawVfxPreview } from '../vfxPreview.js';
import { vfxSpriteFilter } from '../vfxForm.js';

// A recording fake ctx: every method call is logged by name, with globalAlpha at call time.
function fakeCtx() {
  const calls = [];
  const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
  for (const m of ['clearRect', 'save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'arc', 'stroke', 'fillRect', 'drawImage']) {
    ctx[m] = () => { calls.push({ name: m, alpha: ctx.globalAlpha }); };
  }
  return { ctx, calls };
}
const image = { naturalWidth: 128, naturalHeight: 32 };
const def = { shape: 'ring', duration_ms: 200, ease: 'linear', fade: false, color: '#ff0000', width: 2, sprite_frames: 4 };

describe('drawVfxPreview reference mode', () => {
  it('draws the vector shape (faint) AND the sprite', () => {
    const { ctx, calls } = fakeCtx();
    drawVfxPreview(ctx, 220, 160, def, 100, image, { reference: true });
    const strokes = calls.filter(c => c.name === 'stroke');
    const images = calls.filter(c => c.name === 'drawImage');
    expect(strokes.length).toBeGreaterThan(0);
    expect(images.length).toBe(1);
    expect(strokes[0].alpha).toBeCloseTo(0.35);
    expect(images[0].alpha).toBe(1);
  });

  it('default mode with a sprite: sprite only, vector stands down (unchanged)', () => {
    const { ctx, calls } = fakeCtx();
    drawVfxPreview(ctx, 220, 160, def, 100, image);
    expect(calls.some(c => c.name === 'stroke')).toBe(false);
    expect(calls.filter(c => c.name === 'drawImage').length).toBe(1);
  });

  it('no image: vector calls only, exactly the code drawing', () => {
    const { ctx, calls } = fakeCtx();
    drawVfxPreview(ctx, 220, 160, def, 100, null, { reference: false });
    expect(calls.map(c => c.name)).toEqual(['clearRect', 'save', 'beginPath', 'arc', 'stroke', 'restore']);
    expect(calls.find(c => c.name === 'stroke').alpha).toBe(1);
  });

  it('reference with an unusable image falls back to the full-strength vector shape', () => {
    const { ctx, calls } = fakeCtx();
    drawVfxPreview(ctx, 220, 160, def, 100, { naturalWidth: 0, naturalHeight: 0 }, { reference: true });
    expect(calls.some(c => c.name === 'drawImage')).toBe(false);
    expect(calls.find(c => c.name === 'stroke').alpha).toBe(1);
  });
});

describe('vfxSpriteFilter', () => {
  const rows = [{ name: 'a', sprite_image: 'k/a.png' }, { name: 'b', sprite_image: '' }, { name: 'c' }];
  it('with keeps only rows that have a sprite', () => {
    expect(vfxSpriteFilter(rows, 'with').map(r => r.name)).toEqual(['a']);
  });
  it('without keeps the rest, all keeps everything', () => {
    expect(vfxSpriteFilter(rows, 'without').map(r => r.name)).toEqual(['b', 'c']);
    expect(vfxSpriteFilter(rows, 'all')).toHaveLength(3);
  });
});
