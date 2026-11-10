import { describe, it, expect } from 'vitest';
import { drawBuffAuraPreview, BUFF_FIGURE_PX } from '../buffAuraPreview.js';

function fakeCtx() {
  const calls = [];
  const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over' };
  for (const m of ['clearRect', 'save', 'restore', 'beginPath', 'arc', 'ellipse', 'stroke', 'fill', 'strokeRect', 'drawImage']) {
    ctx[m] = (...args) => { calls.push({ name: m, args, alpha: ctx.globalAlpha, comp: ctx.globalCompositeOperation }); };
  }
  ctx.createRadialGradient = (...args) => {
    const g = { args, stops: [], addColorStop: (o, c) => g.stops.push([o, c]) };
    return g;
  };
  return { ctx, calls };
}
const W = 220; const H = 160;
// 4 frames of 32x64 -> aspect 2
const image = { naturalWidth: 128, naturalHeight: 64 };
const ground = { placement: 'ground', radius: 150, scale: 1.3, color: '#ff0000', sprite_frames: 4, sprite_fps: 10 };
const body = { placement: 'body', radius: 64, scale: 2, color: '#00ff00', sprite_frames: 4, sprite_fps: 10 };
// preview scales, computed independently of the module
const groundScale = (Math.min(W, H * 2) * 0.45) / 150;
const bodyScale = (H * 0.85) / (2 * 48);

describe('drawBuffAuraPreview', () => {
  it('ground + image + reference: a sprite 2r wide, flattened by aspect/2, over the ring at 0.35', () => {
    const { ctx, calls } = fakeCtx();
    drawBuffAuraPreview(ctx, W, H, ground, 0, image, { reference: true });
    const r = 150 * groundScale;
    const di = calls.filter((c) => c.name === 'drawImage');
    expect(di).toHaveLength(1);
    const [, sx, sy, sw, sh, , , dw, dh] = di[0].args;
    expect([sx, sy, sw, sh]).toEqual([0, 0, 32, 64]);
    expect(dw).toBeCloseTo(2 * r, 5);
    expect(dh).toBeCloseTo((dw * 2) / 2, 5);
    const ring = calls.find((c) => c.name === 'ellipse');
    expect(ring.args[2]).toBeCloseTo(r, 5);
    expect(ring.args[3]).toBeCloseTo(r / 2, 5);
    expect(calls.find((c) => c.name === 'stroke').alpha).toBeCloseTo(0.35, 5);
    expect(di[0].alpha).toBe(1);
  });
  it('body + image + reference: a sprite scale x 48 x previewScale tall, over the glow at 0.35', () => {
    const { ctx, calls } = fakeCtx();
    drawBuffAuraPreview(ctx, W, H, body, 0, image, { reference: true });
    const di = calls.filter((c) => c.name === 'drawImage');
    expect(di).toHaveLength(1);
    const [, , , , , , , dw, dh] = di[0].args;
    expect(dh).toBeCloseTo(2 * BUFF_FIGURE_PX * bodyScale, 5);
    expect(dw).toBeCloseTo(dh / 2, 5);
    const fill = calls.find((c) => c.name === 'fill');
    expect(fill.alpha).toBeCloseTo(0.35, 5);
    expect(calls.find((c) => c.name === 'arc').args[2]).toBeCloseTo(dh / 2, 5);
  });
  it('the 48 px figure box stands on the feet point at the preview scale', () => {
    const { ctx, calls } = fakeCtx();
    drawBuffAuraPreview(ctx, W, H, body, 0, image, { reference: true });
    const box = calls.find((c) => c.name === 'strokeRect').args;
    expect(box[2]).toBeCloseTo(BUFF_FIGURE_PX * bodyScale, 5);
    expect(box[3]).toBeCloseTo(BUFF_FIGURE_PX * bodyScale, 5);
  });
  it('Code canvas (no image): the fallback at full strength, no drawImage', () => {
    for (const [v, mark] of [[ground, 'stroke'], [body, 'fill']]) {
      const { ctx, calls } = fakeCtx();
      drawBuffAuraPreview(ctx, W, H, v, 0);
      expect(calls.some((c) => c.name === 'drawImage')).toBe(false);
      expect(calls.find((c) => c.name === mark).alpha).toBe(1);
    }
  });
  it('the body glow is a radial gradient in the visual colour', () => {
    const { ctx } = fakeCtx();
    let made = null;
    const orig = ctx.createRadialGradient;
    ctx.createRadialGradient = (...a) => { made = orig(...a); return made; };
    drawBuffAuraPreview(ctx, W, H, body, 0);
    expect(made.stops[0][1]).toBe('rgba(0,255,0,0.55)');
  });
  it('frame = floor(elapsed x fps / 1000) % frames; additive draws lighter and restores', () => {
    const at = (v, ms) => { const { ctx, calls } = fakeCtx(); drawBuffAuraPreview(ctx, W, H, v, ms, image, { reference: true }); return calls.find((c) => c.name === 'drawImage'); };
    expect(at(ground, 100).args[1]).toBe(32);
    expect(at(ground, 450).args[1]).toBe(0);
    expect(at({ ...ground, sprite_fps: null }, 250).args[1]).toBe(64);
    const { ctx, calls } = fakeCtx();
    drawBuffAuraPreview(ctx, W, H, { ...ground, sprite_additive: true }, 0, image, { reference: true });
    expect(calls.find((c) => c.name === 'drawImage').comp).toBe('lighter');
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });
  it('non-reference with an image: the sprite replaces the fallback', () => {
    const { ctx, calls } = fakeCtx();
    drawBuffAuraPreview(ctx, W, H, ground, 0, image);
    expect(calls.filter((c) => c.name === 'ellipse')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'drawImage')).toHaveLength(1);
  });
  it('an unusable image falls back to the unfaded ring', () => {
    const { ctx, calls } = fakeCtx();
    drawBuffAuraPreview(ctx, W, H, ground, 0, { naturalWidth: 0, naturalHeight: 0 }, { reference: true });
    expect(calls.some((c) => c.name === 'drawImage')).toBe(false);
    expect(calls.find((c) => c.name === 'stroke').alpha).toBe(1);
  });
  it('aura_radius (the buff\'s own effect radius) wins over the stored radius, as in game', () => {
    // The aura always fills the canvas, so the radius shows in the figure box: 48 px at a scale
    // that fits 150 world units, not 64.
    const box = (v) => { const { ctx, calls } = fakeCtx(); drawBuffAuraPreview(ctx, W, H, v, 0, image, { reference: true }); return calls.find((c) => c.name === 'strokeRect').args[2]; };
    const maxR = Math.min(W, H * 2) * 0.45;
    expect(box({ ...ground, radius: 64, aura_radius: 150 })).toBeCloseTo(48 * maxR / 150, 5);
    expect(box({ ...ground, radius: 64, aura_radius: null })).toBeCloseTo(48 * maxR / 64, 5);
  });
});
