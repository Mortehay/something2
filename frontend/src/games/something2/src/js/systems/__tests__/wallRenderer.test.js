import { describe, it, expect } from 'vitest';
import { wallFaces, compareDrawables, wallRevealed, shadeColor } from '../wallRenderer.js';

describe('wallFaces', () => {
  it('lifts the top diamond by H and builds the two south faces', () => {
    const f = wallFaces({ x: 100, y: 100 }, 64, 32, 48);
    // top diamond corners, each lifted by H=48: top, right, bottom, left
    expect(f.top).toEqual([
      { x: 100, y: 20 }, { x: 164, y: 52 }, { x: 100, y: 84 }, { x: 36, y: 52 },
    ]);
    // left (SW) face: liftedLeft, liftedBottom, groundBottom, groundLeft
    expect(f.left).toEqual([
      { x: 36, y: 52 }, { x: 100, y: 84 }, { x: 100, y: 132 }, { x: 36, y: 100 },
    ]);
    // right (SE) face: liftedBottom, liftedRight, groundRight, groundBottom
    expect(f.right).toEqual([
      { x: 100, y: 84 }, { x: 164, y: 52 }, { x: 164, y: 100 }, { x: 100, y: 132 },
    ]);
  });
});

describe('compareDrawables', () => {
  it('sorts by order first, then depth', () => {
    expect(compareDrawables({ order: 0, depth: 10 }, { order: 0, depth: 5 })).toBeGreaterThan(0);
    expect(compareDrawables({ order: 1, depth: 0 }, { order: 0, depth: 999 })).toBeGreaterThan(0); // higher order always later
    expect(compareDrawables({ order: 0, depth: 5 }, { order: 0, depth: 5 })).toBe(0);
  });
});

describe('wallRevealed', () => {
  const wall = { x: 100, y: 100, depth: 200 };
  it('reveals when an actor is behind-or-equal and within R', () => {
    expect(wallRevealed(wall, [{ x: 120, y: 100, depth: 180 }], 150)).toBe(true); // behind (180<=200), 20px away
  });
  it('does not reveal an actor in front of the wall', () => {
    expect(wallRevealed(wall, [{ x: 110, y: 100, depth: 260 }], 150)).toBe(false); // in front (260>200)
  });
  it('does not reveal when out of radius', () => {
    expect(wallRevealed(wall, [{ x: 400, y: 400, depth: 100 }], 150)).toBe(false);
  });
  it('is false with no actors', () => {
    expect(wallRevealed(wall, [], 150)).toBe(false);
  });
});

describe('shadeColor', () => {
  it('darkens a 6-digit hex color', () => {
    const result = shadeColor('#808080', -0.5);
    // #808080 = rgb(128, 128, 128); darken by 50% => rgb(64, 64, 64)
    expect(result).toBe('rgb(64, 64, 64)');
  });
  it('darkens a 3-digit shorthand hex color the same way', () => {
    const result = shadeColor('#888', -0.5);
    // #888 expands to #888888 = rgb(136, 136, 136); darken by 50% => rgb(68, 68, 68)
    expect(result).toBe('rgb(68, 68, 68)');
  });
  it('returns the same channels when amt is 0 (no darkening)', () => {
    const result = shadeColor('#808080', 0);
    expect(result).toBe('rgb(128, 128, 128)');
  });
  it('returns input unchanged for unparseable colors', () => {
    const result = shadeColor('nope', -0.5);
    expect(result).toBe('nope');
  });
});
