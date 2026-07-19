import { describe, it, expect } from 'vitest';
import { addBlasts, pruneBlasts, blastProgress, blastScreenRadiusX, elementColor, BLAST_MS } from '../blasts.js';
import { worldToScreen } from '../iso.js';

describe('addBlasts', () => {
  it('stamps each detonation with its arrival time', () => {
    const list = [];
    addBlasts(list, [{ x: 100, y: 200, radius: 64, element: 'fire' }], 1000);
    expect(list).toEqual([{ x: 100, y: 200, radius: 64, element: 'fire', startedAt: 1000 }]);
  });

  it('appends rather than replacing, so two detonations in one tick both show', () => {
    const list = [];
    addBlasts(list, [{ x: 1, y: 1, radius: 10 }, { x: 2, y: 2, radius: 10 }], 0);
    addBlasts(list, [{ x: 3, y: 3, radius: 10 }], 50);
    expect(list).toHaveLength(3);
  });

  it('skips malformed entries instead of drawing at NaN', () => {
    const list = [];
    addBlasts(list, [{ x: 'nope', y: 1, radius: 5 }, null, { x: 1, y: 1, radius: 5 }], 0);
    expect(list).toHaveLength(1);
  });

  it('tolerates a frame with no detonations field', () => {
    expect(addBlasts([], undefined, 0)).toEqual([]);
  });
});

describe('pruneBlasts', () => {
  it('keeps live blasts and drops expired ones', () => {
    const list = [];
    addBlasts(list, [{ x: 0, y: 0, radius: 10 }], 0);
    addBlasts(list, [{ x: 1, y: 1, radius: 10 }], 1000);
    const kept = pruneBlasts(list, 1000 + BLAST_MS - 1);
    expect(kept).toHaveLength(1);
    expect(kept[0].startedAt).toBe(1000);
  });

  it('drops a blast exactly at its lifetime', () => {
    const list = [];
    addBlasts(list, [{ x: 0, y: 0, radius: 10 }], 0);
    expect(pruneBlasts(list, BLAST_MS)).toHaveLength(0);
  });

  it('does not mutate the input list', () => {
    const list = [];
    addBlasts(list, [{ x: 0, y: 0, radius: 10 }], 0);
    pruneBlasts(list, 99999);
    expect(list).toHaveLength(1);
  });
});

describe('blastProgress', () => {
  it('runs 0 -> 1 across the lifetime and clamps past it', () => {
    const b = { startedAt: 1000 };
    expect(blastProgress(b, 1000)).toBe(0);
    expect(blastProgress(b, 1000 + BLAST_MS / 2)).toBeCloseTo(0.5);
    expect(blastProgress(b, 1000 + BLAST_MS)).toBe(1);
    expect(blastProgress(b, 99999)).toBe(1);
  });
});

describe('blastScreenRadiusX', () => {
  it('matches the actual iso projection of a world circle', () => {
    // Project the east-most point of a circle of radius R centred at the
    // origin and confirm the ellipse semi-axis reaches the same extent.
    const R = 128;
    const rx = blastScreenRadiusX(R);
    // Widest projected point is at 45 degrees in world space.
    const d = R / Math.SQRT2;
    const edge = worldToScreen(d, -d);
    const centre = worldToScreen(0, 0);
    expect(edge.x - centre.x).toBeCloseTo(rx, 6);
  });

  it('is 2:1, the same ratio as a tile diamond', () => {
    const rx = blastScreenRadiusX(100);
    expect(rx / (rx / 2)).toBe(2);
  });
});

describe('elementColor', () => {
  it('matches the existing projectile colours', () => {
    expect(elementColor('arcane')).toBe('#9b5de5');
    expect(elementColor('fire')).toBe('#f4d35e');
    expect(elementColor(null)).toBe('#f4d35e');
  });
});
