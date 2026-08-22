import { describe, it, expect } from 'vitest';
import {
  terrainLayerGeometry,
  terrainLayerOffset,
  drawTerrainLayer,
  createTerrainLayerCache,
  terrainBlit,
} from '../minimapTerrainLayer.js';
import { worldTileToView, drawMinimap } from '../minimapRenderer.js';

// A 4x3 window of coarse cells with one hole, at a non-zero origin so a bug
// that assumes the window starts at (0,0) cannot pass.
function makeOverview(overrides = {}) {
  return {
    world_id: 7,
    originCol: 320,
    originRow: 256,
    cols: 4,
    rows: 3,
    step: 4,
    tiles: [
      ['grass', 'grass', 'sand', 'grass'],
      ['grass', null, 'sand', 'water'],
      ['water', 'water', 'grass', 'grass'],
    ],
    ...overrides,
  };
}

const COLORS = { grass: '#0f0', sand: '#fc0', water: '#00f' };

// Records the calls a canvas 2D context would receive.
function recorderCtx() {
  const calls = [];
  const ctx = {
    calls,
    set fillStyle(v) { calls.push(['fillStyle', v]); },
    get fillStyle() { return null; },
    beginPath() { calls.push(['beginPath']); },
    moveTo(x, y) { calls.push(['moveTo', x, y]); },
    lineTo(x, y) { calls.push(['lineTo', x, y]); },
    closePath() { calls.push(['closePath']); },
    fill() { calls.push(['fill']); },
    setTransform(...a) { calls.push(['setTransform', ...a]); },
    drawImage(...a) { calls.push(['drawImage', ...a]); },
    // Marker drawing runs after the terrain in drawMinimap; these exist so the
    // whole frame completes and the terrain assertions are made against a real
    // full render rather than an aborted one.
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    translate(x, y) { calls.push(['translate', x, y]); },
    rotate(a) { calls.push(['rotate', a]); },
    arc(...a) { calls.push(['arc', ...a]); },
    fillRect(...a) { calls.push(['fillRect', ...a]); },
    stroke() { calls.push(['stroke']); },
    set strokeStyle(v) { calls.push(['strokeStyle', v]); },
    get strokeStyle() { return null; },
    set lineWidth(v) { calls.push(['lineWidth', v]); },
    get lineWidth() { return null; },
    set globalAlpha(v) { calls.push(['globalAlpha', v]); },
    get globalAlpha() { return null; },
  };
  return ctx;
}

function fakeCanvasFactory() {
  const made = [];
  const factory = (w, h) => {
    const canvas = { width: w, height: h, ctx: recorderCtx() };
    canvas.getContext = () => canvas.ctx;
    made.push(canvas);
    return canvas;
  };
  factory.made = made;
  return factory;
}

describe('terrainLayerGeometry', () => {
  it('is exactly big enough to hold the whole window', () => {
    const ov = makeOverview();
    const cellW = 12;
    const g = terrainLayerGeometry(ov, cellW);

    // Every cell's diamond, at its four extreme points, must land inside
    // [0, width] x [0, height] -- and the extremes must TOUCH the bounds, so
    // the bitmap is neither clipping terrain nor wasting memory.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let r = 0; r < ov.rows; r++) {
      for (let c = 0; c < ov.cols; c++) {
        const x = (c - r) * g.hw + g.padX;
        const y = (c + r) * g.hh + g.padY;
        minX = Math.min(minX, x - g.hw); maxX = Math.max(maxX, x + g.hw);
        minY = Math.min(minY, y - g.hh); maxY = Math.max(maxY, y + g.hh);
      }
    }
    expect(minX).toBeCloseTo(0);
    expect(minY).toBeCloseTo(0);
    expect(maxX).toBeCloseTo(g.width);
    expect(maxY).toBeCloseTo(g.height);
  });
});

