import { describe, it, expect } from 'vitest';
import { ScaledImageCache } from '../scaledImageCache.js';

// SOMET-779: every decoration drew its full-size source (up to 1024px) down
// to ~32-120px on EVERY frame. The cache bakes one copy per image + size.
describe('ScaledImageCache', () => {
  const img = { width: 1024, height: 1024, complete: true };
  it('builds once per image and integer size, then reuses it', () => {
    let builds = 0;
    const cache = new ScaledImageCache((src, w, h) => { builds++; return { w, h, src }; });
    const a = cache.get(img, 32.4, 23.6);
    const b = cache.get(img, 32.2, 24.4);
    expect(a).toBe(b);
    expect(a).toMatchObject({ w: 32, h: 24, src: img });
    expect(builds).toBe(1);
  });
  it('a different size or image is a different copy', () => {
    const cache = new ScaledImageCache((src, w, h) => ({ w, h, src }));
    const other = { width: 512, height: 512, complete: true };
    expect(cache.get(img, 32, 24)).not.toBe(cache.get(img, 64, 48));
    expect(cache.get(img, 32, 24)).not.toBe(cache.get(other, 32, 24));
  });
  it('an image that has not loaded (no width) is not cached', () => {
    const cache = new ScaledImageCache(() => { throw new Error('must not build'); });
    expect(cache.get({ width: 0, height: 0, complete: false }, 32, 24)).toBe(null);
  });
  it('a zero-size target is not cached', () => {
    const cache = new ScaledImageCache(() => { throw new Error('must not build'); });
    expect(cache.get(img, 0.2, 24)).toBe(null);
  });
});

import { RenderSystem } from '../RenderSystem.js';
describe('static entity art draws the pre-scaled copy', () => {
  it('blits the cached copy 1:1 at a whole-pixel position', () => {
    const calls = [];
    const ctx = { drawImage: (...a) => calls.push(a), save() {}, restore() {}, imageSmoothingEnabled: true };
    const src = { width: 1024, height: 1024, complete: true };
    const rs = new RenderSystem({ getContext: () => ctx }, { get: () => src });
    const copy = { width: 32, height: 32, copy: true };
    rs._scaledArt = { get: () => copy };
    rs._drawEntityArt({ image: 'k', render_mode: 'static' }, 100.4, 200.6, 32, 32);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([copy, 100, 201, 32, 32]);
  });
  it('falls back to the source when no copy can be made', () => {
    const calls = [];
    const ctx = { drawImage: (...a) => calls.push(a), save() {}, restore() {}, imageSmoothingEnabled: true };
    const src = { width: 1024, height: 1024, complete: true };
    const rs = new RenderSystem({ getContext: () => ctx }, { get: () => src });
    rs._scaledArt = { get: () => null };
    rs._drawEntityArt({ image: 'k', render_mode: 'static' }, 100, 200, 32, 32);
    expect(calls[0][0]).toBe(src);
  });
});
