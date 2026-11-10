// Un-spin of box `aura` strips: the box turns frame f of an N-frame strip by f*360/N
// counter-clockwise; drawing it turned back (ctx.rotate(+angle)) keeps the subject upright.
import { describe, it, expect } from 'vitest';
import { unspinAngle, needsUnspin, UNSPIN_KINDS, drawUnspunCell } from '../unspin.js';

function recorder() {
  const calls = [];
  const ctx = {};
  for (const m of ['save', 'restore', 'translate', 'scale', 'rotate', 'drawImage']) {
    ctx[m] = (...a) => calls.push({ op: m, a });
  }
  return { ctx, calls };
}

describe('unspinAngle', () => {
  it('turns frame f of N back by f * 2pi / N', () => {
    expect(unspinAngle(0, 8)).toBe(0);
    expect(unspinAngle(2, 8)).toBeCloseTo(Math.PI / 2, 12);
    expect(unspinAngle(4, 8)).toBeCloseTo(Math.PI, 12);
  });
  it('wraps past the strip end', () => {
    expect(unspinAngle(9, 8)).toBeCloseTo(Math.PI / 4, 12);
  });
  it('a one-frame strip and non-finite input give 0', () => {
    expect(unspinAngle(3, 1)).toBe(0);
    expect(unspinAngle(NaN, 8)).toBe(0);
    expect(unspinAngle(2, NaN)).toBe(0);
    expect(unspinAngle(Infinity, 8)).toBe(0);
  });
});

describe('needsUnspin', () => {
  it('aura, buff and status strips (box kind aura) are un-spun; vfx rows are not', () => {
    expect(needsUnspin('aura')).toBe(true);
    expect(needsUnspin('buff')).toBe(true);
    expect(needsUnspin('status')).toBe(true);
    expect(needsUnspin('vfx')).toBe(false);
    expect(needsUnspin(undefined)).toBe(false);
    expect([...UNSPIN_KINDS].sort()).toEqual(['aura', 'buff', 'status']);
  });
});

describe('drawUnspunCell', () => {
  const img = {};
  it('angle 0: one plain drawImage at the squashed box, no transform', () => {
    const { ctx, calls } = recorder();
    drawUnspunCell(ctx, img, 128, 0, 128, 128, 100, 50, 80, 80, 0.5, 0);
    expect(calls).toEqual([{ op: 'drawImage', a: [img, 128, 0, 128, 128, 60, 30, 80, 40] }]);
  });
  it('ground: translate to the centre, squash, THEN rotate (rotation in the cell frame), drawn centred, restored', () => {
    const { ctx, calls } = recorder();
    drawUnspunCell(ctx, img, 256, 0, 128, 128, 100, 50, 80, 80, 0.5, Math.PI / 2);
    expect(calls.map((c) => c.op)).toEqual(['save', 'translate', 'scale', 'rotate', 'drawImage', 'restore']);
    expect(calls[1].a).toEqual([100, 50]);
    expect(calls[2].a).toEqual([1, 0.5]);
    expect(calls[3].a[0]).toBeCloseTo(Math.PI / 2, 12);
    expect(calls[4].a).toEqual([img, 256, 0, 128, 128, -40, -40, 80, 80]);
  });
  it('upright (squash 1): no scale call', () => {
    const { ctx, calls } = recorder();
    drawUnspunCell(ctx, img, 0, 0, 10, 10, 5, 5, 20, 30, 1, 1);
    expect(calls.map((c) => c.op)).toEqual(['save', 'translate', 'rotate', 'drawImage', 'restore']);
    expect(calls[3].a).toEqual([img, 0, 0, 10, 10, -10, -15, 20, 30]);
  });
});
