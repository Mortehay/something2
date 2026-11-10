import { describe, it, expect } from 'vitest';
import { drawAuraPreview } from '../auraPreview.js';

function fakeCtx() {
  const calls = [];
  const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
  for (const m of ['clearRect', 'save', 'restore', 'beginPath', 'arc', 'stroke', 'fill', 'fillRect', 'strokeRect', 'drawImage', 'translate', 'scale', 'rotate']) {
    ctx[m] = (...args) => { calls.push({ name: m, args, alpha: ctx.globalAlpha, comp: ctx.globalCompositeOperation }); };
  }
  return { ctx, calls };
}
const W = 220; const H = 160;
// 4 frames of 32x16 -> aspect 0.5
const image = { naturalWidth: 128, naturalHeight: 16 };
const def = { shape: 'ring', radius: 200, color: '#ff0000', pulse_ms: 0, particle_count: 0, sprite_frames: 4, sprite_fps: 10 };
// the preview's own scaled radius, before pulse
const rBase = (d) => (Math.min(W, H) * 0.45 / Math.max(d.radius, 48)) * d.radius;

describe('drawAuraPreview sprite', () => {
  it('reference: faint ring arc AND a sprite 2r wide, flattened by aspect/2', () => {
    const { ctx, calls } = fakeCtx();
    drawAuraPreview(ctx, W, H, def, 0, image, { reference: true });
    const arc = calls.find(c => c.name === 'arc');
    const stroke = calls.find(c => c.name === 'stroke');
    const di = calls.filter(c => c.name === 'drawImage');
    expect(arc).toBeTruthy();
    expect(stroke.alpha).toBeCloseTo(0.7 * 0.35, 5); // pulse_ms 0: ring alpha 0.35 x 2 = 0.7, then x 0.35
    expect(di).toHaveLength(1);
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = di[0].args;
    expect(dw).toBeCloseTo(2 * rBase(def), 5);
    expect(dh).toBeCloseTo(dw * 0.5 / 2, 5);
    expect([sx, sy, sw, sh]).toEqual([0, 0, 32, 16]);
    expect(dx).toBeCloseTo(W / 2 - dw / 2, 5);
    expect(dy).toBeCloseTo(H / 2 - dh / 2, 5);
  });
  it('frame = floor(elapsed x fps / 1000) % frames, fps defaulting to 10', () => {
    const at = (d, ms) => { const { ctx, calls } = fakeCtx(); drawAuraPreview(ctx, W, H, d, ms, image, { reference: true }); return calls.find(c => c.name === 'drawImage').args[1]; };
    expect(at(def, 100)).toBe(32);          // frame 1
    expect(at(def, 450)).toBe(4 % 4 * 32);  // frame 4 wraps to 0
    expect(at(def, 550)).toBe(32);          // frame 5 -> 1
    expect(at({ ...def, sprite_fps: null }, 250)).toBe(64); // default fps 10 -> frame 2
    expect(at({ ...def, sprite_fps: 20 }, 100)).toBe(64);
  });
  it('additive sprites draw with lighter and restore the composite op', () => {
    const { ctx, calls } = fakeCtx();
    drawAuraPreview(ctx, W, H, { ...def, sprite_additive: true }, 0, image, { reference: true });
    expect(calls.find(c => c.name === 'drawImage').comp).toBe('lighter');
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });
  it('no image: ring at its own strength, no drawImage (the Code canvas)', () => {
    const { ctx, calls } = fakeCtx();
    drawAuraPreview(ctx, W, H, def, 0);
    expect(calls.some(c => c.name === 'drawImage')).toBe(false);
    expect(calls.find(c => c.name === 'stroke').alpha).toBeCloseTo(0.7, 5);
  });
  it('an unusable image falls back to the unfaded ring', () => {
    const { ctx, calls } = fakeCtx();
    drawAuraPreview(ctx, W, H, def, 0, { naturalWidth: 0, naturalHeight: 0 }, { reference: true });
    expect(calls.some(c => c.name === 'drawImage')).toBe(false);
    expect(calls.find(c => c.name === 'stroke').alpha).toBeCloseTo(0.7, 5);
  });
  it('non-reference with an image: the sprite replaces the ring', () => {
    const { ctx, calls } = fakeCtx();
    drawAuraPreview(ctx, W, H, def, 0, image);
    expect(calls.some(c => c.name === 'stroke' && c.alpha !== 1)).toBe(false);
    expect(calls.filter(c => c.name === 'arc')).toHaveLength(0);
    expect(calls.filter(c => c.name === 'drawImage')).toHaveLength(1);
  });
});
