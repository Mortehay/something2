import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';

// Slice B (SOMET-159): the four shapes added beyond `arc`.
//
// These assert the two things that can actually go wrong in a canvas draw
// loop and are invisible in a screenshot: that a shape draws AT ALL, and that
// degenerate geometry does not throw. Canvas silently ignores a zero-length
// path but THROWS on a negative radius, so an effect authored with width 0 --
// or bound to a projectile weapon, every one of which has reach null -- must
// not be able to take the render loop down with it.
function fakeCtx() {
  const ops = [];
  const ctx = {
    globalAlpha: 1, strokeStyle: null, fillStyle: null, lineWidth: 1, font: null,
    textAlign: null, textBaseline: null,
    save: () => {}, restore: () => {},
    beginPath: () => ops.push('beginPath'),
    moveTo: () => ops.push('moveTo'),
    lineTo: () => ops.push('lineTo'),
    stroke: () => ops.push('stroke'),
    fill: () => {}, fillRect: () => {}, fillText: () => {},
    ellipse: (x, y, rx, ry) => {
      // Mirror the real canvas contract: a negative radius is an IndexSizeError.
      if (rx < 0 || ry < 0) throw new Error('IndexSizeError: negative radius');
      ops.push('ellipse');
    },
  };
  return { ctx, ops };
}

function renderer(ctx) {
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = ctx;
  return rs;
}

const fx = (over = {}) => ({
  def: { shape: 'line', color: '#fff', width: 2, duration_ms: 200, ease: 'linear', fade: true },
  x: 100, y: 100, nx: 1, ny: 0, reach: 120, arc: 1, hit: true, startedAt: 0,
  ...over,
  def: { shape: 'line', color: '#fff', width: 2, duration_ms: 200, ease: 'linear', fade: true, ...(over.def || {}) },
});

describe('slice B shapes', () => {
  for (const shape of ['line', 'ring', 'burst', 'bolt']) {
    it(`${shape} draws something for ordinary geometry`, () => {
      const { ctx, ops } = fakeCtx();
      renderer(ctx).drawVfx([fx({ def: { shape } })]);
      expect(ops.length).toBeGreaterThan(0);
    });

    it(`${shape} survives zero reach without throwing`, () => {
      const { ctx } = fakeCtx();
      // Every projectile weapon has reach null, so this is the real case, not
      // a contrived one.
      expect(() => renderer(ctx).drawVfx([fx({ def: { shape }, reach: 0 })])).not.toThrow();
      expect(() => renderer(ctx).drawVfx([fx({ def: { shape }, reach: null })])).not.toThrow();
    });

    it(`${shape} survives zero arc and zero width without throwing`, () => {
      const { ctx } = fakeCtx();
      expect(() => renderer(ctx).drawVfx([
        fx({ def: { shape, width: 0 }, arc: 0 }),
      ])).not.toThrow();
    });

    it(`${shape} survives a NaN direction without throwing`, () => {
      const { ctx } = fakeCtx();
      expect(() => renderer(ctx).drawVfx([
        fx({ def: { shape }, nx: NaN, ny: NaN }),
      ])).not.toThrow();
    });
  }

  it('an unknown shape draws nothing rather than drawing it wrong', () => {
    // vfx_effects.shape is CHECK-constrained, but the client also receives
    // whatever /api/vfx-effects returns -- including from a database migrated
    // ahead of the client.
    const { ctx, ops } = fakeCtx();
    renderer(ctx).drawVfx([fx({ def: { shape: 'hologram' } })]);
    expect(ops).toEqual([]);
  });

  it('still draws the arc shape slice A shipped', () => {
    const { ctx, ops } = fakeCtx();
    renderer(ctx).drawVfx([fx({ def: { shape: 'arc' } })]);
    expect(ops).toContain('ellipse');
  });
});
