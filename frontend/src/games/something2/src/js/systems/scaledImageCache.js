// SOMET-779: pre-scaled copies of static sprite art.
//
// drawImage(img, dx, dy, dw, dh) with a 1024px source and a 32px target
// resamples the whole source on every call. Static decorations are drawn
// hundreds of times a frame at the same size, so that resample was most of
// their cost. This bakes ONE copy per (image, integer size) and the caller
// blits it 1:1. Only for draws that are not animated per frame (sway/drift
// change the transform, not the source, but are left on the old path).
//
// Keyed by the image object (WeakMap: a reloaded image drops its copies)
// then by "WxH". `buildFn` is injectable so node tests need no canvas.
export function buildScaledCanvas(img, w, h) {
  if (typeof document === 'undefined') return null; // node tests: caller falls back
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(img, 0, 0, w, h);
  return c;
}

export class ScaledImageCache {
  constructor(buildFn = buildScaledCanvas) {
    this._build = buildFn;
    this._byImage = new WeakMap();
  }

  get(img, dw, dh) {
    if (!img || !(img.width > 0) || !(img.height > 0)) return null;
    const w = Math.round(dw), h = Math.round(dh);
    if (w < 1 || h < 1) return null;
    let sizes = this._byImage.get(img);
    if (!sizes) { sizes = new Map(); this._byImage.set(img, sizes); }
    const key = `${w}x${h}`;
    let canvas = sizes.get(key);
    if (!canvas) {
      canvas = this._build(img, w, h);
      if (!canvas) return null;
      sizes.set(key, canvas);
    }
    return canvas;
  }
}
