// Un-spin of GPU-box `aura` strips (Task 5b, owner request 2026-11-11).
//
// The box's `aura` kind bakes a rotation into every strip it draws: frame f of an N-frame
// strip is turned f * 360 / N degrees counter-clockwise on screen about the cell centre, so
// the subject spins. Drawing frame f turned back clockwise -- canvas ctx.rotate(+angle) about
// the cell centre -- keeps it upright while the rest of the animation (smoke, sparks) plays.
//
// Today every row of aura_effects, buff_visuals and status_visuals comes from box kind
// `aura` (backend/src/services/effectKinds.js). vfx rows are other box kinds and are never
// un-spun: the renderer rotates bolts and beams to the aim on purpose.
//
// ONE RULE, ONE PLACE: a future box `motion` option may draw some strips upright at the
// source. needsUnspin is the single switch for that; every caller asks it.

export const UNSPIN_KINDS = new Set(['aura', 'buff', 'status']);

// True when a strip of this effect subject kind ('aura' | 'buff' | 'status' | 'vfx') must
// be turned back frame by frame.
export function needsUnspin(kind) {
  return UNSPIN_KINDS.has(kind);
}

const TWO_PI = Math.PI * 2;

// Radians to turn frame `frameIndex` of an N-frame strip back (clockwise, ctx.rotate(+a)).
// Wraps past the strip end; a one-frame strip or non-finite input gives 0.
export function unspinAngle(frameIndex, frames) {
  const f = Math.floor(frameIndex);
  const n = Math.floor(frames);
  if (!Number.isFinite(f) || !Number.isFinite(n) || n <= 1) return 0;
  return ((((f % n) + n) % n) * TWO_PI) / n;
}

// One cell (sx, sy, sw, sh) of `img`, centred on (cx, cy), `dw` x `dh` in the sprite's own
// frame, squashed vertically by `squash` (1 = upright billboard, 0.5 = flat iso ground) and
// turned by `angle`. The rotation is applied to the cell BEFORE the squash (it sits inside
// the scale in the transform), so a ground ring stays a flat ellipse and only its content
// turns. angle 0 is one plain drawImage at the squashed box -- no state change. Blend and
// smoothing are the caller's. Allocates nothing.
export function drawUnspunCell(ctx, img, sx, sy, sw, sh, cx, cy, dw, dh, squash, angle) {
  if (!angle) {
    const h = dh * squash;
    ctx.drawImage(img, sx, sy, sw, sh, cx - dw / 2, cy - h / 2, dw, h);
    return;
  }
  ctx.save();
  ctx.translate(cx, cy);
  if (squash !== 1) ctx.scale(1, squash);
  ctx.rotate(angle);
  ctx.drawImage(img, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}
