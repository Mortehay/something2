import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';

// Slice D (SOMET-161): trails retire the identical 6px dot every ranged and
// magic weapon drew. The item's stated test is the FALLBACK -- a projectile
// whose weapon has no trail binding must still be visible, because drawing
// nothing is indistinguishable from the shot never having fired.
function fakeCtx() {
  const ops = [];
  return {
    ops,
    ctx: {
      globalAlpha: 1, strokeStyle: null, fillStyle: null, lineWidth: 1,
      save: () => {}, restore: () => {},
      beginPath: () => ops.push('beginPath'),
      moveTo: () => ops.push('moveTo'),
      lineTo: () => ops.push('lineTo'),
      stroke: () => ops.push('stroke'),
      arc: () => ops.push('arc'),
      fill: () => ops.push('fill'),
    },
  };
}

function renderer(ctx, defs) {
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = ctx;
  rs.vfxDefs = defs;
  return rs;
}

const DEFS = { shot_arrow: { name: 'shot_arrow', shape: 'bolt', color: '#e8e2c8', width: 2 } };
const shot = (over = {}) => ({ id: '1', x: 100, y: 100, element: null, v: 'shot_arrow', nx: 1, ny: 0, ...over });

describe('projectile trail', () => {
  it('draws a streak for a projectile whose weapon binds a trail', () => {
    const { ctx, ops } = fakeCtx();
    expect(renderer(ctx, DEFS)._drawProjectileTrail(shot())).toBe(true);
    expect(ops).toContain('stroke');
    expect(ops).not.toContain('arc');
  });

  it('DEGRADES to the dot when the weapon has no trail binding', () => {
    // The stated acceptance criterion.
    const { ctx } = fakeCtx();
    expect(renderer(ctx, DEFS)._drawProjectileTrail(shot({ v: null }))).toBe(false);
  });

  it('degrades to the dot when the bound name is not in the library', () => {
    // jsonb bindings have no FK, so renaming a vfx_effects row orphans every
    // binding pointing at it. That must show a dot, not nothing.
    const { ctx } = fakeCtx();
    expect(renderer(ctx, DEFS)._drawProjectileTrail(shot({ v: 'renamed_away' }))).toBe(false);
  });

  it('degrades to the dot when the library has not loaded yet', () => {
    const { ctx } = fakeCtx();
    expect(renderer(ctx, null)._drawProjectileTrail(shot())).toBe(false);
  });

  it('degrades to the dot without a direction rather than guessing one', () => {
    // A streak pointing the wrong way reads worse than a dot. This case is
    // also the regression guard for the snapshot: the projectile snapshot
    // carried POSITION ONLY at first, so every trail would have silently
    // fallen back here forever with every test still green.
    const { ctx } = fakeCtx();
    const r = renderer(ctx, DEFS);
    expect(r._drawProjectileTrail(shot({ nx: undefined, ny: undefined }))).toBe(false);
    expect(r._drawProjectileTrail(shot({ nx: 0, ny: 0 }))).toBe(false);
    expect(r._drawProjectileTrail(shot({ nx: NaN, ny: 1 }))).toBe(false);
  });

  it('a trail with a loaded sheet draws the streak then the strip with its head at the projectile', () => {
    const ops = [];
    const ctx = {
      globalAlpha: 1, strokeStyle: null, fillStyle: null, lineWidth: 1,
      globalCompositeOperation: 'source-over', imageSmoothingEnabled: false,
      save: () => {}, restore: () => {},
      translate: (x, y) => ops.push(['translate', x, y]),
      rotate: (a) => ops.push(['rotate', a]),
      beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
      stroke: () => ops.push('stroke'),
      drawImage: (...a) => ops.push(['drawImage', ...a.slice(1)]),
    };
    const rs = renderer(ctx, {
      shot_fire: { name: 'shot_fire', shape: 'bolt', color: '#f70', width: 3, duration_ms: 400,
        sprite_image: 'vfx/bolt.png', sprite_frames: 4, sprite_fps: null, sprite_loop: true },
    });
    rs.imageManager = { get: (k) => (k === 'vfx:vfx/bolt.png' ? { naturalWidth: 256, naturalHeight: 16 } : null) };
    rs.nowMs = 100; // 100 % 400 / 400 = 0.25 -> frame 1
    expect(rs._drawProjectileTrail(shot({ v: 'shot_fire' }))).toBe(true);
    const iStroke = ops.indexOf('stroke');
    const iDraw = ops.findIndex((o) => Array.isArray(o) && o[0] === 'drawImage');
    expect(iStroke).toBeGreaterThanOrEqual(0);
    expect(iDraw).toBeGreaterThan(iStroke);
    const [, sx, , , , dx, , dw] = ops[iDraw];
    expect(sx).toBe(64);
    expect(dw).toBeGreaterThanOrEqual(24);
    expect(dx + dw).toBe(0);
    // Translated to the projectile's own screen point (x 100,y 100 -> screen x 0).
    const tr = ops.find((o) => Array.isArray(o) && o[0] === 'translate');
    expect(tr[1]).toBeCloseTo(0, 6);
  });

  it('a trail sheet that has not loaded draws only the streak', () => {
    const ops = [];
    const { ctx, ops: base } = fakeCtx();
    ctx.drawImage = () => ops.push('drawImage');
    const rs = renderer(ctx, { shot_fire: { name: 'shot_fire', shape: 'bolt', sprite_image: 'vfx/bolt.png' } });
    rs.imageManager = { get: () => null };
    expect(rs._drawProjectileTrail(shot({ v: 'shot_fire' }))).toBe(true);
    expect(base).toContain('stroke');
    expect(ops).toHaveLength(0);
  });
});
