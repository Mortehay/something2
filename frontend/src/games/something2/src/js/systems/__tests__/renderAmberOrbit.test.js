// Amber Stance orbit: motes and wisps circle the crystal's base on a flat
// isometric ellipse. The far half is drawn BEFORE the crystal (covered by it),
// the near half AFTER (passing in front). Recording fake ctx.
import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';
import { worldToScreen } from '../../core/iso.js';
import { appearanceDrawScale } from '../../core/characterAppearance.js';

const MOTE = '#ffd36b';
const WISP = '#efe2c8';
const BLOCK = 'rgba(222,140,30,0.38)';

function fakeCtx() {
  const calls = [];
  const stack = [];
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: false,
    strokeStyle: '#000', fillStyle: '#000', lineWidth: 1, font: '', textAlign: 'start',
    save() { stack.push([this.globalAlpha, this.fillStyle, this.strokeStyle]); },
    restore() { const s = stack.pop(); if (s) [this.globalAlpha, this.fillStyle, this.strokeStyle] = s; },
    translate() {}, rotate() {}, scale() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
    arc(x, y, r) { calls.push({ op: 'arc', x, y, r, style: this.fillStyle, alpha: this.globalAlpha }); },
    ellipse(x, y, rx, ry) { calls.push({ op: 'ellipse', x, y, rx, ry, style: this.fillStyle, alpha: this.globalAlpha }); },
    fill() { calls.push({ op: 'fill', style: this.fillStyle, alpha: this.globalAlpha }); },
    stroke() {}, strokeText() {},
    fillText(text, x, y) { calls.push({ op: 'text', text, x, y }); },
    drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) { calls.push({ op: 'drawImage', img, dx, dy, dw, dh, alpha: this.globalAlpha }); },
  };
  return { ctx, calls };
}

const SHEET = { name: 'amber2', naturalWidth: 1024, naturalHeight: 128 };
const VISUALS = {
  amber_stance_2: { key: 'amber_stance_2', variant: 2, sprite_image: 'status/a2.png', sprite_frames: 8, sprite_fps: 10 },
};
function renderer(ctx, nowMs) {
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = ctx;
  rs.nowMs = nowMs;
  rs._labelCache = null;
  rs.imageManager = { get: (k) => (k === 'vfx:status/a2.png' ? SHEET : null) };
  return rs;
}
const player = (over = {}) => ({ x: 200, y: 300, width: 64, height: 64, imageKey: 'player', ...over });
const feet = (p) => worldToScreen(p.x + p.width / 2, p.y + p.height / 2);
const motes = (calls) => calls.filter((c) => c.op === 'arc' && c.style === MOTE);
const wisps = (calls) => calls.filter((c) => c.op === 'ellipse' && c.style === WISP);

function checkOrder(calls, crystalIdx, s) {
  const m = motes(calls);
  expect(m.length).toBeGreaterThanOrEqual(4);
  expect(m.length).toBeLessThanOrEqual(6);
  const back = m.filter((c) => c.y < s.y - 1e-9);
  const front = m.filter((c) => c.y > s.y + 1e-9);
  expect(back.length).toBeGreaterThan(0);
  expect(front.length).toBeGreaterThan(0);
  for (const c of back) expect(calls.indexOf(c)).toBeLessThan(crystalIdx);
  for (const c of front) expect(calls.indexOf(c)).toBeGreaterThan(crystalIdx);
  // the near half reads as passing in front: brighter and larger
  const maxBack = Math.max(...back.map((c) => c.alpha));
  const minFront = Math.min(...front.map((c) => c.alpha));
  expect(minFront).toBeGreaterThan(maxBack);
  expect(Math.min(...front.map((c) => c.r))).toBeGreaterThan(Math.max(...back.map((c) => c.r)));
  // on a flat ring around the feet, about the crystal's half-width out
  const dh = 64 * appearanceDrawScale('player');
  for (const c of m) {
    expect(Math.abs(c.x - s.x)).toBeLessThanOrEqual(dh * 0.8);
    expect(Math.abs(c.y - s.y)).toBeLessThanOrEqual(dh * 0.4);
  }
  const ws = wisps(calls);
  expect(ws.length).toBeGreaterThanOrEqual(2);
  expect(ws.length).toBeLessThanOrEqual(4);
}

