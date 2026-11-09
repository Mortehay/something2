import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';
import { worldToScreen } from '../../core/iso.js';
import { addEffects } from '../../core/vfx.js';
import { Game } from '../../core/Game.js';

// Effect sprites in game (Task 6): strip layout for bolt-shaped effects, and the skill
// visual (arcane_beam / lightning) that must not draw a second, vector beam on top of an
// effect that already plays its sprite strip.
function fakeCtx() {
  const calls = [];
  const ctx = {
    globalAlpha: 1, strokeStyle: null, fillStyle: null, lineWidth: 1, globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: false, lineCap: '', lineJoin: '', shadowColor: '', shadowBlur: 0,
    save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {},
    beginPath: () => {}, moveTo: () => {}, closePath: () => {}, fillRect: () => {},
    lineTo: () => calls.push('lineTo'),
    stroke: () => calls.push('stroke'), fill: () => calls.push('fill'),
    ellipse: () => calls.push('ellipse'), arc: () => calls.push('arc'),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    drawImage: (...a) => calls.push(['drawImage', ...a.slice(1)]),
  };
  return { ctx, calls };
}

const img = { naturalWidth: 256, naturalHeight: 16 };
function renderer(ctx, { loaded = true, defs = {} } = {}) {
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = ctx;
  rs.vfxDefs = defs;
  rs.imageManager = { get: (k) => (loaded && k === 'vfx:vfx/s.png' ? img : null) };
  return rs;
}

const def = (over = {}) => ({
  name: 'chain_lightning', shape: 'bolt', color: '#7df', width: 2, duration_ms: 400, ease: 'linear', fade: false,
  sprite_image: 'vfx/s.png', sprite_frames: 4, sprite_size: 0, sprite_additive: true, sprite_stretch: false, ...over,
});
const fx = (d, over = {}) => ({ def: d, x: 100, y: 100, nx: 1, ny: 0, reach: 200, startedAt: 0, ...over });

function atTime(now, fn) {
  const real = globalThis.performance.now;
  globalThis.performance.now = () => now;
  try { fn(); } finally { globalThis.performance.now = real; }
}
const drawsOf = (calls) => calls.filter((c) => Array.isArray(c));