describe('terrainLayerOffset', () => {
  // The property the whole optimisation rests on: blitting the bitmap at this
  // offset must put every cell exactly where the per-cell path used to draw it.
  // An offset that ignored the player, or dropped the iso skew, fails here.
  it('reproduces worldTileToView for every cell, at any player position', () => {
    const ov = makeOverview();
    const cellW = 19.2;
    const g = terrainLayerGeometry(ov, cellW);

    for (const [centerCol, centerRow] of [[320, 256], [333.5, 261.25], [300, 400]]) {
      const view = { centerCol, centerRow, step: ov.step, cellW, boxW: 640, boxH: 640 };
      const off = terrainLayerOffset(ov, view, g);
      for (let r = 0; r < ov.rows; r++) {
        for (let c = 0; c < ov.cols; c++) {
          const expected = worldTileToView(
            ov.originCol + c * ov.step, ov.originRow + r * ov.step, view,
          );
          expect(off.x + (c - r) * g.hw + g.padX).toBeCloseTo(expected.x);
          expect(off.y + (c + r) * g.hh + g.padY).toBeCloseTo(expected.y);
        }
      }
    }
  });

  it('translates by one diamond when the player moves one coarse cell east', () => {
    const ov = makeOverview();
    const g = terrainLayerGeometry(ov, 12);
    const base = { centerCol: 320, centerRow: 256, step: 4, cellW: 12, boxW: 180, boxH: 180 };
    const a = terrainLayerOffset(ov, base, g);
    const b = terrainLayerOffset(ov, { ...base, centerCol: 324 }, g);
    expect(a.x - b.x).toBeCloseTo(g.hw);
    expect(a.y - b.y).toBeCloseTo(g.hh);
  });
});

describe('drawTerrainLayer', () => {
  it('fills one diamond per non-empty cell, in the palette colour', () => {
    const ov = makeOverview();
    const g = terrainLayerGeometry(ov, 12);
    const ctx = recorderCtx();
    drawTerrainLayer(ctx, ov, COLORS, g);

    const fills = ctx.calls.filter((c) => c[0] === 'fill').length;
    expect(fills).toBe(11); // 12 cells, one hole
    const styles = ctx.calls.filter((c) => c[0] === 'fillStyle').map((c) => c[1]);
    expect(styles).toHaveLength(11);
    expect(new Set(styles)).toEqual(new Set(['#0f0', '#fc0', '#00f']));
  });

  it('falls back to the neutral colour for a tile the palette does not know', () => {
    const ov = makeOverview({ cols: 1, rows: 1, tiles: [['lava']] });
    const ctx = recorderCtx();
    drawTerrainLayer(ctx, ov, COLORS, terrainLayerGeometry(ov, 12));
    expect(ctx.calls.filter((c) => c[0] === 'fillStyle').map((c) => c[1])).toEqual(['#334155']);
  });
});

describe('createTerrainLayerCache', () => {
  const ov = makeOverview();

  it('renders the bitmap once and reuses it across frames', () => {
    const factory = fakeCanvasFactory();
    const cache = createTerrainLayerCache(factory);
    const first = cache.get(ov, COLORS, 12, 2);
    for (let i = 0; i < 60; i++) expect(cache.get(ov, COLORS, 12, 2)).toBe(first);
    expect(cache.builds).toBe(1);
    expect(factory.made).toHaveLength(1);
  });

  it('sizes the bitmap in device pixels and pre-scales the context', () => {
    const factory = fakeCanvasFactory();
    const cache = createTerrainLayerCache(factory);
    const layer = cache.get(ov, COLORS, 12, 2);
    const g = terrainLayerGeometry(ov, 12);
    expect(layer.canvas.width).toBe(Math.ceil(g.width * 2));
    expect(layer.canvas.height).toBe(Math.ceil(g.height * 2));
    expect(layer.canvas.ctx.calls[0]).toEqual(['setTransform', 2, 0, 0, 2, 0, 0]);
  });

  // Each of these four is a way the cached bitmap would go stale on screen.
  it.each([
    ['a refetched overview window', () => [makeOverview({ originCol: 384 }), COLORS, 12, 2]],
    ['a swapped palette', () => [ov, { ...COLORS }, 12, 2]],
    ['a different diamond size', () => [ov, COLORS, 19.2, 2]],
    ['a changed device pixel ratio', () => [ov, COLORS, 12, 1]],
  ])('rebuilds for %s', (_label, next) => {
    const cache = createTerrainLayerCache(fakeCanvasFactory());
    cache.get(ov, COLORS, 12, 2);
    cache.get(...next());
    expect(cache.builds).toBe(2);
  });

  it('has nothing to draw before the first overview arrives', () => {
    const factory = fakeCanvasFactory();
    const cache = createTerrainLayerCache(factory);
    expect(cache.get(null, COLORS, 12, 2)).toBeNull();
    expect(factory.made).toHaveLength(0);
  });
});

