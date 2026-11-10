// Task 5b: the admin previews play aura/buff/status strips un-spun, like the game, and
// leave vfx strips alone.
import { describe, it, expect } from 'vitest';
import { previewRotation } from '../effectSprites.js';
import { drawAuraPreview } from '../auraPreview.js';
import { drawBuffAuraPreview } from '../buffAuraPreview.js';

function recorder() {
  const calls = [];
  const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
  for (const m of ['clearRect', 'save', 'restore', 'beginPath', 'arc', 'ellipse', 'stroke', 'fill', 'fillRect',
    'strokeRect', 'drawImage', 'translate', 'scale', 'rotate']) {
    ctx[m] = (...a) => calls.push({ op: m, a });
  }
  ctx.createRadialGradient = () => ({ addColorStop() {} });
  return { ctx, calls };
}
const rotations = (calls) => calls.filter((c) => c.op === 'rotate').map((c) => c.a[0]);

describe('EffectStripPreview rotation (previewRotation)', () => {
  it('aura/buff/status subjects add the un-spin of the current frame to the preview angle', () => {
    for (const kind of ['aura', 'buff', 'status']) {
      expect(previewRotation(kind, 0, 2, 8)).toBeCloseTo(Math.PI / 2, 12);
      expect(previewRotation(kind, 0, 0, 8)).toBe(0);
      expect(previewRotation(kind, 90, 4, 8)).toBeCloseTo(Math.PI / 2 + Math.PI, 12);
    }
  });
  it('a vfx subject keeps only its static preview angle', () => {
    expect(previewRotation('vfx', 0, 2, 8)).toBe(0);
    expect(previewRotation('vfx', 150, 3, 8)).toBeCloseTo((150 * Math.PI) / 180, 12);
  });
});

// 8 frames of 32x32; 10 fps, 200 ms -> frame 2 -> pi/2.
const image = { naturalWidth: 256, naturalHeight: 32 };

describe('Aura / Buff admin "with sprite" previews', () => {
  it('drawAuraPreview turns frame 2 of 8 back by pi/2, squash before rotate', () => {
    const { ctx, calls } = recorder();
    const def = { shape: 'ring', radius: 200, color: '#ff0000', pulse_ms: 0, particle_count: 0, sprite_frames: 8, sprite_fps: 10 };
    drawAuraPreview(ctx, 220, 160, def, 200, image, { reference: true });
    expect(rotations(calls)).toHaveLength(1);
    expect(rotations(calls)[0]).toBeCloseTo(Math.PI / 2, 12);
    const sc = calls.findIndex((c) => c.op === 'scale');
    expect(calls[sc].a).toEqual([1, 0.5]);
    expect(sc).toBeLessThan(calls.findIndex((c) => c.op === 'rotate'));
    expect(calls.find((c) => c.op === 'translate').a).toEqual([110, 80]);
  });

  it('drawBuffAuraPreview turns ground and body strips back by the frame', () => {
    for (const placement of ['ground', 'body']) {
      const { ctx, calls } = recorder();
      drawBuffAuraPreview(ctx, 220, 160, { placement, radius: 150, scale: 1.3, color: '#ff0000', sprite_frames: 8, sprite_fps: 10 }, 200, image);
      expect(rotations(calls)).toHaveLength(1);
      expect(rotations(calls)[0]).toBeCloseTo(Math.PI / 2, 12);
      expect(calls.some((c) => c.op === 'scale')).toBe(placement === 'ground');
    }
  });

  it('frame 0 needs no transform', () => {
    const { ctx, calls } = recorder();
    drawBuffAuraPreview(ctx, 220, 160, { placement: 'body', scale: 1.3, color: '#ff0000', sprite_frames: 8, sprite_fps: 10 }, 0, image);
    expect(rotations(calls)).toHaveLength(0);
  });
});
