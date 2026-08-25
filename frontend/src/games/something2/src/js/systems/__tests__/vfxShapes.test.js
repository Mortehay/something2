import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';
import { addEffects, BLOCK_EFFECT_DEF, DESPAWN_EFFECT_DEF } from '../../core/vfx.js';
import { worldToScreen } from '../../core/iso.js';
import { anchorY } from '../../core/attackAnchor.js';

// Slice B (SOMET-159): the four shapes added beyond `arc`.
//
// These assert the two things that can actually go wrong in a canvas draw
// loop and are invisible in a screenshot: that a shape draws AT ALL, and that
// degenerate geometry does not throw. Canvas silently ignores a zero-length
// path but THROWS on a negative radius, so an effect authored with width 0 --
// or bound to a projectile weapon, every one of which has reach null -- must
// not be able to take the render loop down with it.
//
// `pts` records the same path points WITH their coordinates. `ops` stays a
// list of bare op names, so a test that only cares "did it draw" is not forced
// to reason about geometry -- but a cue whose whole job is to point somewhere
// cannot be proven by op names alone (a flipped sign draws the identical ops).
function fakeCtx() {
  const ops = [];
  const pts = [];
  const ctx = {
    globalAlpha: 1, strokeStyle: null, fillStyle: null, lineWidth: 1, font: null,
    textAlign: null, textBaseline: null,
    save: () => {}, restore: () => {},
    beginPath: () => ops.push('beginPath'),
    moveTo: (x, y) => { ops.push('moveTo'); pts.push({ op: 'moveTo', x, y }); },
    lineTo: (x, y) => { ops.push('lineTo'); pts.push({ op: 'lineTo', x, y }); },
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
  return { ctx, ops, pts };
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
  // SOMET-326: `o` is the vertical render anchor the server resolves. 24 is a
  // 48px creature's mid-body -- deliberately NOT the 32 (half a tile) this
  // shape used to hardcode, so a regression that reinstates the tile constant
  // shifts every coordinate below and fails rather than passing by coincidence.
  const BLOCK_EVENT = { t: 'c:guard', x: 300, y: 300, nx: -1, ny: 0, o: 24, b: true };

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

  // The four cardinal wire vectors the server actually sends. Each projects to
  // a DIFFERENT screen quadrant under the iso transform, so a term dropped or
  // negated in either axis has nowhere to hide: nx alone cannot fake ny.
  const CARDINALS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  // Where the guard itself lands on screen, and the screen-space direction the
  // blow came in on. Both go through the SAME projection the renderer uses --
  // what is under test is the SIGN the renderer applies to the wire vector, not
  // the projection, so re-deriving the projection here would prove nothing.
  const guardScreen = () => worldToScreen(BLOCK_EVENT.x, BLOCK_EVENT.y);
  const screenDir = (nx, ny) => worldToScreen(nx, ny);   // linear, origin-anchored

  // The shield's centre, read straight off the canvas: both sparks start there,
  // so the second moveTo IS it, with none of the body's half-width to undo.
  const shieldCentre = (pts) => pts.filter((p) => p.op === 'moveTo')[1];

  it('offsets the shield toward the side the blow came from', () => {
    // The failure this exists for: `fx.x + fx.nx * OFFSET` turned into a minus
    // puts the shield on the guard's FAR side -- a cue that says the blow came
    // from behind. Every op name is identical either way, so the drawn
    // coordinates are the only thing that can tell the two apart.
    for (const [nx, ny] of CARDINALS) {
      const { ctx, pts } = fakeCtx();
      drawBlock(ctx, { ...BLOCK_EVENT, nx, ny });
      const c = shieldCentre(pts);
      const g = guardScreen();
      const dx = c.x - g.x;
      const dy = c.y - anchorY(g.y, BLOCK_EVENT.o);   // the event's own anchor, as the shape uses
      const dir = screenDir(nx, ny);
      // Displacement must be a POSITIVE multiple of the projected wire vector.
      // Parallel alone would accept the far side; a positive dot alone would
      // accept a rotation. Together they pin the direction outright, without
      // the test needing to know the offset's magnitude.
      expect(Math.hypot(dx, dy)).toBeGreaterThan(0);
      expect(dx * dir.x + dy * dir.y).toBeGreaterThan(0);
      expect(dx * dir.y - dy * dir.x).toBeCloseTo(0, 6);
    }
  });

  it('throws the deflection sparks along the direction the blow came from', () => {
    // Two sparks skidding off the shield face, and only when the server said
    // where the blow came from. The count is what separates "the shield alone"
    // from "the shield plus its clang", so it is asserted, not assumed -- and
    // the count survives a flipped offset, so their heading is asserted too.
    for (const [nx, ny] of CARDINALS) {
      const { ctx, ops, pts } = fakeCtx();
      drawBlock(ctx, { ...BLOCK_EVENT, nx, ny });
      // Sparks are moveTo/lineTo/stroke triples appended after the shield body.
      expect(ops.filter((o) => o === 'stroke').length).toBe(3);
      const starts = pts.map((p, i) => (p.op === 'moveTo' ? i : -1)).filter((i) => i >= 0);
      expect(starts).toHaveLength(3);             // the body, then one per spark
      const dir = screenDir(nx, ny);
      for (const i of starts.slice(1)) {
        const from = pts[i], to = pts[i + 1];
        expect(to.op).toBe('lineTo');
        // Both skid back toward the attacker (they fan +-0.7rad off that line),
        // so both must lie on the incoming side, never behind the guard.
        expect((to.x - from.x) * dir.x + (to.y - from.y) * dir.y).toBeGreaterThan(0);
      }
    }
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

// SOMET-482 -- the ground-loot despawn puff, taken through the SAME path a
// live frame does: addEffects builds the entry from a server-shaped event and
// drawVfx renders it. Asserting the def's fields alone would not catch the
// thing that actually breaks this cue -- the burst shape sizes its spokes from
// `reach`, a despawn event carries none, and blastScreenRadiusX(0) makes the
// whole shape early-return. That failure draws nothing and throws nothing, so
// only a draw-level assertion can see it.
describe('item_despawn puff (SOMET-482)', () => {
  const event = { v: 'item_despawn', x: 321, y: 654 };

  it('draws visible geometry from a bare {name,x,y} server frame', () => {
    const { ctx, ops } = fakeCtx();
    // An EMPTY effect library, exactly as the client has before (or without)
    // any vfx_effects rows: the built-in must still resolve.
    // Mid-lifetime, anchored to the real clock, because drawVfx reads
    // performance.now() itself: at t=0 a burst legitimately has zero radius,
    // so timing the frame at its own spawn instant would pass this test for
    // the wrong reason on the way in and fail it on the way out.
    const list = addEffects([], [event], performance.now() - 200, {});
    expect(list).toHaveLength(1);
    renderer(ctx).drawVfx(list);
    // Spokes: the burst body actually reached the canvas rather than
    // early-returning on a zero radius.
    expect(ops.filter((o) => o === 'stroke').length).toBeGreaterThan(0);
    expect(ops).toContain('moveTo');
    expect(ops).toContain('lineTo');
  });

  it('draws its particles too', () => {
    const rects = [];
    const { ctx, ops } = fakeCtx();
    ctx.fillRect = (x, y, w, h) => { ops.push('fillRect'); rects.push({ x, y, w, h }); };
    // Mid-lifetime, so the particles have travelled and are still alive.
    const list = addEffects([], [event], 0, {});
    // drawVfx reads performance.now() itself, and particles (unlike the body)
    // do NOT clamp -- they are skipped outright outside their own lifetime. So
    // the start time has to be anchored to the real clock, not to 0.
    renderer(ctx).drawVfx(list.map((f) => ({ ...f, startedAt: performance.now() - 200 })));
    expect(rects.length).toBe(DESPAWN_EFFECT_DEF.particle_count);
  });

  it('never throws, whatever the frame carries', () => {
    const { ctx } = fakeCtx();
    const r = renderer(ctx);
    expect(() => r.drawVfx(addEffects([], [event], 0, {}))).not.toThrow();
    expect(() => r.drawVfx(addEffects([], [{ ...event, nx: 0, ny: 0 }], 0, {}))).not.toThrow();
  });
});
