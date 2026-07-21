import { describe, it, expect, vi } from 'vitest';
import { tileFrameKey, resolveTileVisual } from '../spriteAtlas.js';
import { TileDiamondCache } from '../tileTexture.js';

const MANIFEST = { cell: [10, 10], frames: { '0': [0, 0, 10, 10], '1': [10, 0, 10, 10],
  '2': [0, 10, 10, 10], '3': [10, 10, 10, 10] } };

describe('tileFrameKey', () => {
  it('cycles frame indices at fps over time', () => {
    // fps=4 → each frame lasts 250ms; at t=0 → "0", t=300 → "1", t=600 → "2".
    expect(tileFrameKey(MANIFEST, 0, 4)).toBe('0');
    expect(tileFrameKey(MANIFEST, 300, 4)).toBe('1');
    expect(tileFrameKey(MANIFEST, 600, 4)).toBe('2');
    // wraps after the last frame
    expect(tileFrameKey(MANIFEST, 1000, 4)).toBe('0');
  });
  it('returns null when there are no frames', () => {
    expect(tileFrameKey({ frames: {} }, 0)).toBeNull();
    expect(tileFrameKey(null, 0)).toBeNull();
  });
});

describe('resolveTileVisual', () => {
  const loadedImg = { _tag: 'img' };
  const loadedAtlas = { _tag: 'atlas' };

  it('returns null for color mode (draw the flat diamond)', () => {
    const def = { color: '#0f0', render_mode: 'color' };
    expect(resolveTileVisual('grass', def, { get: () => null }, 0)).toBeNull();
  });

  it('image mode returns the whole static image (no crop) when loaded', () => {
    const def = { render_mode: 'image', image: 'k/static.png' };
    const im = { get: (k) => (k === 'k/static.png' ? loadedImg : null) };
    const v = resolveTileVisual('grass', def, im, 0);
    expect(v).toEqual({ img: loadedImg, crop: null, cacheKey: 'grass|image' });
  });

  it('image mode returns null while the texture is still loading (→ color)', () => {
    const def = { render_mode: 'image', image: 'k/static.png' };
    expect(resolveTileVisual('grass', def, { get: () => null }, 0)).toBeNull();
  });

  it('animated mode crops the current atlas frame when atlas+manifest are ready', () => {
    const def = { render_mode: 'animated', image: 'w/static.png',
      sprite: { atlas_key: 'w/atlas.png' }, _manifest: MANIFEST };
    const im = { get: (k) => (k === 'w/atlas.png' ? loadedAtlas : null) };
    const v = resolveTileVisual('water', def, im, 300);  // frame "1"
    expect(v).toEqual({ img: loadedAtlas, crop: [10, 0, 10, 10], cacheKey: 'water|animated|1' });
  });

  it('animated mode falls back to the static image when the manifest is missing', () => {
    const def = { render_mode: 'animated', image: 'w/static.png',
      sprite: { atlas_key: 'w/atlas.png' } /* no _manifest */ };
    const im = { get: (k) => (k === 'w/static.png' ? loadedImg : null) };
    const v = resolveTileVisual('water', def, im, 0);
    expect(v).toEqual({ img: loadedImg, crop: null, cacheKey: 'water|image' });
  });

  it('override forces the mode', () => {
    const def = { render_mode: 'animated', image: 'k/static.png', color: '#0f0' };
    // override 'color' → null even though the def says animated
    expect(resolveTileVisual('grass', def, { get: () => ({}) }, 0, 'color')).toBeNull();
  });
});

describe('TileDiamondCache', () => {
  it('builds a canvas once per cache key and returns the cached instance', () => {
    const build = vi.fn((img, crop) => ({ built: img, crop }));
    const cache = new TileDiamondCache(build);
    const a1 = cache.get('grass|image', { i: 1 }, null);
    const a2 = cache.get('grass|image', { i: 1 }, null);
    expect(a1).toBe(a2);
    expect(build).toHaveBeenCalledTimes(1);
    cache.get('water|animated|1', { i: 2 }, [0, 0, 8, 8]);
    expect(build).toHaveBeenCalledTimes(2);  // new key → rebuild
  });
});
