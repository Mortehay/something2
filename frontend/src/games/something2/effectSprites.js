// Pure helpers for the Effects section of the Sprite tab.
import { etaLabel } from './spriteEta.js';

export const effectKey = (s) => `${s.subject_kind}|${s.name}`;

export function previewAngles(kind) {
  return kind === 'projectile' || kind === 'beam' ? [0, 60, 150, 270] : [0];
}

export function effectSelectionEta(subjects, selectedKeys, eta) {
  const out = { low: 0, typical: 0, high: 0, placeholder: false };
  for (const s of subjects) {
    if (!selectedKeys.has(effectKey(s))) continue;
    const e = eta && eta[s.kind];
    if (!e) continue;
    out.low += e.low;
    out.typical += e.typical;
    out.high += e.high;
    if (e.placeholder) out.placeholder = true;
  }
  return out;
}

export function effectEtaLabel(est) {
  return etaLabel(est) + (est.placeholder ? ' (box estimate, not yet measured)' : '');
}

export function effectStatusLabel(subject) {
  const job = subject.job;
  if (!job) return subject.sprite ? 'approved' : 'none';
  if (job.status === 'queued') return 'queued';
  if (job.status === 'running') return 'drawing';
  if (job.status === 'failed') return `failed: ${job.error || 'unknown error'}`;
  if (job.status === 'done') {
    return subject.sprite && subject.sprite.image === job.image_key ? 'approved' : 'ready to approve';
  }
  return 'none';
}

export function previewSprite(subject) {
  const { job, sprite } = subject;
  if (job && job.status === 'done' && job.image_key) {
    return { image_key: job.image_key, frames: job.frames ?? sprite?.frames ?? 1, loop: sprite?.loop ?? true, fps: sprite?.fps ?? null };
  }
  if (sprite && sprite.image) return { image_key: sprite.image, frames: sprite.frames, loop: sprite.loop, fps: sprite.fps };
  return null;
}
