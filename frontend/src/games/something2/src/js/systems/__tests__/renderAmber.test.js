// Amber Stance overlay: block (sheet or code fallback), countdown, fade.
// Drawn against a recording fake ctx.
import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';

function fakeCtx() {
  const calls = [];
  const stack = [];
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: false,
    strokeStyle: '#000', fillStyle: '#000', lineWidth: 1, font: '', textAlign: 'start',
    save() { stack.push([this.globalAlpha, this.fillStyle, this.strokeStyle]); },
    restore() { const s = stack.pop(); if (s) [this.globalAlpha, this.fillStyle, this.strokeStyle] = s; },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
    ellipse: (...a) => calls.push({ op: 'ellipse', a }),
    fill() { calls.push({ op: 'fill', style: this.fillStyle, alpha: this.globalAlpha }); },
    stroke() { calls.push({ op: 'stroke', style: this.strokeStyle, alpha: this.globalAlpha }); },
    strokeText() {},
    fillText(text, x, y) { calls.push({ op: 'text', text, x, y }); },
    drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) { calls.push({ op: 'drawImage', img, sx, sw, dw, dh, alpha: this.globalAlpha }); },
  };
  return { ctx, calls, stack };
}

const SHEET = { name: 'amber2', naturalWidth: 1024, naturalHeight: 128 };
const VISUALS = {
  amber_stance_1: { key: 'amber_stance_1', variant: 1, sprite_image: null, sprite_frames: 8, sprite_fps: 10 },
  amber_stance_2: { key: 'amber_stance_2', variant: 2, sprite_image: 'status/a2.png', sprite_frames: 8, sprite_fps: 10 },
};

function renderer(ctx, nowMs) {
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = ctx;
  rs.nowMs = nowMs;
  rs._labelCache = null; // fall back to fillText so the text is visible to the fake
  rs.imageManager = { get: (k) => (k === 'vfx:status/a2.png' ? SHEET : null) };
  return rs;
}

const player = (over = {}) => ({ x: 200, y: 300, width: 64, height: 64, imageKey: 'player', ...over });
const fills = (calls) => calls.filter((c) => c.op === 'fill');
const texts = (calls) => calls.filter((c) => c.op === 'text').map((c) => c.text);

describe('amber overlay', () => {
  it('a sealed player with no approved variant gets the code block, smoke and a countdown', () => {
    const { ctx, calls, stack } = fakeCtx();
    const rs = renderer(ctx, 1000);
    rs._drawAmber(player({ amber: { a: 1, ms: 9001, v: null } }), new Map(), 'me', VISUALS, 1000, new Map());
    expect(fills(calls).some((c) => c.style === 'rgba(222,140,30,0.38)' && c.alpha === 1)).toBe(true);
    expect(calls.filter((c) => c.op === 'ellipse').length).toBeGreaterThanOrEqual(3);
    expect(calls.filter((c) => c.op === 'ellipse').length).toBeLessThanOrEqual(5);
    expect(calls.some((c) => c.op === 'drawImage')).toBe(false);
    expect(texts(calls)).toEqual(['10']);
    expect(stack).toHaveLength(0);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('the countdown ticks down locally between frames and never below 0', () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx, 3500)._drawAmber(player({ amber: { a: 1, ms: 5000, v: null } }), null, 'me', null, 1000, null);
    expect(texts(calls)).toEqual(['3']);
    const two = fakeCtx();
    renderer(two.ctx, 99999)._drawAmber(player({ amber: { a: 1, ms: 5000, v: null } }), null, 'me', null, 1000, null);
    expect(texts(two.calls)).toEqual(['0']);
  });

  it('an approved, loaded variant draws its sheet instead of the block', () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx, 0)._drawAmber(player({ amber: { a: 1, ms: 9000, v: 2 } }), null, 'me', VISUALS, 0, null);
    const draws = calls.filter((c) => c.op === 'drawImage');
    expect(draws).toHaveLength(1);
    expect(draws[0].img).toBe(SHEET);
    expect(draws[0].sw).toBe(128);
    expect(fills(calls).some((c) => c.style === 'rgba(222,140,30,0.38)')).toBe(false);
  });

  it('remote players draw too, with their own countdown', () => {
    const { ctx, calls } = fakeCtx();
    const remotes = new Map([['p2', player({ id: 'p2', amber: { a: 4, ms: 2000, v: 1 } })]]);
    renderer(ctx, 0)._drawAmber(player(), remotes, 'me', VISUALS, 0, new Map());
    expect(texts(calls)).toEqual(['2']);
    expect(fills(calls).some((c) => c.style === 'rgba(222,140,30,0.38)')).toBe(true);
  });

  it('fades for 400 ms after amber leaves the snapshot, with no countdown', () => {
    const fades = new Map([['me', { at: 1000, v: null }]]);
    const mid = fakeCtx();
    renderer(mid.ctx, 1200)._drawAmber(player(), null, 'me', VISUALS, 0, fades);
    expect(fills(mid.calls).find((c) => c.style === 'rgba(222,140,30,0.38)').alpha).toBe(0.5);
    expect(texts(mid.calls)).toEqual([]);
    const done = fakeCtx();
    renderer(done.ctx, 1400)._drawAmber(player(), null, 'me', VISUALS, 0, fades);
    expect(done.calls).toEqual([]);
  });

  it('draws nothing for an unsealed player with no fade', () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx, 0)._drawAmber(player(), new Map([['p2', player({ id: 'p2' })]]), 'me', VISUALS, 0, new Map());
    expect(calls).toEqual([]);
  });
});
