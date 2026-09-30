// Generated icons for the canvas UI (SOMET-598): skills, passive labels, items.
//
// The index (GET /api/game-art) says which subjects HAVE art and where it is;
// the pixels are fetched here lazily, the first time a surface asks for one.
// Nothing is preloaded: 300 skills + 128 labels + 279 items at join is exactly
// the kind of burst that tripped the asset limiter before (the 194-sprite 429
// flood), and a player sees maybe a dozen icons per panel.
//
// Every caller must treat `icon()` returning null as normal -- no index yet,
// no art for that subject, still loading, or the load failed -- and draw what
// it drew before this existed (emoji, circle, initials). That fallback is the
// whole contract; an icon is an upgrade, never a dependency.
import { assetUrl } from '../net/assets.js';

export class GameArt {
  constructor(imageManager, apiUrl) {
    this.imageManager = imageManager;
    this.apiUrl = apiUrl;
    this.index = null;
    // Names already handed to the ImageManager. A failed load stays failed
    // (ImageManager.get keeps answering null) and is NOT retried: icon() runs
    // every frame, so a retry-on-miss would re-request a 404 at frame rate --
    // the minimap's retry storm, again.
    this.requested = new Set();
  }

  setIndex(index) {
    this.index = index && typeof index === 'object' ? index : null;
  }

  // The loaded image for (kind, key), or null. A miss with art available
  // starts the one load; later frames pick the image up once it lands.
  icon(kind, key) {
    if (key == null) return null;
    const entry = this.index?.[kind]?.[key];
    if (!entry || !entry.image) return null;
    const name = `art:${entry.image}`;
    const img = this.imageManager.get(name);
    if (img) return img;
    if (!this.requested.has(name)) {
      this.requested.add(name);
      this.imageManager.load(name, assetUrl(this.apiUrl, entry.image, entry.v));
    }
    return null;
  }
}

// `art` may be null (tests, a panel drawn before join finished) -- callers
// pass whatever they were given and get null back.
export function artIcon(art, kind, key) {
  return art && typeof art.icon === 'function' ? art.icon(kind, key) : null;
}

// Draw `img` inside the size x size box at (x, y), aspect preserved and
// centred. The generated icons are not all square, and the 5-arg drawImage
// stretches whatever it is given into the box.
//
// Smoothing is forced ON for this one draw: the game's context runs with
// imageSmoothingEnabled = false (crisp pixel sprites), and a 256 px icon
// nearest-neighbour-sampled down to 20-48 px turns into noise.
export function drawIconFit(ctx, img, x, y, size) {
  const w = img.naturalWidth || img.width || size;
  const h = img.naturalHeight || img.height || size;
  const scale = Math.min(size / w, size / h);
  const dw = w * scale;
  const dh = h * scale;
  const prevSmoothing = ctx.imageSmoothingEnabled;
  const prevQuality = ctx.imageSmoothingQuality;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
  ctx.imageSmoothingEnabled = prevSmoothing;
  ctx.imageSmoothingQuality = prevQuality;
}
