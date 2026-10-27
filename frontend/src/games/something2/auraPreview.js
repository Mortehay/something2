// Live preview for the Aura Effects admin (SOMET-604). Pulse maths come from
// core/auraVisual.js and particles from core/vfx.js's particlesAt -- the same
// functions S5's renderer must use. Flat screen space, not iso: a legibility
// aid, not a world simulation. The aura is drawn at a fixed preview scale with
// a 48px creature box for size reference.
import { particlesAt } from './src/js/core/vfx.js';
import { auraPulse, auraParticleFx } from './src/js/core/auraVisual.js';

export function drawAuraPreview(ctx, w, h, def, elapsedMs) {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2; const cy = h / 2;
  const maxR = Math.min(w, h) * 0.45;
  const scaleWorld = maxR / Math.max(Number(def.radius) || 1, 48);
  const { scale, alpha } = auraPulse(def, elapsedMs);
  const r = (Number(def.radius) || 0) * scaleWorld * scale;
  ctx.save();
  ctx.strokeStyle = def.color || '#d4a017';
  ctx.fillStyle = def.color || '#d4a017';
  if (def.shape === 'disc') {
    ctx.globalAlpha = alpha * 0.6;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  } else if (def.shape === 'ring') {
    ctx.globalAlpha = Math.min(1, alpha * 2); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  }
  const count = Math.floor(Number(def.particle_count) || 0);
  if (count > 0 || def.shape === 'particles') {
    const pdef = { ...def, particle_count: count || 16 };
    const { fx, t } = auraParticleFx(pdef, elapsedMs);
    const size = Math.max(1, Number(def.particle_size) || 2);
    for (const p of particlesAt(fx, t)) {
      ctx.globalAlpha = p.alpha;
      ctx.fillRect(cx + p.dx * scaleWorld - size / 2, cy + p.dy * scaleWorld - size / 2, size, size);
    }
  }
  ctx.globalAlpha = 1; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; // s2-theme-exempt(#ffffff): reference box on the dark preview canvas
  const box = 48 * scaleWorld; ctx.strokeRect(cx - box / 2, cy - box / 2, box, box);
  ctx.restore();
}
