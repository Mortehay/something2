import { describe, it, expect } from 'vitest';
import { createTextLabelCache, drawCachedLabel } from '../textLabelCache.js';

// A canvas double that records what was drawn into it. measureText returns
// the full metric shape a real browser gives, so the geometry under test is
// the geometry that actually ships -- a bare { width } stub would exercise
// only the fallback path.
const CHAR_W = 7, ASCENT = 9, DESCENT = 3;

function fakeCanvasFactory(log = { created: [] }) {
  const make = (w, h) => {
    const ops = [];
    const canvas = {
      width: w,
      height: h,
      ops,
      getContext: () => ({
        ops,
        set font(v) { ops.push(['font', v]); },
        set textAlign(v) { ops.push(['textAlign', v]); },
        set lineWidth(v) { ops.push(['lineWidth', v]); },
        set strokeStyle(v) { ops.push(['strokeStyle', v]); },
        set fillStyle(v) { ops.push(['fillStyle', v]); },
        measureText: (t) => ({
          width: t.length * CHAR_W,
          actualBoundingBoxAscent: ASCENT,
          actualBoundingBoxDescent: DESCENT,
        }),
        strokeText: (...a) => ops.push(['strokeText', ...a]),
        fillText: (...a) => ops.push(['fillText', ...a]),
      }),
    };
    log.created.push(canvas);
    return canvas;
  };
  return { make, log };
}

const STYLE = {
  font: 'bold 12px monospace',
  fillStyle: '#ffd166',
  strokeStyle: 'rgba(0,0,0,0.85)',
  lineWidth: 2,
};

describe('textLabelCache', () => {
  it('rasterises a given label exactly once, however many times it is asked for', () => {
    const { make } = fakeCanvasFactory();
    const cache = createTextLabelCache({ createCanvas: make });

    for (let i = 0; i < 50; i++) cache.get('L7', STYLE);

    // THE assertion this file exists for. A cache that rebuilt every call
    // would still return a correct-looking bitmap every time, so correctness
    // of the output proves nothing about whether it cached.
    expect(cache.builds).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('keeps distinct labels apart and still builds each only once', () => {
    const { make } = fakeCanvasFactory();
    const cache = createTextLabelCache({ createCanvas: make });

    for (let round = 0; round < 10; round++) {
      for (const lvl of [2, 3, 5, 8, 13]) cache.get(`L${lvl}`, STYLE);
    }

    expect(cache.builds).toBe(5);
    expect(cache.size).toBe(5);
  });

  it('does not let two different styles collide on one bitmap', () => {
    const { make } = fakeCanvasFactory();
    const cache = createTextLabelCache({ createCanvas: make });

    const a = cache.get('L9', STYLE);
    const b = cache.get('L9', { ...STYLE, fillStyle: '#ff0000' });

    // Same text, different colour: they must not share an entry, or a
    // restyled label would silently render in the old colour.
    expect(a).not.toBe(b);
    expect(cache.builds).toBe(2);
  });

  it('draws stroke before fill, so the outline sits behind the glyph', () => {
    const { make } = fakeCanvasFactory();
    const cache = createTextLabelCache({ createCanvas: make });
    const entry = cache.get('L4', STYLE);

    const kinds = entry.canvas.ops.filter(([k]) => k === 'strokeText' || k === 'fillText');
    expect(kinds.map(([k]) => k)).toEqual(['strokeText', 'fillText']);
  });

  it('sizes the bitmap to fit the glyphs plus the stroke', () => {
    const { make } = fakeCanvasFactory();
    const cache = createTextLabelCache({ createCanvas: make, pad: 4 });
    const entry = cache.get('L12', STYLE); // 3 chars

    expect(entry.width).toBe(3 * CHAR_W + 8);
    expect(entry.height).toBe(ASCENT + DESCENT + 8);
    // Half of lineWidth 2 sits outside the outline; the padding must cover it.
    expect(entry.anchorY).toBeGreaterThanOrEqual(ASCENT + STYLE.lineWidth / 2);
  });

  it('anchors the bitmap so it lands where the centred text would have', () => {
    const { make } = fakeCanvasFactory();
    const cache = createTextLabelCache({ createCanvas: make, pad: 4 });
    const entry = cache.get('L12', STYLE);

    const drawn = [];
    const ctx = { drawImage: (img, x, y) => drawn.push({ img, x, y }) };
    drawCachedLabel(ctx, entry, 100, 200);

    // The original draw was textAlign 'center' + alphabetic baseline at
    // (100, 200), so the glyph centre must still be at x=100 and the baseline
    // at y=200 -- to within the half pixel drawCachedLabel deliberately gives
    // up by rounding the blit to whole pixels (see its comment: a fractional
    // destination resamples the bitmap and looks soft). Asserting exact
    // equality here would be asserting the blur.
    const { x, y } = drawn[0];
    expect(Math.abs((x + entry.anchorX) - 100)).toBeLessThanOrEqual(0.5);
    expect(Math.abs((y + entry.anchorY) - 200)).toBeLessThanOrEqual(0.5);
    expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
  });

  it('reports a miss rather than throwing when the text has no extent', () => {
    const { make } = fakeCanvasFactory();
    const cache = createTextLabelCache({ createCanvas: make });

    // Zero-width text would make a 0-area canvas, and drawImage of one throws
    // in some browsers -- so the cache must decline it.
    expect(cache.get('', STYLE)).toBeNull();
    expect(drawCachedLabel({ drawImage: () => { throw new Error('drew a null entry'); } }, null, 0, 0))
      .toBe(false);
  });

  it('refuses to construct without a canvas factory', () => {
    expect(() => createTextLabelCache({})).toThrow(/createCanvas/);
  });
});
