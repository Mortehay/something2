// Landmark markers on the minimap (SOMET-298).
import { describe, it, expect } from 'vitest';
import { drawMinimap, worldTileToView } from '../minimapRenderer.js';
import { PULSE_PERIOD_MS } from '../landmarkRenderer.js';
import { MAP_TILE_SIZE } from '../../core/constants.js';

// save/restore implement a REAL state stack, not a pair of recorders. A stub
// whose restore() did nothing would report the leaked alpha the code never
// leaked -- and, worse, would pass unchanged if the code dropped its restore()
// entirely. The stack is the only thing that makes "alpha is restored" a claim
// about the code.
function stubCtx() {
  const calls = [];
  const state = { globalAlpha: 1, fillStyle: null, strokeStyle: null, lineWidth: 1 };
  const stack = [];
  const rec = (name) => (...args) => calls.push({
    name, args, alpha: state.globalAlpha, fill: state.fillStyle, stroke: state.strokeStyle,
  });
  return {
    calls,
    save(...args) {
      rec('save')(...args);
      stack.push({ ...state });
    },
    restore(...args) {
      rec('restore')(...args);
      const prev = stack.pop();
      if (prev) Object.assign(state, prev);
    },
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(v) { state.globalAlpha = v; },
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v) { state.fillStyle = v; },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v) { state.strokeStyle = v; },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(v) { state.lineWidth = v; },
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'),
    fillRect: rec('fillRect'), arc: rec('arc'),
    translate: rec('translate'), rotate: rec('rotate'),
  };
}

const view = { centerCol: 32, centerRow: 32, step: 4, cellW: 12, boxW: 180, boxH: 180 };
const base = {
  overview: null,
  tileColors: {},
  player: { col: 32, row: 32, dir: { dx: 0, dy: 1 } },
  creatures: [],
  doorways: [],
  villages: [],
  view,
};

// The Old Trailhead waypoint, in the units the Game snapshot carries (world px).
const WAYPOINT = { kind: 'waypoint', x: 3250, y: 3250, name: 'Commons', activated: true };
const PORTAL = { kind: 'portal', x: 3150, y: 3450, name: 'To Windwatch Pass', activated: false };

describe('drawMinimap landmarks', () => {
  it('draws a landmark at the point its world tile projects to', () => {
    const ctx = stubCtx();
    drawMinimap(ctx, { ...base, landmarks: [WAYPOINT], phase: 0 });

    const expected = worldTileToView(WAYPOINT.x / MAP_TILE_SIZE, WAYPOINT.y / MAP_TILE_SIZE, view);
    // The landmark is the only thing drawn with a `moveTo` here: no overview,
    // no doorways, and the player is a rotated triangle drawn after a translate,
    // so its path coordinates are local. Find the marker by its own colour.
    const marks = ctx.calls.filter((c) => c.name === 'moveTo' && !c.args.every((a) => Math.abs(a) < 8));
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].args[0]).toBeCloseTo(expected.x, 6);
  });

  it('pulses off the phase it is handed, like every other landmark surface', () => {
    const alphaOf = (phase) => {
      const ctx = stubCtx();
      drawMinimap(ctx, { ...base, landmarks: [WAYPOINT], phase });
      const c = ctx.calls.find((x) => (x.name === 'fill' || x.name === 'stroke') && x.alpha !== 1);
      return c ? c.alpha : 1;
    };
    expect(alphaOf(PULSE_PERIOD_MS * 0.25)).not.toBeCloseTo(alphaOf(PULSE_PERIOD_MS * 0.75), 3);
  });

  it('restores full alpha afterwards so the player dot is never dimmed', () => {
    // The player marker is drawn last. If the landmark pass leaked its pulsing
    // alpha, the player would fade in and out too -- a bug that looks like a
    // rendering glitch rather than like a landmark feature.
    const ctx = stubCtx();
    drawMinimap(ctx, { ...base, landmarks: [WAYPOINT], phase: PULSE_PERIOD_MS * 0.75 });
    const playerArc = ctx.calls.filter((c) => c.name === 'arc').pop();
    expect(playerArc.alpha).toBe(1);
  });

  it('distinguishes an unactivated waypoint from an activated one', () => {
    const lit = stubCtx();
    drawMinimap(lit, { ...base, landmarks: [WAYPOINT], phase: 0 });
    const dark = stubCtx();
    drawMinimap(dark, { ...base, landmarks: [{ ...WAYPOINT, activated: false }], phase: 0 });
    expect(dark.calls.some((c) => c.name === 'stroke')).toBe(true);
    expect(lit.calls.some((c) => c.name === 'stroke')).toBe(false);
  });

  it('draws both kinds', () => {
    const ctx = stubCtx();
    drawMinimap(ctx, { ...base, landmarks: [WAYPOINT, PORTAL], phase: 0 });
    const colors = new Set(ctx.calls.filter((c) => c.name === 'fill' || c.name === 'stroke')
      .map((c) => c.fill || c.stroke));
    // Two distinct landmark colours present, plus the player's own.
    expect(colors.size).toBeGreaterThanOrEqual(3);
  });

  it('is unaffected by an absent landmarks list -- every existing caller omits it', () => {
    const ctx = stubCtx();
    expect(() => drawMinimap(ctx, base)).not.toThrow();
  });
});
