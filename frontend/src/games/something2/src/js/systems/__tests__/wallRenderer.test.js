import { describe, it, expect } from 'vitest';
import { wallFaces, compareDrawables, wallRevealed, shadeColor, drawWall, thinWallBoxes, projectBox, drawThinWall, wallNeighbours, drawWallDrawable, BLOCK_WALL_TILES } from '../wallRenderer.js';

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

describe('drawWall textured side faces', () => {
  // A recording 2D-context stub: captures the ordered method calls so we can
  // assert HOW the side texture is drawn (composed vs. matrix-replaced).
  function recordingCtx() {
    const calls = [];
    const rec = (name) => (...args) => calls.push({ name, args });
    return {
      calls,
      save: rec('save'), restore: rec('restore'),
      beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
      closePath: rec('closePath'), clip: rec('clip'),
      transform: rec('transform'), setTransform: rec('setTransform'),
      drawImage: rec('drawImage'), fill: rec('fill'),
      set fillStyle(v) { calls.push({ name: 'fillStyle', args: [v] }); },
      set globalAlpha(v) { calls.push({ name: 'globalAlpha', args: [v] }); },
    };
  }

  const visual = { img: { width: 32, height: 32 }, crop: null, cacheKey: 'k' };
  const tileCache = { get: () => ({ fake: 'canvas' }) };
  const args = () => ({
    s: { x: 500, y: 400 }, def: { color: '#abcabc' }, visual,
    H: 48, alpha: 1, halfW: 64, halfH: 32, tileCache,
  });

  it('composes the affine onto the camera transform (never replaces it) for side faces', () => {
    const ctx = recordingCtx();
    drawWall(ctx, args());
    const names = ctx.calls.map((c) => c.name);
    // The two side faces must compose via transform()...
    expect(names.filter((n) => n === 'transform').length).toBe(2);
    // ...and MUST NOT call setTransform, which would drop the camera pan (the bug).
    expect(names).not.toContain('setTransform');
  });

  it('draws the side texture image (not just a solid fill)', () => {
    const ctx = recordingCtx();
    drawWall(ctx, args());
    // 2 side-face images + 1 top = 3 drawImage calls.
    expect(ctx.calls.filter((c) => c.name === 'drawImage').length).toBe(3);
  });
});

describe('thinWallBoxes', () => {
  it('isolated wall is a centre post only', () => {
    expect(thinWallBoxes({ n: false, e: false, s: false, w: false }))
      .toEqual([{ x0: -12.5, y0: -12.5, x1: 12.5, y1: 12.5 }]);
  });
  it('adds one arm per connected side, back-to-front', () => {
    const b = thinWallBoxes({ n: true, e: true, s: false, w: false });
    expect(b).toEqual([
      { x0: -12.5, y0: -50, x1: 12.5, y1: -12.5 }, // N arm (depth -31.25)
      { x0: -12.5, y0: -12.5, x1: 12.5, y1: 12.5 }, // post (0)
      { x0: 12.5, y0: -12.5, x1: 50, y1: 12.5 },    // E arm (+31.25)
    ]);
  });
  it('all four arms: N and W before post, E and S after', () => {
    const b = thinWallBoxes({ n: true, e: true, s: true, w: true });
    expect(b.length).toBe(5);
    expect(b[2]).toEqual({ x0: -12.5, y0: -12.5, x1: 12.5, y1: 12.5 });
    const depth = (r) => (r.x0 + r.x1) / 2 + (r.y0 + r.y1) / 2;
    for (let i = 1; i < b.length; i++) expect(depth(b[i])).toBeGreaterThanOrEqual(depth(b[i - 1]));
  });
});

describe('projectBox', () => {
  it('projects the post with ISO_K 0.64 and lifts the top by H', () => {
    const p = projectBox({ x: 0, y: 0 }, { x0: -12.5, y0: -12.5, x1: 12.5, y1: 12.5 }, 48);
    expect(p.top).toEqual([{ x: 0, y: -56 }, { x: 16, y: -48 }, { x: 0, y: -40 }, { x: -16, y: -48 }]);
    expect(p.south).toEqual([{ x: -16, y: -48 }, { x: 0, y: -40 }, { x: 0, y: 8 }, { x: -16, y: 0 }]);
    expect(p.east).toEqual([{ x: 16, y: -48 }, { x: 0, y: -40 }, { x: 0, y: 8 }, { x: 16, y: 0 }]);
  });
  it('offsets by the tile centre screen position', () => {
    const p = projectBox({ x: 100, y: 200 }, { x0: -12.5, y0: -12.5, x1: 12.5, y1: 12.5 }, 0);
    expect(p.top[0]).toEqual({ x: 100, y: 192 });
  });
});