describe('amber orbit', () => {
  it('code fallback: back motes before the block, front motes after', () => {
    const p = player({ amber: { a: 3, ms: 9000, v: null } });
    const { ctx, calls } = fakeCtx();
    renderer(ctx, 700)._drawAmber(p, null, 'me', null, 700, null);
    const block = calls.findIndex((c) => c.op === 'fill' && c.style === BLOCK);
    expect(block).toBeGreaterThan(-1);
    checkOrder(calls, block, feet(p));
  });

  it('approved sprite: back motes before the drawImage, front motes after', () => {
    const p = player({ amber: { a: 3, ms: 9000, v: 2 } });
    const { ctx, calls } = fakeCtx();
    renderer(ctx, 700)._drawAmber(p, null, 'me', VISUALS, 700, null);
    const img = calls.findIndex((c) => c.op === 'drawImage');
    expect(img).toBeGreaterThan(-1);
    checkOrder(calls, img, feet(p));
  });

  it('the orbit scales with the figure (dh)', () => {
    const small = fakeCtx();
    renderer(small.ctx, 700)._drawAmber(player({ amber: { a: 3, ms: 9000, v: null } }), null, 'me', null, 700, null);
    const big = fakeCtx();
    const bp = player({ width: 128, height: 128, amber: { a: 3, ms: 9000, v: null } });
    renderer(big.ctx, 700)._drawAmber(bp, null, 'me', null, 700, null);
    const spread = (calls, s) => Math.max(...motes(calls).map((c) => Math.abs(c.x - s.x)));
    expect(spread(big.calls, feet(bp)) / spread(small.calls, feet(player()))).toBeCloseTo(2, 1);
  });

  it('moves over time', () => {
    const p = player({ amber: { a: 3, ms: 9000, v: null } });
    const a = fakeCtx(), b = fakeCtx();
    renderer(a.ctx, 700)._drawAmber(p, null, 'me', null, 700, null);
    renderer(b.ctx, 1000)._drawAmber(p, null, 'me', null, 700, null);
    expect(motes(b.calls)[0].x).not.toBeCloseTo(motes(a.calls)[0].x, 3);
  });

  it('fades with the amber: every mote and wisp alpha x the fade alpha', () => {
    const sealed = fakeCtx();
    renderer(sealed.ctx, 1200)._drawAmber(player({ amber: { a: 3, ms: 9000, v: null } }), null, 'me', null, 1200, null);
    const mid = fakeCtx();
    const fades = new Map([['me', { at: 1000, v: null, a: 3 }]]);
    renderer(mid.ctx, 1200)._drawAmber(player(), null, 'me', null, 0, fades);
    const sm = motes(sealed.calls), mm = motes(mid.calls);
    expect(sm.length).toBeGreaterThanOrEqual(4);
    expect(mm).toHaveLength(sm.length);
    for (let i = 0; i < sm.length; i++) {
      expect(mm[i].x).toBeCloseTo(sm[i].x, 9); // same phase: the fade keeps the arrival
      expect(mm[i].alpha).toBeCloseTo(sm[i].alpha * 0.5, 9);
    }
    const sw = wisps(sealed.calls), mw = wisps(mid.calls);
    expect(sw.length).toBeGreaterThan(0);
    expect(mw).toHaveLength(sw.length);
    for (let i = 0; i < sw.length; i++) expect(mw[i].alpha).toBeCloseTo(sw[i].alpha * 0.5, 9);
    expect(mid.ctx.globalAlpha).toBe(1);
  });

  it('remote sealed players orbit too, out of step with their neighbours', () => {
    const remotes = new Map([
      ['p2', player({ id: 'p2', amber: { a: 4, ms: 9000, v: null } })],
      ['p3', player({ id: 'p3', amber: { a: 5, ms: 9000, v: null } })],
    ]);
    const { ctx, calls } = fakeCtx();
    renderer(ctx, 700)._drawAmber(null, remotes, 'me', null, 700, null);
    const m = motes(calls);
    expect(m.length).toBeGreaterThanOrEqual(8);
    const half = m.length / 2;
    // same position, different arrival -> the rings are not in lockstep
    expect(m.slice(0, half).map((c) => c.x.toFixed(3))).not.toEqual(m.slice(half).map((c) => c.x.toFixed(3)));
  });

  it('nothing for an unsealed player, nor one whose fade has run out', () => {
    const none = fakeCtx();
    renderer(none.ctx, 700)._drawAmber(player(), new Map([['p2', player({ id: 'p2' })]]), 'me', null, 0, new Map());
    expect(none.calls).toEqual([]);
    const done = fakeCtx();
    renderer(done.ctx, 1400)._drawAmber(player(), null, 'me', null, 0, new Map([['me', { at: 1000, v: null, a: 3 }]]));
    expect(done.calls).toEqual([]);
  });
});