describe('drawMinimap terrain', () => {
  const ov = makeOverview();
  const view = { centerCol: 331, centerRow: 259, step: 4, cellW: 19.2, boxW: 640, boxH: 640 };
  const args = {
    overview: ov,
    player: { col: 331, row: 259, dir: { dx: 0, dy: 1 } },
    creatures: [], doorways: [], villages: [], landmarks: [], phase: 0, view,
  };

  it('copies only the visible part of the bitmap, 1:1, in one blit', () => {
    const dpr = 2;
    const cache = createTerrainLayerCache(fakeCanvasFactory());
    const layer = cache.get(ov, COLORS, view.cellW, dpr);
    const ctx = recorderCtx();
    drawMinimap(ctx, { ...args, terrainLayer: layer });

    const blits = ctx.calls.filter((c) => c[0] === 'drawImage');
    expect(blits).toHaveLength(1);
    const [, canvas, sx, sy, sw, sh, dx, dy, dw, dh] = blits[0];
    expect(canvas).toBe(layer.canvas);

    // The destination never spills outside the box...
    expect(dx).toBeGreaterThanOrEqual(0);
    expect(dy).toBeGreaterThanOrEqual(0);
    expect(dx + dw).toBeLessThanOrEqual(view.boxW);
    expect(dy + dh).toBeLessThanOrEqual(view.boxH);

    // ...and the source is the matching sub-rectangle at the SAME scale, so the
    // copy is never resampled. Handing drawImage the whole bitmap instead
    // measured slower than the per-cell loop this replaced, so the clipping is
    // the point of the change, not an incidental tidy-up.
    expect(sw).toBe(Math.round(dw * dpr));
    expect(sh).toBe(Math.round(dh * dpr));
    expect(sw).toBeLessThan(layer.canvas.width);

    // Source and destination line up with the true offset, within the half
    // device pixel the snapping is allowed to move things.
    const g = terrainLayerGeometry(ov, view.cellW);
    const off = terrainLayerOffset(ov, view, g);
    expect(Math.abs((dx - sx / dpr) - off.x)).toBeLessThanOrEqual(0.5 / dpr);
    expect(Math.abs((dy - sy / dpr) - off.y)).toBeLessThanOrEqual(0.5 / dpr);
  });

  it('draws nothing when the window has scrolled out of the box entirely', () => {
    const cache = createTerrainLayerCache(fakeCanvasFactory());
    const layer = cache.get(ov, COLORS, view.cellW, 1);
    // A player centre thousands of coarse cells away puts the whole bitmap off
    // screen; the guard has to notice rather than ask for a negative rectangle.
    const far = { ...view, centerCol: ov.originCol + 40000, centerRow: ov.originRow };
    expect(terrainBlit(ov, far, layer)).toBeNull();
    const ctx = recorderCtx();
    drawMinimap(ctx, { ...args, view: far, player: { col: far.centerCol, row: far.centerRow, dir: { dx: 0, dy: 1 } }, terrainLayer: layer });
    expect(ctx.calls.filter((c) => c[0] === 'drawImage')).toHaveLength(0);
  });

  it('draws no terrain at all when the layer is not built yet', () => {
    const ctx = recorderCtx();
    drawMinimap(ctx, { ...args, terrainLayer: null });
    expect(ctx.calls.filter((c) => c[0] === 'drawImage')).toHaveLength(0);
  });
});