describe('drawThinWall', () => {
  // Records each fill() with the points of the path it filled.
  function spyCtx() {
    let path = [];
    const ctx = {
      fills: [], images: [], globalAlpha: 1, fillStyle: null,
      save() {}, restore() {}, clip() {}, transform() {}, closePath() {},
      beginPath() { path = []; }, moveTo(x, y) { path.push({ x, y }); }, lineTo(x, y) { path.push({ x, y }); },
      fill() { ctx.fills.push({ points: path.slice(), style: ctx.fillStyle }); },
      drawImage(...a) { ctx.images.push(a); },
    };
    return ctx;
  }
  const def = { color: '#806040' };
  const none = { n: false, e: false, s: false, w: false };

  it('colour-only isolated wall fills 3 quads: south, east, top', () => {
    const ctx = spyCtx();
    drawThinWall(ctx, { s: { x: 0, y: 0 }, def, visual: null, H: 48, alpha: 1, neighbours: none });
    expect(ctx.fills.length).toBe(3);
    expect(ctx.fills[0].points).toEqual([{ x: -16, y: -48 }, { x: 0, y: -40 }, { x: 0, y: 8 }, { x: -16, y: 0 }]);
    expect(ctx.fills[2].points).toEqual([{ x: 0, y: -56 }, { x: 16, y: -48 }, { x: 0, y: -40 }, { x: -16, y: -48 }]);
  });

  it('draws each box faces-then-top, back box before front box', () => {
    const ctx = spyCtx();
    drawThinWall(ctx, { s: { x: 0, y: 0 }, def, visual: null, H: 48, alpha: 1, neighbours: { ...none, s: true } });
    expect(ctx.fills.length).toBe(6);
    expect(ctx.fills[2].points[0]).toEqual({ x: 0, y: -56 }); // post top
    expect(ctx.fills[3].points[0].y).toBeGreaterThan(ctx.fills[2].points[0].y); // S arm face after it
  });

  it('restores globalAlpha to 1', () => {
    const ctx = spyCtx();
    drawThinWall(ctx, { s: { x: 0, y: 0 }, def, visual: null, H: 24, alpha: 0.4, neighbours: { ...none, n: true } });
    expect(ctx.globalAlpha).toBe(1);
  });

  it('textured faces sample only their share of the texture', () => {
    const ctx = spyCtx();
    const visual = { img: { width: 400, height: 200 }, crop: null };
    drawThinWall(ctx, { s: { x: 0, y: 0 }, def, visual, H: 48, alpha: 1, neighbours: none });
    expect(ctx.images.length).toBe(3); // south, east, top
    // south face of the post spans x -12.5..12.5 of a 100px tile -> middle quarter of the width
    const [, sx, sy, sw, sh] = ctx.images[0];
    expect([sx, sy, sw, sh]).toEqual([150, 0, 100, 200]);
  });
});

describe('wallNeighbours', () => {
  const defs = { wooden_wall: { wall_height: 48 }, village_gate: { wall_height: 24 }, cave_wall: { wall_height: 48 }, grass: { wall_height: 0 } };
  const grid = new Map([['150,50', 'wooden_wall'], ['50,150', 'village_gate'], ['-50,50', 'grass']]);
  const getTile = (x, y) => grid.get(`${x},${y}`) ?? null; // (50,-50) absent = unloaded chunk
  const getDef = (n) => defs[n] || null;
  it('connects to walls and gates, not floor, not an unloaded chunk', () => {
    expect(wallNeighbours(getTile, getDef, 50, 50)).toEqual({ n: false, e: true, s: true, w: false });
  });
  it('connects to cave_wall', () => {
    const g = (x, y) => (x === 50 && y === -50 ? 'cave_wall' : null);
    expect(wallNeighbours(g, getDef, 50, 50).n).toBe(true);
  });
  it('unknown tile def does not connect and does not throw', () => {
    expect(wallNeighbours(() => 'mystery', getDef, 50, 50)).toEqual({ n: false, e: false, s: false, w: false });
  });
});

describe('drawWallDrawable dispatch', () => {
  function spyCtx() {
    let path = [];
    const ctx = {
      fills: [], globalAlpha: 1, fillStyle: null,
      save() {}, restore() {}, clip() {}, transform() {}, closePath() {}, drawImage() {},
      beginPath() { path = []; }, moveTo(x, y) { path.push({ x, y }); }, lineTo(x, y) { path.push({ x, y }); },
      fill() { ctx.fills.push(path.slice()); },
    };
    return ctx;
  }
  const opts = { halfW: 64, halfH: 32, tileCache: { get: () => ({}) } };
  const none = { n: false, e: false, s: false, w: false };
  const d = (name) => ({ s: { x: 0, y: 0 }, def: { name, color: '#555555' }, visual: null, H: 48, neighbours: none });

  it('built walls draw thin: top right corner 16px from centre', () => {
    const ctx = spyCtx();
    drawWallDrawable(ctx, d('wooden_wall'), opts);
    expect(Math.max(...ctx.fills[ctx.fills.length - 1].map((p) => p.x))).toBe(16);
  });
  it('cave_wall keeps the full diamond block: top right corner 64px from centre', () => {
    expect(BLOCK_WALL_TILES.has('cave_wall')).toBe(true);
    const ctx = spyCtx();
    drawWallDrawable(ctx, d('cave_wall'), opts);
    expect(Math.max(...ctx.fills[ctx.fills.length - 1].map((p) => p.x))).toBe(64);
  });
  it('a drawable without neighbours (H 0 overlay) keeps the old draw', () => {
    const ctx = spyCtx();
    drawWallDrawable(ctx, { ...d('rug'), H: 0, neighbours: undefined }, opts);
    expect(Math.max(...ctx.fills[ctx.fills.length - 1].map((p) => p.x))).toBe(64);
  });
});
