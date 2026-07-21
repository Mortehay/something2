import { ISO_TILE_W, ISO_TILE_H } from '../core/constants.js';

// Build an ISO_TILE_W x ISO_TILE_H canvas with `img` (optionally the `crop`
// sub-rect) clipped to the iso diamond, so the render loop can blit it with a
// single drawImage. Canvas-only — never called in the node test env.
export function buildDiamondCanvas(img, crop) {
  const W = ISO_TILE_W, H = ISO_TILE_H;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = false;
  cx.beginPath();
  cx.moveTo(W / 2, 0);
  cx.lineTo(W, H / 2);
  cx.lineTo(W / 2, H);
  cx.lineTo(0, H / 2);
  cx.closePath();
  cx.clip();
  if (crop) {
    const [sx, sy, sw, sh] = crop;
    cx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  } else {
    cx.drawImage(img, 0, 0, W, H);
  }
  return c;
}

// Memoizes one built canvas per cacheKey so the diamond mask is applied ONCE
// per texture/frame, not once per visible cell per frame. `buildFn` defaults to
// buildDiamondCanvas but is injectable for testing.
export class TileDiamondCache {
  constructor(buildFn = buildDiamondCanvas) {
    this._build = buildFn;
    this._cache = new Map();
  }

  get(cacheKey, img, crop) {
    let canvas = this._cache.get(cacheKey);
    if (!canvas) {
      canvas = this._build(img, crop);
      this._cache.set(cacheKey, canvas);
    }
    return canvas;
  }
}
