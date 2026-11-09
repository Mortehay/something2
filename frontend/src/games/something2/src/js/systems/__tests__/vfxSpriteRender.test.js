import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';

// Effect sprites in game (Task 6): strip layout for bolt-shaped effects, and the skill
// visual (arcane_beam / lightning) that must not draw a second, vector beam on top of an
// effect that already plays its sprite strip.
function fakeCtx() {
  const calls = [];
  const ctx = {
    globalAlpha: 1, strokeStyle: null, fillStyle: null, lineWidth: 1, globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: false, lineCap: '', lineJoin: '', shadowColor: '', shadowBlur: 0,
    save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {},
    beginPath: () => {}, moveTo: () => {}, closePath: () => {}, fillRect: () => {},
    lineTo: () => calls.push('lineTo'),
    stroke: () => calls.push('stroke'), fill: () => calls.push('fill'),
    ellipse: () => calls.push('ellipse'), arc: () => calls.push('arc'),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    drawImage: (...a) => calls.push(['drawImage', ...a.slice(1)]),
  };
  return { ctx, calls };
}

const img = { naturalWidth: 256, naturalHeight: 16 };
function renderer(ctx, { loaded = true, defs = {} } = {}) {
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = ctx;
  rs.vfxDefs = defs;
  rs.imageManager = { get: (k) => (loaded && k === 'vfx:vfx/s.png' ? img : null) };
  return rs;
}

const def = (over = {}) => ({
  name: 'chain_lightning', shape: 'bolt', color: '#7df', width: 2, duration_ms: 400, ease: 'linear', fade: false,
  sprite_image: 'vfx/s.png', sprite_frames: 4, sprite_size: 0, sprite_additive: true, sprite_stretch: false, ...over,
});
const fx = (d, over = {}) => ({ def: d, x: 100, y: 100, nx: 1, ny: 0, reach: 200, startedAt: 0, ...over });

function atTime(now, fn) {
  const real = globalThis.performance.now;
  globalThis.performance.now = () => now;
  try { fn(); } finally { globalThis.performance.now = real; }
}
const drawsOf = (calls) => calls.filter((c) => Array.isArray(c));

describe('effect strips in game', () => {
  it('chain_lightning (shape bolt, sprite_stretch) stretches from the origin', () => {
    const { ctx, calls } = fakeCtx();
    atTime(200, () => renderer(ctx).drawVfx([fx(def({ sprite_stretch: true }))]));
    const d = drawsOf(calls);
    expect(d).toHaveLength(1);
    const [, , , , , dx] = d[0];
    expect(dx).toBe(0);
  });

  it('a travelling bolt is anchored at its head', () => {
    const { ctx, calls } = fakeCtx();
    atTime(200, () => renderer(ctx).drawVfx([fx(def())]));
    const d = drawsOf(calls);
    expect(d).toHaveLength(1);
    const [, , , , , dx, , dw] = d[0];
    expect(dw).toBeGreaterThan(0);
    expect(dx).toBe(-dw);
  });

  it('a looping strip with sprite_fps plays at its own rate, not the duration', () => {
    const { ctx, calls } = fakeCtx();
    // 10 fps, 450 ms in -> frame 4 -> wraps to 0 on a 4-frame strip.
    atTime(450, () => renderer(ctx).drawVfx([fx(def({ sprite_fps: 10, sprite_loop: true, duration_ms: 1000 }))]));
    expect(drawsOf(calls)[0][1]).toBe(0);
  });

  const beam = (over = {}) => ({
    kind: 'arcane_beam', vfxName: 'chain_lightning', startedAt: 0, durationMs: 300,
    fromX: 0, fromY: 0, toX: 200, toY: 0, color: '#a855f7', ...over,
  });

  it('an arcane_beam skill visual is not drawn when its vfx row\'s sheet is loaded, and IS drawn while the sheet is loading', () => {
    const defs = { chain_lightning: def() };
    const loaded = fakeCtx();
    atTime(100, () => renderer(loaded.ctx, { defs }).drawSkillVisuals([beam()]));
    expect(loaded.calls.filter((c) => c === 'lineTo' || c === 'stroke')).toHaveLength(0);

    const loading = fakeCtx();
    atTime(100, () => renderer(loading.ctx, { loaded: false, defs }).drawSkillVisuals([beam()]));
    expect(loading.calls.filter((c) => c === 'lineTo')).toHaveLength(2);
    expect(loading.calls.filter((c) => c === 'stroke')).toHaveLength(2);
  });

  it('a lightning skill visual is suppressed the same way', () => {
    const defs = { chain_lightning: def() };
    const v = beam({ kind: 'lightning', branches: [{ x1: 0, y1: 0, x2: 50, y2: 0 }], toX: 50, toY: 0 });
    const loaded = fakeCtx();
    atTime(100, () => renderer(loaded.ctx, { defs }).drawSkillVisuals([v]));
    expect(loaded.calls.filter((c) => c === 'lineTo' || c === 'stroke')).toHaveLength(0);
    const loading = fakeCtx();
    atTime(100, () => renderer(loading.ctx, { loaded: false, defs }).drawSkillVisuals([v]));
    expect(loading.calls.filter((c) => c === 'stroke').length).toBeGreaterThan(0);
  });

  it("a 'projectile' skill visual is never suppressed", () => {
    const defs = { chain_lightning: def() };
    const v = {
      kind: 'projectile', vfxName: 'chain_lightning', startedAt: 0, durationMs: 300,
      x: 50, y: 0, fromX: 0, fromY: 0, toX: 200, toY: 0, radius: 6, color: '#f97316',
    };
    const { ctx, calls } = fakeCtx();
    atTime(100, () => renderer(ctx, { defs }).drawSkillVisuals([v]));
    expect(calls.filter((c) => c === 'fill' || c === 'stroke' || c === 'arc').length).toBeGreaterThan(0);
  });
});
