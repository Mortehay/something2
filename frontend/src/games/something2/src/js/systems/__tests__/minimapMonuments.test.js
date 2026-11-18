// Monument markers on the minimap (SOMET-782).
import { describe, it, expect } from 'vitest';
import { drawMinimap, worldTileToView, MONUMENT_MARKER } from '../minimapRenderer.js';
import { renderFrame } from '../minimapFrame.js';

function stubCtx() {
  const calls = [];
  const state = { fillStyle: null, strokeStyle: null, globalAlpha: 1, lineWidth: 1 };
  const rec = (name) => (...args) => calls.push({ name, args, fill: state.fillStyle, stroke: state.strokeStyle });
  const ctx = { calls, save: rec('save'), restore: rec('restore') };
  for (const k of Object.keys(state)) {
    Object.defineProperty(ctx, k, { get: () => state[k], set: (v) => { state[k] = v; } });
  }
  for (const n of ['beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'fillRect', 'arc', 'translate', 'rotate', 'fillText', 'drawImage']) ctx[n] = rec(n);
  return ctx;
}

const view = { centerCol: 32, centerRow: 32, step: 4, cellW: 12, boxW: 180, boxH: 180 };
const base = { overview: null, player: { col: 32, row: 32, dir: { dx: 0, dy: 1 } }, creatures: [], doorways: [], villages: [], view };

describe('monuments on the minimap', () => {
  it('draws one stone triangle per monument, apex above its footprint centre', () => {
    const ctx = stubCtx();
    drawMinimap(ctx, { ...base, monuments: [{ type: 'collapsed_tower', col: 40, row: 28 }, { type: 'giant_skull', col: 20, row: 36 }] });
    const fills = ctx.calls.filter((c) => c.name === 'fill' && c.fill === MONUMENT_MARKER.fill);
    expect(fills).toHaveLength(2);
    const apexes = ctx.calls.filter((c, i) => c.name === 'moveTo' && ctx.calls[i + 3] && ctx.calls[i + 3].name === 'closePath');
    const want = [worldTileToView(40, 28, view), worldTileToView(20, 36, view)];
    for (const w of want) {
      expect(apexes.some((a) => a.args[0] === w.x && a.args[1] === w.y - MONUMENT_MARKER.size)).toBe(true);
    }
  });

  it('no monuments, no marker (absent list is fine)', () => {
    const ctx = stubCtx();
    drawMinimap(ctx, base);
    expect(ctx.calls.some((c) => c.name === 'fill' && c.fill === MONUMENT_MARKER.fill)).toBe(false);
  });

  it('the frame hands the overview monuments to the renderer', () => {
    const ctx = stubCtx();
    const overview = { world_id: 'w', step: 4, villages: [], doorways: [], monuments: [{ type: 'broken_statue', col: 33, row: 33 }] };
    ctx.setTransform = () => {}; ctx.clearRect = () => {};
    const ok = renderFrame(ctx, 1, 180, 12, {
      gameRef: { current: { getMinimapSnapshot: () => ({ worldId: 'w', player: { x: 3200, y: 3200 } }) } },
      overviewRef: { current: overview },
      layerCache: { get: () => null },
      tileColors: {},
    });
    expect(ok).toBe(true);
    expect(ctx.calls.some((c) => c.name === 'fill' && c.fill === MONUMENT_MARKER.fill)).toBe(true);
  });
});
