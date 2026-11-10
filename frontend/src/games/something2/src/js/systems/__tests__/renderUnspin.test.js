// Task 5b: every strip from box kind `aura` (aura_effects, buff_visuals, status_visuals)
// is turned back by unspinAngle(frame, frames) about the drawn cell's centre; vfx rows
// are not. A fake ctx records the transform ops with a real save/restore depth.
import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';
import { worldToScreen } from '../../core/iso.js';
import { blastScreenRadiusX } from '../../core/blasts.js';
import { appearanceDrawScale } from '../../core/characterAppearance.js';

function fakeCtx() {
  const calls = [];
  let depth = 0;
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: false,
    strokeStyle: '#000', fillStyle: '#000', lineWidth: 1, font: '', textAlign: 'start',
    save() { depth++; calls.push({ op: 'save', depth }); },
    restore() { calls.push({ op: 'restore', depth }); depth--; },
    translate: (x, y) => calls.push({ op: 'translate', a: [x, y], depth }),
    scale: (x, y) => calls.push({ op: 'scale', a: [x, y], depth }),
    rotate: (r) => calls.push({ op: 'rotate', a: [r], depth }),
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, arc() {},
    ellipse() {}, fill() {}, stroke() {}, fillRect() {}, strokeText() {}, fillText() {},
    drawImage: (img, sx, sy, sw, sh, dx, dy, dw, dh) => calls.push({ op: 'drawImage', a: [sx, sy, sw, sh, dx, dy, dw, dh], depth }),
  };
  return { ctx, calls, depth: () => depth };
}

// 8 frames of 128x128.
const SHEET8 = { naturalWidth: 1024, naturalHeight: 128 };
const IMAGES = {
  'vfx:buff/g.png': SHEET8,
  'vfx:buff/b.png': SHEET8,
  'vfx:status/a2.png': SHEET8,
  'vfx:vfx/aura.png': SHEET8,
  'vfx:vfx/burst.png': SHEET8,
};

function renderer(ctx, nowMs) {
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = ctx;
  rs.nowMs = nowMs;
  rs._labelCache = null;
  rs.skillsById = new Map();
  rs.buffVisualSettings = { main_opacity: 0.85, other_opacity: 0.45 };
  rs.imageManager = { get: (k) => IMAGES[k] || null };
  return rs;
}

const visual = (over) => ({
  placement: 'body', radius: null, scale: null, priority: null, color: '#ff8800',
  sprite_frames: 8, sprite_additive: false, sprite_fps: 10, ...over,
});
const player = (over = {}) => ({ x: 200, y: 300, width: 64, height: 64, hp: 100, maxHp: 100, imageKey: 'player', ...over });

// The rotate of the un-spin, the ops around it, and the drawImage it applies to.
function unspun(calls) {
  const i = calls.findIndex((c) => c.op === 'rotate');
  expect(i).toBeGreaterThan(0);
  const d = calls.slice(i).find((c) => c.op === 'drawImage');
  const tr = calls.slice(0, i).reverse().find((c) => c.op === 'translate');
  const sc = calls.slice(0, i).reverse().find((c) => c.op === 'scale' && c.depth === calls[i].depth);
  const rs = calls.slice(i).find((c) => c.op === 'restore' && c.depth === calls[i].depth);
  return { rot: calls[i], draw: d, translate: tr, scale: sc, restore: rs };
}

// 200 ms at 10 fps = frame 2 of 8 -> pi/2.
const NOW = 200;

