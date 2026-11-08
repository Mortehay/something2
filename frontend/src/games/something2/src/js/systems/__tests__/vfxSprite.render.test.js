import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';

// An effect or a telegraph bound to a sprite sheet is drawn from it once the image has
// loaded, and falls back to the vector drawing until then. A recording canvas stands in for
// the real one: what matters is WHICH drawing happened and that the source rectangle is the
// frame the progress calls for.
function fakeCtx() {
  const calls = [];
  const ctx = {
    globalAlpha: 1, strokeStyle: null, fillStyle: null, lineWidth: 1, globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: false,
    save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {},
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, closePath: () => {},
    stroke: () => calls.push('stroke'), fill: () => calls.push('fill'), fillRect: () => {},
    ellipse: () => calls.push('ellipse'),
    drawImage: (...a) => calls.push(['drawImage', ...a.slice(1)]),
  };
  return { ctx, calls };
}

const img = { naturalWidth: 256, naturalHeight: 64 };
function renderer(ctx, { loaded = true } = {}) {
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = ctx;
  rs.imageManager = { get: (k) => (loaded && k === 'vfx:vfx/s.png' ? img : null) };
  return rs;
}

const def = (over = {}) => ({
  name: 'boss_meteor', shape: 'burst', color: '#f70', width: 2, duration_ms: 1000, ease: 'linear', fade: false,
  sprite_image: 'vfx/s.png', sprite_frames: 4, sprite_size: 200, sprite_additive: false, ...over,
});
const fx = (d, over = {}) => ({ def: d, x: 100, y: 100, nx: 1, ny: 0, reach: 100, startedAt: 0, ...over });

function atTime(now, fn) {
  const real = globalThis.performance.now;
  globalThis.performance.now = () => now;
  try { fn(); } finally { globalThis.performance.now = real; }
}

describe('effects drawn from a sprite sheet', () => {
  it('draws the frame the progress calls for, and no vector shape', () => {
    for (const [now, sx] of [[10, 0], [300, 64], [600, 128], [990, 192]]) {
      const { ctx, calls } = fakeCtx();
      const rs = renderer(ctx);
      atTime(now, () => rs.drawVfx([fx(def())]));
      const draws = calls.filter((c) => Array.isArray(c));
      expect(draws).toHaveLength(1);
      expect(draws[0].slice(1, 5)).toEqual([sx, 0, 64, 64]);
      expect(calls).not.toContain('stroke');
    }
  });

  it('falls back to the vector shape while the image has not loaded', () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx, { loaded: false }).drawVfx([fx(def({ shape: 'ring' }))]);
    expect(calls.filter((c) => Array.isArray(c))).toHaveLength(0);
    expect(calls).toContain('ellipse');
  });

  it('additive sprites blend with "lighter" and restore the blend mode', () => {
    const { ctx } = fakeCtx();
    const seen = [];
    ctx.drawImage = () => seen.push(ctx.globalCompositeOperation);
    atTime(10, () => renderer(ctx).drawVfx([fx(def({ sprite_additive: true }))]));
    expect(seen).toEqual(['lighter']);
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });

  it('every shape survives a sprite with zero reach and a NaN direction', () => {
    for (const shape of ['ring', 'burst', 'line', 'bolt', 'arc']) {
      const { ctx } = fakeCtx();
      const rs = renderer(ctx);
      expect(() => rs.drawVfx([fx(def({ shape, sprite_size: 0 }), { reach: 0 })])).not.toThrow();
      expect(() => rs.drawVfx([fx(def({ shape }), { nx: NaN, ny: NaN })])).not.toThrow();
    }
  });
});

describe('telegraphs with a sprite and a safe middle', () => {
  const tele = (over = {}) => ({ x: 100, y: 100, radius: 200, ms: 500, telegraphMs: 1000, v: 'boss_lava_ring', ...over });

  it('a ring with a hole fills with the even-odd rule so the middle stays empty', () => {
    const { ctx } = fakeCtx();
    let rule = null;
    ctx.fill = (r) => { rule = r; };
    const rs = renderer(ctx);
    rs.vfxDefs = {};
    rs._drawTelegraphs([tele({ inner: 80 })]);
    expect(rule).toBe('evenodd');
  });

  it('draws the sprite over the ground AND keeps the outline', () => {
    const { ctx, calls } = fakeCtx();
    const rs = renderer(ctx);
    rs.vfxDefs = { boss_lava_ring: def({ name: 'boss_lava_ring', shape: 'ring' }) };
    rs._drawTelegraphs([tele()]);
    expect(calls.filter((c) => Array.isArray(c))).toHaveLength(1);
    expect(calls).toContain('stroke');
  });

  it('a telegraph without art is the old red circle', () => {
    const { ctx, calls } = fakeCtx();
    const rs = renderer(ctx);
    rs.vfxDefs = {};
    rs._drawTelegraphs([tele({ v: null })]);
    expect(calls.filter((c) => Array.isArray(c))).toHaveLength(0);
    expect(calls).toEqual(expect.arrayContaining(['ellipse', 'fill', 'stroke']));
  });
});
