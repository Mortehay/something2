// Pure helpers for the Effects section of the Sprite tab.
import { etaLabel } from './spriteEta.js';
import { spriteFrameAtTime } from './src/js/core/vfx.js';

export const ONE_SHOT_GAP_MS = 400;
const DEFAULT_DURATION_MS = 800;

export const effectKey = (s) => `${s.subject_kind}|${s.name}`;

export function previewAngles(kind) {
  return kind === 'projectile' || kind === 'beam' ? [0, 60, 150, 270] : [0];
}

// Box-measured per-kind seconds (backend effectEstimate). The box draws one effect at a time and
// only its first job after a restart is cold, so the high end adds that cold start once, not per effect.
export function effectSelectionEta(subjects, selectedKeys, eta) {
  const out = { low: 0, typical: 0, high: 0 };
  let coldExtra = 0;
  for (const s of subjects) {
    if (!selectedKeys.has(effectKey(s))) continue;
    const e = eta && eta[s.kind];
    if (!e) continue;
    out.low += e.low;
    out.typical += e.typical;
    coldExtra = Math.max(coldExtra, e.high - e.typical);
  }
  out.high = out.typical + coldExtra;
  return out;
}

export function effectEtaLabel(est) {
  return etaLabel(est);
}

export function effectStatusLabel(subject) {
  const job = subject.job;
  const fallback = subject.sprite ? 'approved' : 'none';
  if (!job) return fallback;
  if (job.status === 'approved') return 'approved';
  if (job.status === 'queued') return 'queued';
  if (job.status === 'running') return 'drawing';
  if (job.status === 'failed') return `failed: ${job.error || 'unknown error'}`;
  if (job.status === 'done') {
    return subject.sprite && subject.sprite.image === job.image_key ? 'approved' : 'ready to approve';
  }
  return fallback;
}

// What approveColumns will write when the kind's defaults apply: bursts play once with no
// fps, everything else loops; auras have no loop column and always loop.
const KIND_PLAY = { aura: { loop: true, fps: 10 }, burst: { loop: false, fps: null }, projectile: { loop: true, fps: 12 }, beam: { loop: true, fps: 12 } };

// One source of truth for how a strip previews: a candidate and its approved sprite play alike.
export function previewSprite(subject) {
  const { job, sprite } = subject;
  const d = KIND_PLAY[subject.kind] || KIND_PLAY.projectile;
  const play = (own) => ({
    loop: subject.kind === 'aura' ? true : (own && own.loop != null ? own.loop : d.loop),
    fps: own && own.fps != null ? own.fps : d.fps,
  });
  if (job && job.status === 'done' && job.image_key) {
    return { image_key: job.image_key, frames: job.frames ?? sprite?.frames ?? 1, ...play(null) };
  }
  if (sprite && sprite.image) return { image_key: sprite.image, frames: sprite.frames, ...play(sprite) };
  return null;
}

export function previewDurationMs(sprite) {
  const frames = Math.max(1, Number(sprite && sprite.frames) || 1);
  const fps = Number(sprite && sprite.fps);
  return fps > 0 ? (frames * 1000) / fps : DEFAULT_DURATION_MS;
}

// Frame index to draw at `nowMs`. Loops wrap; a one-shot holds its last frame, then restarts
// after the duration plus a short gap.
export function previewFrameAt(sprite, nowMs, t0Ms) {
  const def = { sprite_frames: sprite.frames, sprite_loop: sprite.loop === true, sprite_fps: sprite.fps };
  const duration = previewDurationMs(sprite);
  const raw = nowMs - t0Ms;
  const elapsed = raw > 0 && sprite.loop !== true ? raw % (duration + ONE_SHOT_GAP_MS) : raw;
  return spriteFrameAtTime(def, elapsed, duration);
}
