import { ISO_TILE_W, ISO_TILE_H } from '../core/constants.js';

// How far the built diamond extends BEYOND its tile, on every side. Callers
// must blit at (x - PAD, y - PAD), which is why this is exported rather than
// hidden: a caller that forgets shifts the whole ground layer.
//
// It exists because two diamonds that merely touch do not cover the line
// between them. clip() antialiases, so each neighbour contributes partial
// alpha along the shared edge and the background shows through as a hairline
// grid over the entire map. Overlapping by a pixel removes the gap outright
// instead of hiding it under a darker background.
export const TILE_DIAMOND_PAD = 2;

// How many pixels the edge fades over. This is what makes a stone tile meet a
// grass tile with a blend rather than a cut: the pad above puts neighbouring
// diamonds on top of each other, and a soft alpha edge cross-fades them there.
// Tiles are drawn in a fixed order, so the later one fades over the earlier.
//
// Kept small deliberately. A tile is 128x64, so anything much larger than this
// stops reading as a transition and starts reading as an out-of-focus map.
const EDGE_FEATHER = 2.5;

// Build a padded canvas with `img` (optionally the `crop` sub-rect) masked to
// the iso diamond, so the render loop can blit it with a single drawImage.
// Canvas-only — never called in the node test env.
export function buildDiamondCanvas(img, crop, { pad = TILE_DIAMOND_PAD, feather = EDGE_FEATHER } = {}) {
  const W = ISO_TILE_W + pad * 2;
  const H = ISO_TILE_H + pad * 2;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = false;

  // Mask first, image second, rather than clip-then-draw. A clip path cannot
  // be feathered -- it is a hard stencil with antialiasing only on the
  // boundary pixel -- so the mask is painted as a blurred shape and the image
  // is composited into it.
  if (feather > 0) cx.filter = `blur(${feather}px)`;
  cx.fillStyle = '#fff';
  cx.beginPath();
  cx.moveTo(W / 2, 0);
  cx.lineTo(W, H / 2);
  cx.lineTo(W / 2, H);
  cx.lineTo(0, H / 2);
  cx.closePath();
  cx.fill();
  cx.filter = 'none';

  cx.globalCompositeOperation = 'source-in';
  if (crop) {
    const [sx, sy, sw, sh] = crop;
    cx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  } else {
    cx.drawImage(img, 0, 0, W, H);
  }
  cx.globalCompositeOperation = 'source-over';
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
