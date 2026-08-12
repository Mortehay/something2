// Live preview for the VFX admin (slice E, SOMET-162).
//
// Delegates its particle maths to core/vfx.js's particlesAt -- the SAME pure
// function the renderer uses. A preview with its own private animation would
// be a lie that looks like a feature: an author would tune against something
// the game never draws. Geometry is drawn in flat screen space rather than
// through the iso projection, because the preview is a legibility aid, not a
// simulation of standing in a world -- and that difference is visible enough
// (a straight-on box, not a diamond) that nobody could mistake one for the
// other.
import { particlesAt, ease } from './src/js/core/vfx.js';

export function drawVfxPreview(ctx, w, h, def, elapsedMs) {
  ctx.clearRect(0, 0, w, h);
  const duration = Number(def.duration_ms) || 180;
  // Loops, so the author sees the effect repeatedly without re-triggering it.
  const raw = (elapsedMs % (duration * 1.6)) / duration;
  if (raw > 1) return;                       // the gap between loops
  const t = ease(raw, def.ease);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.34;

  ctx.save();
  ctx.globalAlpha = def.fade === false ? 1 : 1 - raw;
  ctx.strokeStyle = def.color || '#dddddd';
  ctx.lineWidth = Number(def.width) || 2;

  if (def.shape === 'arc') {
    ctx.beginPath();
    ctx.arc(cx, cy, R, -0.9, -0.9 + 1.6 * t);
    ctx.stroke();
  } else if (def.shape === 'line') {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * t, cy);
    ctx.stroke();
  } else if (def.shape === 'ring') {
    const r = R * t;
    if (r > 0) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
  } else if (def.shape === 'burst') {
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + R * t * Math.cos(a), cy + R * t * Math.sin(a));
      ctx.stroke();
    }
  } else if (def.shape === 'bolt') {
    const head = R * t;
    const tail = R * Math.max(0, t - 0.25);
    ctx.beginPath();
    ctx.moveTo(cx - R / 2 + tail, cy);
    ctx.lineTo(cx - R / 2 + head, cy);
    ctx.stroke();
  }

  // Particles, from the real function. The fake effect handed to particlesAt
  // carries a fixed seed source so the preview is stable frame to frame rather
  // than reshuffling as the author types.
  const count = Math.floor(Number(def.particle_count) || 0);
  if (count > 0) {
    const fx = { def, x: 0, y: 0, nx: 1, ny: 0, startedAt: 0 };
    ctx.fillStyle = def.color || '#ffffff';
    const size = Math.max(1, Number(def.particle_size) || 2);
    for (const p of particlesAt(fx, raw)) {
      ctx.globalAlpha = p.alpha;
      ctx.fillRect(cx + p.dx - size / 2, cy + p.dy - size / 2, size, size);
    }
  }
  ctx.restore();
}
