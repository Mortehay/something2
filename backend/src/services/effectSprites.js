// Rules for generated effect sprites (auras, bolts, impacts, beams). Pure, no I/O.
'use strict';

const mk = (subject_kind, group, kind, frames, size, loop, names) => names.map((name) => ({
  subject_kind, name, group, kind, frames, size, loop,
  blend: ['abyssor_void_rend', 'shade_veil', 'ossuary_dread', 'curse_blast'].includes(name) ? 'alpha' : 'additive',
}));

const BATCH_1 = Object.freeze([
  ...mk('aura', 'Auras', 'aura', 8, 128, true, ['abyssor_void_rend', 'cinder_brood', 'fire_sparks', 'glacius_permafrost', 'gorgon_static_field', 'ignis_inferno', 'ossuary_dread', 'pack_leader', 'shade_veil']),
  ...mk('vfx', 'Elemental bolts', 'projectile', 4, 96, true, ['bolt_fire', 'bolt_ice', 'bolt_storm', 'bolt_arcane']),
  ...mk('vfx', 'Impacts', 'burst', 6, 128, false, ['spark_hit', 'fireball_blast', 'blizzard_blast', 'ball_lightning', 'curse_blast']),
  ...mk('vfx', 'Beam / chain', 'beam', 4, 96, true, ['arcane_beam', 'chain_lightning', 'boss_chain_lightning']),
].map((e) => Object.freeze(e)));

function subjectOf(subject_kind, name) {
  return BATCH_1.find((s) => s.subject_kind === subject_kind && s.name === name) || null;
}

const ANCHORS = [
  ['red', '#ff3b30'], ['orange', '#ff7a1a'], ['gold', '#d4a017'], ['yellow', '#ffe66b'],
  ['green', '#4ade80'], ['cyan', '#67e8f9'], ['ice blue', '#8fdcff'], ['blue', '#3b82f6'],
  ['violet', '#a855f7'], ['purple', '#7c3aed'], ['magenta', '#d31769'], ['white', '#ffffff'],
  ['bone', '#cfc8b0'],
];
const rgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function colorWords(hex) {
  const c = rgb(hex);
  let best = ANCHORS[0][0];
  let bestD = Infinity;
  for (const [word, h] of ANCHORS) {
    const a = rgb(h);
    const d = (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 + (a[2] - c[2]) ** 2;
    if (d < bestD) { bestD = d; best = word; }
  }
  return best;
}

// The box owns all prompt wording; callers send only the subject.
const defaultPrompt = (name, hex) => `${String(name).replace(/_/g, ' ')}, ${colorWords(hex)}`;

const PALETTE_COLORS = 16;

function boxRequestFor(job) {
  // effect_sprite_jobs.seed is bigint: pg returns it as a string, the box wants a number.
  // enqueue draws within 1..2^31-1, so Number() is always a safe integer.
  const seed = Number(job.seed);
  if (!Number.isSafeInteger(seed)) throw new Error(`effect job ${job.id}: seed ${job.seed} is not a safe integer`);
  return {
    prompt: job.prompt, kind: job.kind, frames: job.frames, size: job.size,
    loop: job.loop, blend: job.blend, colors: PALETTE_COLORS, seed,
  };
}

// [w, h] from the box's atlas cell: {w, h} (deployed box), [w, h], or "WxH"; null when unreadable.
function cellOf(cell) {
  const pair = (w, h) => (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 ? [w, h] : null);
  if (Array.isArray(cell) && cell.length >= 2) return pair(Number(cell[0]), Number(cell[1]));
  if (cell && typeof cell === 'object') return pair(Number(cell.w), Number(cell.h));
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(cell || ''));
  return m ? pair(Number(m[1]), Number(m[2])) : null;
}

function readAtlas(atlas, { kind, frames, blend } = {}) {
  const a = atlas || {};
  const n = Number(a.frames);
  const jn = Number(frames);
  const okN = (v) => Number.isInteger(v) && v >= 1 && v <= 64;
  const fps = Number(a.fps_hint);
  // absent pivot: the kind's default (tail for projectile/beam); present but
  // unparseable: null (unknown), never a valid tail.
  let tailPivot = kind === 'projectile' || kind === 'beam';
  const p = a.pivot;
  if (p != null) {
    const x = Array.isArray(p) ? Number(p[0]) : Number(p.x);
    const cell = cellOf(a.cell);
    if (!Number.isFinite(x) || x < 0) tailPivot = null;
    else if (x <= 1) tailPivot = x <= 0.1;
    else if (cell && cell[0] > 0) tailPivot = x / cell[0] <= 0.1;
    else tailPivot = null;
    if (a.cell != null && !cell) tailPivot = null;
  }
  const ok = (v) => (v === 'alpha' || v === 'additive' ? v : null);
  return {
    frames: okN(n) ? n : okN(jn) ? jn : null,
    fpsHint: Number.isFinite(fps) && fps > 0 ? fps : null,
    loop: typeof a.loop === 'boolean' ? a.loop : kind !== 'burst',
    blend: ok(a.blend) || ok(blend),
    tailPivot,
  };
}

const clampFps = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(60, Number(v)) : dflt);

function approveColumns({ subject_kind, kind, atlas, imageKey, frames, blend }) {
  const a = readAtlas(atlas, { kind, frames, blend });
  if (a.frames == null) throw new Error('atlas has no frame count');
  if (a.blend == null) throw new Error('atlas has no blend');
  const base = { sprite_image: imageKey, sprite_frames: a.frames, sprite_additive: a.blend === 'additive' };
  if (subject_kind === 'aura') return { ...base, sprite_fps: clampFps(a.fpsHint, 10) };
  return {
    ...base,
    sprite_loop: a.loop,
    sprite_fps: kind === 'burst' ? null : clampFps(a.fpsHint, 12),
    sprite_stretch: kind === 'beam',
  };
}

// Measured on the deployed box (commit 40b29b6, 2026-11-09): one Qwen keyframe per effect, then
// the CPU animation. Warm keyframe ~35 s for aura/beam/projectile and ~46 s for a burst; the
// first job after the box's Qwen child starts takes ~114 s (cold); the CPU step is ~0.2 s.
const EFFECT_ETA = Object.freeze({
  warmKeyframeSeconds: Object.freeze({ aura: 35, beam: 35, projectile: 35, burst: 46 }),
  coldFirstJobSeconds: 114,
  cpuSeconds: 0.2,
});

// typical = this database's median for the kind when it has one, else the box's warm figure.
// high = the cold first job: the box gives no signal for "warm", so the high end always allows it.
function effectEstimate(kind, measuredSeconds) {
  const m = Number(measuredSeconds);
  const warm = (EFFECT_ETA.warmKeyframeSeconds[kind] ?? EFFECT_ETA.warmKeyframeSeconds.aura) + EFFECT_ETA.cpuSeconds;
  const typical = measuredSeconds != null && Number.isFinite(m) && m > 0 ? m : warm;
  return { low: typical, typical, high: Math.max(typical, EFFECT_ETA.coldFirstJobSeconds + EFFECT_ETA.cpuSeconds) };
}

module.exports = { BATCH_1, subjectOf, colorWords, defaultPrompt, PALETTE_COLORS, boxRequestFor, cellOf, readAtlas, approveColumns, EFFECT_ETA, effectEstimate };
