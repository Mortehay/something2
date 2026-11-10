// Live preview for the Buff Auras admin. Laid out the way the game draws a buff aura
// (RenderSystem._drawBuffsOf): a ground aura lies flat on the feet point, 2r wide and
// flattened to width x aspect / 2; a body aura stands upright, scale x the figure height tall,
// centred on the figure. A 48 px figure box (the character) sits on the feet point for size
// reference. Flat screen space at a fixed preview scale, not a world simulation.
import { spriteFrameCount, spriteSourceRect } from './src/js/core/vfx.js';
import { withAlpha } from './src/js/core/rarityColors.js';

export const BUFF_FIGURE_PX = 48;
// Under a sprite on the reference (Sprite) canvas the fallback draws this faint.
export const FALLBACK_UNDER_SPRITE = 0.35;

const positive = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };

// The ground radius the game draws (core/buffAuras.js groundRadius): the buff's own effect radius
// (aura_radius, sent as the snapshot's auraRadius in game) wins over the row's radius.
export function previewGroundRadius(visual) {
  return positive(visual && visual.aura_radius, positive(visual && visual.radius, 64));
}

// World units -> preview pixels, chosen so the whole aura (and the figure) fits the canvas.
export function buffPreviewScale(w, h, visual) {
  if (visual && visual.placement === 'ground') {
    return (Math.min(w, h * 2) * 0.45) / Math.max(previewGroundRadius(visual), BUFF_FIGURE_PX);
  }
  return (h * 0.85) / (Math.max(positive(visual && visual.scale, 1.3), 1) * BUFF_FIGURE_PX);
}

// `image` null = the Code canvas (the fallback ring or glow). With an image the sprite replaces
// the fallback, as in the game; `reference: true` (the admin's Sprite canvas) keeps the
// fallback underneath at FALLBACK_UNDER_SPRITE.
export function drawBuffAuraPreview(ctx, w, h, visual, elapsedMs, image = null, { reference = false } = {}) {
  ctx.clearRect(0, 0, w, h);
  const ground = visual.placement === 'ground';
  const color = /^#[0-9a-fA-F]{6}$/.test(visual.color || '') ? visual.color : '#ffffff';
  const ps = buffPreviewScale(w, h, visual);
  const dh = BUFF_FIGURE_PX * ps;                 // drawn figure height
  const cx = w / 2;
  const fy = ground ? h * 0.62 : h / 2 + dh / 2;  // feet point
  const iw = image ? (image.naturalWidth || image.width) : 0;
  const ih = image ? (image.naturalHeight || image.height) : 0;
  const hasSprite = iw > 0 && ih > 0;
  const fallbackAlpha = hasSprite ? (reference ? FALLBACK_UNDER_SPRITE : 0) : 1;
  const r = previewGroundRadius(visual) * ps;     // ground radius
  const bh = positive(visual.scale, 1.3) * dh;    // body aura height
  const bcy = fy - dh / 2;

  ctx.save();
  if (fallbackAlpha > 0) {
    ctx.globalAlpha = fallbackAlpha;
    if (ground) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(cx, fy, r, r / 2, 0, 0, Math.PI * 2); ctx.stroke();
    } else {
      const g = ctx.createRadialGradient(cx, bcy, 0, cx, bcy, bh / 2);
      g.addColorStop(0, withAlpha(color, 0.55));
      g.addColorStop(0.6, withAlpha(color, 0.25));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, bcy, bh / 2, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (hasSprite) {
    const frames = spriteFrameCount(visual);
    const fps = Number(visual.sprite_fps) > 0 ? Number(visual.sprite_fps) : 10;
    const frame = Math.floor((Math.max(0, elapsedMs) * fps) / 1000) % frames;
    const { sx, sy, sw, sh } = spriteSourceRect(iw, ih, frames, frame);
    const aspect = sh / Math.max(1, sw);
    let dx; let dy; let dw; let dhh;
    if (ground) {
      dw = 2 * r; dhh = (dw * aspect) / 2; dx = cx - dw / 2; dy = fy - dhh / 2;
    } else {
      dhh = bh; dw = dhh / aspect; dx = cx - dw / 2; dy = bcy - dhh / 2;
    }
    const comp = ctx.globalCompositeOperation;
    ctx.globalAlpha = 1;
    if (visual.sprite_additive) ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dhh);
    ctx.globalCompositeOperation = comp;
  }
  ctx.globalAlpha = 1; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; // s2-theme-exempt(#ffffff): reference box on the dark preview canvas
  ctx.strokeRect(cx - dh / 2, fy - dh, dh, dh);
  ctx.restore();
}
