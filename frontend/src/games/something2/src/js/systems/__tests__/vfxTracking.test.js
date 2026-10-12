import { describe, it, expect } from 'vitest';
import { RenderSystem } from '../RenderSystem.js';
import { addEffects } from '../../core/vfx.js';
import { worldToScreen } from '../../core/iso.js';
import { anchorY } from '../../core/attackAnchor.js';

// SOMET-574 AC3: an attack effect follows the actor that made it. The server
// stamps each swing with its actor key (`p:<userId>` / `c:<creatureId>`) and
// the position at swing time; at draw time the effect is re-anchored to that
// actor's CURRENT centre, so a swing made while walking does not stay frozen
// where the swing started. Impacts carry `t` (who was hit), never `a`, and
// stay exactly where they landed.
function renderer() {
  const rs = Object.create(RenderSystem.prototype);
  const pts = [];
  rs.ctx = {
    globalAlpha: 1, strokeStyle: null, fillStyle: null, lineWidth: 1,
    save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {}, closePath() {},
    ellipse() {}, lineTo() {}, fillRect() {}, fillText() {},
    moveTo(x, y) { pts.push({ x, y }); },
  };
  return { rs, pts };
}

const ARC = { arc: { shape: 'arc', color: '#fff', width: 2, duration_ms: 400, ease: 'linear', fade: true } };
const swing = (a, x = 0, y = 0) => ({ a, v: 'arc', x, y, nx: 1, ny: 0, reach: 80, arc: 1, hit: true });

const actors = {
  player: { userId: '7', x: 1000, y: 2000, width: 64, height: 64 },
  remotePlayers: new Map([['8', { x: 300, y: 400, width: 64, height: 64 }]]),
  creatures: new Map([[42, { id: 42, x: 500, y: 600, width: 48, height: 48 }]]),
  localUserId: '7',
};

describe('_resolveVfxOrigin', () => {
  it('re-anchors a local-player swing to the player\'s current centre', () => {
    const { rs } = renderer();
    expect(rs._resolveVfxOrigin(swing('p:7'), actors)).toEqual({ x: 1032, y: 2032 });
  });

  it('re-anchors a remote-player swing to that remote player\'s current centre', () => {
    const { rs } = renderer();
    expect(rs._resolveVfxOrigin(swing('p:8'), actors)).toEqual({ x: 332, y: 432 });
  });

  it('re-anchors a creature swing (numeric map key, string actor id)', () => {
    const { rs } = renderer();
    expect(rs._resolveVfxOrigin(swing('c:42'), actors)).toEqual({ x: 524, y: 624 });
  });

  it('re-anchors a creature swing when creatures arrive as an array', () => {
    const { rs } = renderer();
    const arr = { creatures: [{ id: 42, x: 10, y: 20, width: 48, height: 48 }] };
    expect(rs._resolveVfxOrigin(swing('c:42'), arr)).toEqual({ x: 34, y: 44 });
  });

  it('falls back to the stamped position for an actor that is not known', () => {
    const { rs } = renderer();
    expect(rs._resolveVfxOrigin(swing('p:999', 11, 22), actors)).toEqual({ x: 11, y: 22 });
    expect(rs._resolveVfxOrigin(swing('c:999', 11, 22), actors)).toEqual({ x: 11, y: 22 });
    expect(rs._resolveVfxOrigin(swing(null, 11, 22), actors)).toEqual({ x: 11, y: 22 });
  });
});

describe('drawVfx tracking', () => {
  it('draws a swing at the actor\'s current position, not its stamped one', () => {
    const { rs, pts } = renderer();
    const list = addEffects([], [swing('c:42', 0, 0)], 0, ARC);
    rs.drawVfx(list, actors);
    const s = worldToScreen(524, 624);
    expect(pts[0].x).toBeCloseTo(s.x, 6);
    expect(pts[0].y).toBeCloseTo(anchorY(s.y, undefined), 6);
  });

  it('leaves an impact where it landed even when it names a tracked target', () => {
    const { rs, pts } = renderer();
    // An impact on the local player: `t` is the player, there is no `a`.
    const list = addEffects([], [{ t: 'p:7', v: 'arc', x: 50, y: 60, nx: 1, ny: 0, reach: 80, arc: 1 }], 0, ARC);
    expect(list[0].a).toBe(null);
    rs.drawVfx(list, actors);
    const s = worldToScreen(50, 60);
    expect(pts[0].x).toBeCloseTo(s.x, 6);
    expect(pts[0].y).toBeCloseTo(anchorY(s.y, undefined), 6);
  });
});
