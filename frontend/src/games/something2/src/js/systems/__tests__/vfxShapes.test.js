import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';
import { addEffects, BLOCK_EFFECT_DEF } from '../../core/vfx.js';

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
    closePath: () => ops.push('closePath'),
    quadraticCurveTo: () => ops.push('quadraticCurveTo'),
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
  for (const shape of ['line', 'ring', 'burst', 'bolt', 'block']) {
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

// SOMET-286: a village guard cannot be damaged by a player, and until now a
// swing at one drew EXACTLY what a swing at empty ground draws. These assert
// the client half of the fix: that a blocked impact reaches the canvas, and
// that what lands there is unmistakably not a hit and not a whiff.
describe('the guard block cue', () => {
  // The real wire descriptor: what world.js/projectiles.js put on frame.impacts
  // for a refused attack -- no effect NAME, `b: true`, the direction the blow
  // came from.
  const BLOCK_EVENT = { t: 'c:guard', x: 300, y: 300, nx: -1, ny: 0, b: true };

  // The whole client path, from the frame field to the canvas calls, with an
  // EMPTY effect library -- which is the case the built-in def exists for.
  const drawBlock = (ctx, ev = BLOCK_EVENT) => {
    const list = addEffects([], [ev], 0, {});
    renderer(ctx).drawVfx(list);
    return list;
  };

  it('draws the shield outline from a server block event, with no effect library', () => {
    const { ctx, ops } = fakeCtx();
    const list = drawBlock(ctx);
    expect(list).toHaveLength(1);
    // The closed, curved outline is the shield body. No other shape in this
    // file closes a path or curves one, which is what makes the cue a shape
    // and not a restyled spark.
    expect(ops).toContain('quadraticCurveTo');
    expect(ops).toContain('closePath');
    expect(ops).toContain('stroke');
    expect(ctx.strokeStyle).toBe(BLOCK_EFFECT_DEF.color);
  });

  it('is visibly a different drawing from every authored shape', () => {
    // The failure this guards against is the cue quietly degrading into
    // something that looks like an ordinary impact spark.
    const blockOps = (() => { const { ctx, ops } = fakeCtx(); drawBlock(ctx); return ops; })();
    for (const shape of ['arc', 'line', 'ring', 'burst', 'bolt']) {
      const { ctx, ops } = fakeCtx();
      renderer(ctx).drawVfx([fx({ def: { shape } })]);
      expect(ops).not.toEqual(blockOps);
      expect(ops).not.toContain('quadraticCurveTo');
    }
  });

  it('throws the deflection sparks along the direction the blow came from', () => {
    // Two sparks skidding off the shield face, and only when the server said
    // where the blow came from. The count is what separates "the shield alone"
    // from "the shield plus its clang", so it is asserted, not assumed.
    const withDir = (() => { const { ctx, ops } = fakeCtx(); drawBlock(ctx); return ops; })();
    // Sparks are moveTo/lineTo/stroke triples appended after the shield body.
    expect(withDir.filter((o) => o === 'stroke').length).toBe(3);
  });

  it('still draws the shield when there is no direction to face', () => {
    // Two degenerate cases, and they reach the renderer differently.
    // Through addEffects a zero vector is normalized to due south, so the
    // glyph is merely offset the wrong way -- it must still appear:
    const viaWire = (() => {
      const { ctx, ops } = fakeCtx();
      drawBlock(ctx, { ...BLOCK_EVENT, nx: 0, ny: 0 });
      return ops;
    })();
    expect(viaWire).toContain('closePath');
    // A hand-built NaN direction is the case with genuinely no line to throw
    // sparks along: shield only, one stroke, and nothing thrown.
    const { ctx, ops } = fakeCtx();
    expect(() => renderer(ctx).drawVfx([
      fx({ def: { shape: 'block' }, nx: NaN, ny: NaN }),
    ])).not.toThrow();
    expect(ops).toContain('closePath');
    expect(ops.filter((o) => o === 'stroke').length).toBe(1);
  });

  it('does not scale with `reach`, which an impact descriptor never carries', () => {
    // Every other shape here sizes itself from reach, and a `ring` with reach
    // 0 draws NOTHING. A block rides the impacts channel, whose descriptors
    // are points on a target and carry no reach at all -- sizing it that way
    // would make the cue invisible, which is the bug it exists to fix.
    const at = (reach) => {
      const { ctx, ops } = fakeCtx();
      renderer(ctx).drawVfx([fx({ def: { shape: 'block' }, reach })]);
      return ops;
    };
    expect(at(0)).toEqual(at(200));
    expect(at(0).length).toBeGreaterThan(0);

    const { ctx, ops } = fakeCtx();
    renderer(ctx).drawVfx([fx({ def: { shape: 'ring' }, reach: 0 })]);
    expect(ops).toEqual([]);          // the contrast that makes the above matter
  });
});