describe('effect strips in game', () => {
  it('chain_lightning (shape bolt, sprite_stretch) stretches from the origin', () => {
    const { ctx, calls } = fakeCtx();
    atTime(200, () => renderer(ctx).drawVfx([fx(def({ sprite_stretch: true }))]));
    const d = drawsOf(calls);
    expect(d).toHaveLength(1);
    const [, , , , , dx] = d[0];
    expect(dx).toBe(0);
  });

  it('a travelling bolt is anchored at its head', () => {
    const { ctx, calls } = fakeCtx();
    atTime(200, () => renderer(ctx).drawVfx([fx(def())]));
    const d = drawsOf(calls);
    expect(d).toHaveLength(1);
    const [, , , , , dx, , dw] = d[0];
    expect(dw).toBeGreaterThan(0);
    expect(dx).toBe(-dw);
  });

  it('a looping strip with sprite_fps plays at its own rate, not the duration', () => {
    const { ctx, calls } = fakeCtx();
    // 10 fps, 450 ms in -> frame 4 -> wraps to 0 on a 4-frame strip.
    atTime(450, () => renderer(ctx).drawVfx([fx(def({ sprite_fps: 10, sprite_loop: true, duration_ms: 1000 }))]));
    expect(drawsOf(calls)[0][1]).toBe(0);
  });

  // Caster A=(0,0), target B=(200,100). Screen: A -> (0,0), B -> worldToScreen(200,100).
  const beam = (over = {}) => ({
    kind: 'arcane_beam', vfxName: 'chain_lightning', startedAt: 0, durationMs: 300,
    fromX: 0, fromY: 0, toX: 200, toY: 100, color: '#a855f7', ...over,
  });
  function recording(ctx, calls) {
    ctx.translate = (x, y) => calls.push(['translate', x, y]);
    ctx.rotate = (a) => calls.push(['rotate', a]);
    return ctx;
  }

  it('a caster->target beam with a loaded row draws ONE strip, tail at the caster, stretched and rotated to the target, and no code line', () => {
    const defs = { chain_lightning: def({ shape: 'line' }) };
    const { ctx, calls } = fakeCtx();
    recording(ctx, calls);
    atTime(100, () => renderer(ctx, { defs }).drawSkillVisuals([beam()]));
    const d = drawsOf(calls).filter((c) => c[0] === 'drawImage');
    expect(d).toHaveLength(1);
    const b = worldToScreen(200, 100);
    const tr = calls.find((c) => Array.isArray(c) && c[0] === 'translate');
    expect(tr[1]).toBeCloseTo(0, 6);
    expect(tr[2]).toBeCloseTo(0, 6);
    const rot = calls.find((c) => Array.isArray(c) && c[0] === 'rotate');
    expect(rot[1]).toBeCloseTo(Math.atan2(b.y, b.x), 6);
    const [, sx, , , , dx, , dw] = d[0];
    expect(dx).toBe(0);
    expect(dw).toBeCloseTo(Math.hypot(b.x, b.y), 6);
    // Frame over the visual's own 300 ms lifetime: 100/300 -> frame 1 of 4.
    expect(sx).toBe(64);
    expect(calls.filter((c) => c === 'lineTo' || c === 'stroke')).toHaveLength(0);
  });

  it('the same cast spawns no target-anchored strip: its effect entry is flagged and drawVfx skips the sprite', () => {
    const row = def({ shape: 'line' });
    const list = addEffects([], [{ v: 'chain_lightning', x: 200, y: 100, nx: 1, ny: 0, reach: 120, beamByVisual: true }], 0, { chain_lightning: row });
    const { ctx, calls } = fakeCtx();
    atTime(100, () => renderer(ctx, { defs: { chain_lightning: row } }).drawVfx(list));
    expect(drawsOf(calls)).toHaveLength(0);
    expect(calls.filter((c) => c === 'stroke' || c === 'lineTo')).toHaveLength(0);
  });

  it('a flagged entry draws nothing even with no loaded sheet, and an unflagged line entry still strokes', () => {
    const row = def({ shape: 'line' });
    const flagged = fx(row, { beamByVisual: true });
    const a = fakeCtx();
    atTime(100, () => renderer(a.ctx, { loaded: false, defs: { chain_lightning: row } }).drawVfx([flagged]));
    expect(a.calls).toHaveLength(0);
    const b = fakeCtx();
    atTime(100, () => renderer(b.ctx, { loaded: false, defs: { chain_lightning: row } }).drawVfx([fx(row)]));
    expect(b.calls.filter((c) => c === 'stroke').length).toBeGreaterThan(0);
  });

  it("Game._spawnSkillFx flags the effect entry of a beam cast whose row has an along strip, and only then", () => {
    const spawn = (vfxDefs, skill) => {
      const g = { vfx: [], blasts: [], skillVisuals: [], vfxDefs };
      Game.prototype._spawnSkillFx.call(g, skill, 0, 0, 200, 100, Math.atan2(100, 200), 0, 0);
      return g;
    };
    const beamSkill = { id: 'mag_arcane_beam', type: 'magic', class: 'Mage', element: 'arcane' };
    const withStrip = spawn({ arcane_beam: def({ name: 'arcane_beam', shape: 'line' }) }, beamSkill);
    expect(withStrip.skillVisuals[0].kind).toBe('arcane_beam');
    expect(withStrip.vfx).toHaveLength(1);
    expect(withStrip.vfx[0].beamByVisual).toBe(true);
    const burstRow = spawn({ arcane_beam: def({ name: 'arcane_beam', shape: 'burst' }) }, beamSkill);
    expect(burstRow.vfx[0].beamByVisual).toBe(false);
    const skyStrike = spawn({ lightning_strike: def({ name: 'lightning_strike', shape: 'line' }) },
      { id: 'dru_lightning_strike', type: 'magic', class: 'Druid', element: 'lightning', vfx: 'lightning_strike' });
    expect(skyStrike.skillVisuals[0].kind).toBe('lightning');
    expect(skyStrike.skillVisuals[0].skyStrike).toBe(true);
    expect(skyStrike.vfx[0].beamByVisual).toBe(false);
  });

  it('sky-strike lightning keeps the code-drawn bolt even with a loaded along row', () => {
    const defs = { chain_lightning: def({ shape: 'line' }) };
    const v = beam({ kind: 'lightning', skyStrike: true, branches: [{ x1: 220, y1: -140, x2: 200, y2: 100 }] });
    const { ctx, calls } = fakeCtx();
    atTime(100, () => renderer(ctx, { defs }).drawSkillVisuals([v]));
    expect(drawsOf(calls)).toHaveLength(0);
    expect(calls.filter((c) => c === 'stroke').length).toBeGreaterThan(0);
  });

  it('a caster->target lightning arc is replaced the same way as a beam', () => {
    const defs = { chain_lightning: def({ shape: 'bolt', sprite_stretch: true }) };
    const v = beam({ kind: 'lightning', skyStrike: false, branches: [{ x1: 0, y1: 0, x2: 200, y2: 100 }] });
    const { ctx, calls } = fakeCtx();
    atTime(100, () => renderer(ctx, { defs }).drawSkillVisuals([v]));
    expect(drawsOf(calls)).toHaveLength(1);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(0);
  });

  it('beam row not loaded (or a burst row) -> the code line is drawn', () => {
    const loading = fakeCtx();
    atTime(100, () => renderer(loading.ctx, { loaded: false, defs: { chain_lightning: def({ shape: 'line' }) } }).drawSkillVisuals([beam()]));
    expect(loading.calls.filter((c) => c === 'lineTo')).toHaveLength(2);
    expect(loading.calls.filter((c) => c === 'stroke')).toHaveLength(2);
    expect(drawsOf(loading.calls)).toHaveLength(0);

    const burst = fakeCtx();
    const v = beam({ kind: 'lightning', branches: [{ x1: 0, y1: 0, x2: 200, y2: 100 }] });
    atTime(100, () => renderer(burst.ctx, { defs: { chain_lightning: def({ shape: 'burst' }) } }).drawSkillVisuals([v]));
    expect(drawsOf(burst.calls)).toHaveLength(0);
    expect(burst.calls.filter((c) => c === 'stroke').length).toBeGreaterThan(0);
  });

  it("a 'projectile' skill visual is never suppressed", () => {
    const defs = { chain_lightning: def({ shape: 'line' }) };
    const v = {
      kind: 'projectile', vfxName: 'chain_lightning', startedAt: 0, durationMs: 300,
      x: 50, y: 0, fromX: 0, fromY: 0, toX: 200, toY: 0, radius: 6, color: '#f97316',
    };
    const { ctx, calls } = fakeCtx();
    atTime(100, () => renderer(ctx, { defs }).drawSkillVisuals([v]));
    expect(calls.filter((c) => c === 'fill' || c === 'stroke' || c === 'arc').length).toBeGreaterThan(0);
  });
});
