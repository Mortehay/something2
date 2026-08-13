import { describe, it, expect } from 'vitest';
import { landmarkPulse, landmarkColor, drawLandmarks, PULSE_PERIOD_MS } from '../landmarkRenderer.js';
import { worldToScreen } from '../../core/iso.js';

// Records what was asked of the canvas. Only the calls the assertions actually
// read are recorded -- a stub that silently swallows an unknown method would
// let a typo'd ctx call pass as a drawn marker.
function stubCtx() {
  const calls = [];
  const state = { globalAlpha: 1, fillStyle: null, strokeStyle: null, lineWidth: 1 };
  const rec = (name) => (...args) => calls.push({
    name, args, alpha: state.globalAlpha, fill: state.fillStyle, stroke: state.strokeStyle,
  });
  return {
    calls,
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(v) { state.globalAlpha = v; },
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v) { state.fillStyle = v; },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v) { state.strokeStyle = v; },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(v) { state.lineWidth = v; },
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    closePath: rec('closePath'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    createLinearGradient: () => ({ addColorStop() {} }),
    fillRect: rec('fillRect'),
  };
}

const WAYPOINT = { kind: 'waypoint', x: 3250, y: 3250, name: 'Commons', activated: true };
const UNLIT = { ...WAYPOINT, activated: false };
const PORTAL = { kind: 'portal', x: 3150, y: 3450, name: 'To Windwatch Pass', activated: false };

describe('landmarkPulse', () => {
  it('is bounded, so a marker never vanishes and never overpowers the tile', () => {
    for (let p = 0; p < PULSE_PERIOD_MS * 2; p += 37) {
      const a = landmarkPulse(p);
      expect(a).toBeGreaterThanOrEqual(0.35);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it('actually varies with phase -- a constant here would be a dead pulse', () => {
    const trough = landmarkPulse(PULSE_PERIOD_MS * 0.75);
    const peak = landmarkPulse(PULSE_PERIOD_MS * 0.25);
    expect(peak).toBeGreaterThan(trough + 0.5);
  });

  it('repeats every period, so two frames a period apart look identical', () => {
    expect(landmarkPulse(123)).toBeCloseTo(landmarkPulse(123 + PULSE_PERIOD_MS), 10);
  });

  it('treats a missing phase as zero rather than producing NaN', () => {
    // A NaN alpha silently draws nothing on a real canvas -- the exact way an
    // "it works" render becomes an invisible one.
    expect(Number.isNaN(landmarkPulse(undefined))).toBe(false);
  });
});

describe('landmarkColor', () => {
  it('gives waypoints and portals visibly different colours', () => {
    expect(landmarkColor('waypoint')).not.toBe(landmarkColor('portal'));
  });
  it('does not reuse the minimap doorway purple for portals', () => {
    // minimapRenderer draws doorways in #c084fc. A portal marker in the same
    // colour would read as "there is a doorway here", which is a different
    // thing a player would walk to for a different reason.
    expect(landmarkColor('portal').toLowerCase()).not.toBe('#c084fc');
  });
});

describe('drawLandmarks', () => {
  const view = { halfW: 32, halfH: 16 };

  it('draws each landmark at the screen point its world tile projects to', () => {
    const ctx = stubCtx();
    drawLandmarks(ctx, { landmarks: [WAYPOINT], phase: 0, ...view });
    const s = worldToScreen(WAYPOINT.x, WAYPOINT.y);
    // The diamond's top vertex is the first moveTo of the marker path.
    const moves = ctx.calls.filter((c) => c.name === 'moveTo');
    expect(moves.length).toBeGreaterThan(0);
    expect(moves[0].args[0]).toBeCloseTo(s.x, 6);
    expect(moves[0].args[1]).toBeCloseTo(s.y - view.halfH, 6);
  });

  it('an activated waypoint fills; an unactivated one only strokes', () => {
    const lit = stubCtx();
    drawLandmarks(lit, { landmarks: [WAYPOINT], phase: 0, ...view });
    const dark = stubCtx();
    drawLandmarks(dark, { landmarks: [UNLIT], phase: 0, ...view });

    expect(lit.calls.some((c) => c.name === 'fill')).toBe(true);
    expect(dark.calls.some((c) => c.name === 'fill')).toBe(false);
    expect(dark.calls.some((c) => c.name === 'stroke')).toBe(true);
  });

  it('drives alpha from the phase it is given, not from a clock it reads', () => {
    // The whole reason phase is a parameter. If drawLandmarks called
    // performance.now() itself, these two would be equal by accident of timing
    // and the pulse could never be pinned.
    const a = stubCtx();
    drawLandmarks(a, { landmarks: [WAYPOINT], phase: PULSE_PERIOD_MS * 0.25, ...view });
    const b = stubCtx();
    drawLandmarks(b, { landmarks: [WAYPOINT], phase: PULSE_PERIOD_MS * 0.75, ...view });

    const alphaOf = (ctx) => ctx.calls.find((c) => c.name === 'fill' || c.name === 'stroke').alpha;
    expect(alphaOf(a)).not.toBeCloseTo(alphaOf(b), 3);
  });

  it('draws every landmark it is given', () => {
    const ctx = stubCtx();
    drawLandmarks(ctx, { landmarks: [WAYPOINT, PORTAL], phase: 0, ...view });
    const marks = ctx.calls.filter((c) => c.name === 'closePath');
    expect(marks.length).toBeGreaterThanOrEqual(2);
  });

  it('is a no-op for an empty or absent list -- 86 worlds have no landmarks', () => {
    const empty = stubCtx();
    drawLandmarks(empty, { landmarks: [], phase: 0, ...view });
    expect(empty.calls.length).toBe(0);

    const missing = stubCtx();
    expect(() => drawLandmarks(missing, { phase: 0, ...view })).not.toThrow();
    expect(missing.calls.length).toBe(0);
  });

  it('skips a malformed landmark instead of drawing it at NaN', () => {
    const ctx = stubCtx();
    drawLandmarks(ctx, {
      landmarks: [{ kind: 'waypoint', x: null, y: 10, activated: true }, WAYPOINT],
      phase: 0,
      ...view,
    });
    for (const c of ctx.calls) {
      for (const a of c.args) expect(Number.isNaN(a)).toBe(false);
    }
    expect(ctx.calls.filter((c) => c.name === 'closePath').length).toBe(1);
  });
});