describe('un-spun aura strips in the world', () => {
  it('body buff, frame 2 of 8: rotate(pi/2) inside save/restore, around the cell centre, upright', () => {
    const { ctx, calls, depth } = fakeCtx();
    const rs = renderer(ctx, NOW);
    rs.buffVisuals = { buff_b: visual({ sprite_image: 'buff/b.png' }) };
    const p = player({ buffs: [{ id: 'buff_b' }] });
    rs._drawBuffBodies(p, null);
    const { rot, draw, translate, scale, restore } = unspun(calls);
    expect(rot.a[0]).toBeCloseTo(Math.PI / 2, 9);
    expect(rot.depth).toBeGreaterThan(0);
    expect(restore).toBeTruthy();
    expect(draw.a.slice(0, 4)).toEqual([256, 0, 128, 128]);
    const dh = 64 * appearanceDrawScale('player');
    const feet = worldToScreen(p.x + 32, p.y + 32);
    expect(translate.a[0]).toBeCloseTo(feet.x, 9);
    expect(translate.a[1]).toBeCloseTo(feet.y - dh / 2, 9);
    expect(scale).toBeUndefined();
    // centred on the translated origin
    expect(draw.a[4] + draw.a[6] / 2).toBeCloseTo(0, 9);
    expect(draw.a[5] + draw.a[7] / 2).toBeCloseTo(0, 9);
    expect(draw.a[7]).toBeCloseTo(1.3 * dh, 9);
    expect(depth()).toBe(0);
  });

  it('ground buff, frame 2 of 8: squash THEN rotate, so the ring ellipse stays flat', () => {
    const { ctx, calls, depth } = fakeCtx();
    const rs = renderer(ctx, NOW);
    rs.buffVisuals = { g: visual({ placement: 'ground', sprite_image: 'buff/g.png' }) };
    const p = player({ buffs: [{ id: 'g', auraRadius: 150 }] });
    rs._drawBuffGround(p, null);
    const { rot, draw, translate, scale } = unspun(calls);
    expect(rot.a[0]).toBeCloseTo(Math.PI / 2, 9);
    expect(scale.a).toEqual([1, 0.5]);
    expect(calls.indexOf(scale)).toBeLessThan(calls.indexOf(rot));
    const feet = worldToScreen(p.x + 32, p.y + 32);
    expect(translate.a[0]).toBeCloseTo(feet.x, 9);
    expect(translate.a[1]).toBeCloseTo(feet.y, 9);
    const w = 2 * blastScreenRadiusX(150);
    // unsquashed square cell in the rotated frame: w x w, centred
    expect(draw.a[6]).toBeCloseTo(w, 9);
    expect(draw.a[7]).toBeCloseTo(w, 9);
    expect(draw.a[4]).toBeCloseTo(-w / 2, 9);
    expect(draw.a[5]).toBeCloseTo(-w / 2, 9);
    expect(depth()).toBe(0);
  });

  it('amber sheet, frame 2 of 8: rotate(pi/2) about the block centre', () => {
    const { ctx, calls, depth } = fakeCtx();
    const rs = renderer(ctx, NOW);
    const visuals = { amber_stance_2: { key: 'amber_stance_2', variant: 2, sprite_image: 'status/a2.png', sprite_frames: 8, sprite_fps: 10 } };
    const p = player({ amber: { a: 1, ms: 9000, v: 2 } });
    rs._drawAmber(p, null, 'me', visuals, NOW, null);
    const { rot, draw, translate, restore } = unspun(calls);
    expect(rot.a[0]).toBeCloseTo(Math.PI / 2, 9);
    expect(restore).toBeTruthy();
    const dh = 64 * appearanceDrawScale('player');
    const feet = worldToScreen(p.x + 32, p.y + 32);
    expect(translate.a[0]).toBeCloseTo(feet.x, 9);
    expect(translate.a[1]).toBeCloseTo(feet.y - dh / 2, 9);
    expect(draw.a[7]).toBeCloseTo(1.3 * dh, 9);
    expect(draw.a[5] + draw.a[7] / 2).toBeCloseTo(0, 9);
    expect(depth()).toBe(0);
  });

  it('creature aura sprite, frame 2 of 8: squash then rotate(pi/2) on the feet', () => {
    const { ctx, calls, depth } = fakeCtx();
    const rs = renderer(ctx, NOW);
    rs.auraDefs = { pack: { name: 'pack', radius: 260, shape: 'ring', color: '#d4a017', sprite_image: 'vfx/aura.png', sprite_frames: 8, sprite_fps: 10 } };
    rs._drawSpriteAuraGround([{ id: 'c1', x: 0, y: 0, width: 48, height: 48, auras: ['pack'] }]);
    const { rot, draw, translate, scale } = unspun(calls);
    expect(rot.a[0]).toBeCloseTo(Math.PI / 2, 9);
    expect(scale.a).toEqual([1, 0.5]);
    expect(calls.indexOf(scale)).toBeLessThan(calls.indexOf(rot));
    const feet = worldToScreen(24, 24);
    expect(translate.a[0]).toBeCloseTo(feet.x, 9);
    expect(translate.a[1]).toBeCloseTo(feet.y, 9);
    expect(draw.a.slice(0, 4)).toEqual([256, 0, 128, 128]);
    expect(draw.a[6]).toBeCloseTo(2 * blastScreenRadiusX(260), 9);
    expect(depth()).toBe(0);
  });

  it('frame 0 draws plainly at the old box: no transform at all', () => {
    const { ctx, calls } = fakeCtx();
    const rs = renderer(ctx, 0);
    rs.buffVisuals = { buff_b: visual({ sprite_image: 'buff/b.png' }) };
    rs._drawBuffBodies(player({ buffs: [{ id: 'buff_b' }] }), null);
    expect(calls.some((c) => c.op === 'rotate' || c.op === 'translate')).toBe(false);
    expect(calls.filter((c) => c.op === 'drawImage')).toHaveLength(1);
  });

  it('a vfx burst sheet at a mid frame gets no rotate', () => {
    const { ctx, calls } = fakeCtx();
    const rs = renderer(ctx, NOW);
    const def = { name: 'boom', shape: 'burst', color: '#f70', width: 2, duration_ms: 800, ease: 'linear', fade: false,
      sprite_image: 'vfx/burst.png', sprite_frames: 8, sprite_size: 200, sprite_additive: false };
    expect(rs._drawVfxSprite({ def, x: 100, y: 100, nx: 1, ny: 0, reach: 100, startedAt: 0 }, 200)).toBe(true);
    const draws = calls.filter((c) => c.op === 'drawImage');
    expect(draws).toHaveLength(1);
    expect(draws[0].a[0]).toBe(256); // frame 2: the strip did advance
    expect(calls.some((c) => c.op === 'rotate')).toBe(false);
  });
});
