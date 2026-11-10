// Pure helpers for the Effects section of the Sprite tab.
import { etaLabel, durationLabel } from './spriteEta.js';
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
// A done candidate plays by job.play (the backend's approveColumns over the job's box atlas, i.e.
// exactly what approving it writes); without it, by the kind defaults.
export function previewSprite(subject) {
  const { job, sprite } = subject;
  const d = KIND_PLAY[subject.kind] || KIND_PLAY.projectile;
  const play = (own) => ({
    loop: subject.kind === 'aura' ? true : (own && own.loop != null ? own.loop : d.loop),
    fps: own && own.fps != null ? own.fps : d.fps,
  });
  if (job && job.status === 'done' && job.image_key) {
    const own = job.play || null;
    return { image_key: job.image_key, frames: own?.frames ?? job.frames ?? sprite?.frames ?? 1, ...play(own) };
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

// GET /effects -> Sprite-table rows, one per effect. The raw item rides along as
// effect_subject for the preview and the status label.
export function effectRows(effectsResponse) {
  return (effectsResponse?.subjects || []).map((s) => {
    const job = s.job || null;
    return {
      id: `fx:${s.subject_kind}|${s.name}`,
      effect: true,
      name: s.name, group: s.group, kind: s.kind, subject_kind: s.subject_kind, blend: s.blend, retired: s.retired === true, color: s.color ?? null,
      // A buff aura draws on the ground or around the body; null for every other kind.
      placement: s.placement ?? null,
      backend: 'gpu-box',
      missing: s.missing === true,
      job_state: job?.status ?? null,
      job_id: job?.id ?? null,
      job_updated_at: job?.updated_at ?? null,
      needs_prompt: job?.needs_prompt === true,
      frames: job?.frames ?? s.default_frames,
      loop: job?.loop ?? s.default_loop,
      default_frames: s.default_frames,
      default_loop: s.default_loop,
      max_frames: s.max_frames ?? null,
      sprite: s.sprite || null,
      sprite_prompt: s.prompt ?? null,
      sprite_prompt_source: s.prompt_source ?? null,
      sprite_prompt_origin: s.prompt_origin ?? null,
      prompt: s.default_prompt ?? null,
      prompt_kind: s.prompt_kind ?? null,
      prompt_key: s.prompt_key ?? null,
      last_error: job?.error ?? null,
      effect_subject: s,
    };
  });
}

// The Status cell of an effect row.
export function effectRowStatusLabel(row) {
  if (row.job_state === 'queued' && row.needs_prompt) return 'prompt pending';
  return effectStatusLabel(row.effect_subject || row);
}

// The Sprite tab's header counts only creature sheets, so effect work needs its own
// line there. Approved = a done job whose sheet is the effect's live sprite (same
// rule as effectStatusLabel). Time left = warm seconds for every queued or drawing job.
export function effectActivity(subjects, eta) {
  const a = { queued: 0, promptPending: 0, running: 0, ready: 0, failed: 0, approved: 0, current: null, leftSeconds: 0, active: false };
  for (const s of subjects || []) {
    const job = s.job;
    if (!job) continue;
    const label = effectStatusLabel(s);
    if (job.status === 'queued') {
      a.queued += 1;
      if (job.needs_prompt) a.promptPending += 1;
    } else if (job.status === 'running') {
      a.running += 1;
      a.current = a.current || s.name;
    } else if (job.status === 'failed') a.failed += 1;
    else if (label === 'approved') a.approved += 1;
    else if (label === 'ready to approve') a.ready += 1;
    if (job.status === 'queued' || job.status === 'running') a.leftSeconds += (eta && eta[s.kind] && eta[s.kind].typical) || 0;
  }
  a.active = a.queued + a.running > 0;
  return a;
}

export function creatureWaitLine(run) {
  return run?.pausedForEffects > 0 ? `Creature sheets wait while effects draw (${run.pausedForEffects} left)` : null;
}

export function effectActivityLine(a) {
  if (!a || a.queued + a.running + a.ready + a.failed + a.approved === 0) return null;
  const parts = [];
  if (a.current) parts.push(`drawing ${a.current}`);
  parts.push(`${a.queued} queued${a.promptPending ? ` (${a.promptPending} waiting for a prompt)` : ''}`);
  parts.push(`${a.ready} ready for review`, `${a.failed} failed`, `${a.approved} approved`);
  if (a.active && a.leftSeconds > 0) parts.push(`${durationLabel(a.leftSeconds)} left`);
  return `Effects: ${parts.join(' · ')}`;
}
