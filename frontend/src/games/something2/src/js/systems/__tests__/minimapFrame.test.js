// SOMET-488. The creature dots vanished from the minimap and from its expand
// modal, silently: commit 8e28bea dropped the world-pixel -> tile conversion in
// this seam (then still inline in Minimap.jsx), so drawMinimap started reading
// `cr.col`/`cr.row` off records that only carry `x`/`y`. worldTileToView turned
// the undefineds into NaN, Canvas 2D ignores a non-finite arc, and nothing threw. Every renderer test stayed green
// because they call drawMinimap directly with already-correct records.
//
// So this suite drives renderFrame -- the seam that owns the translation -- with
// a recording context, and asserts against a position derived from the
// projection itself. A creature is placed away from the player on purpose: a
// regression that hands over zeros, or the player's own tile, fails here.
import { describe, it, expect } from 'vitest';
import { renderFrame } from '../minimapFrame.js';
import { worldTileToView } from '../minimapRenderer.js';
import { MAP_TILE_SIZE } from '../../core/constants.js';

const BOX = 180;
const CELL_W = 12;
const FALLBACK_STEP = 4; // the seam's step until the first overview lands

// Records every arc() the renderer draws, and stays quiet about everything else.
function recordingCtx() {
  const arcs = [];
  const noop = () => {};
  return {
    arcs,
    setTransform: noop, clearRect: noop, drawImage: noop,
    save: noop, restore: noop, translate: noop, rotate: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop,
    fill: noop, stroke: noop, fillRect: noop, fillText: noop,
    arc: (x, y, r) => arcs.push({ x, y, r, style: undefined }),
  };
}

function harness(snapshot) {
  return {
    gameRef: { current: { getMinimapSnapshot: () => snapshot } },
    overviewRef: { current: null },
    tileColors: {},
    layerCache: { get: () => null },
  };
}

const PLAYER = { x: 1000, y: 1000, dir: { dx: 0, dy: 1 } };

describe('minimap creature markers', () => {
  const snapshot = {
    worldId: 7,
    chunkSize: 16,
    landmarks: [],
    doorways: [],
    player: PLAYER,
    // Two tiles east and one south of the player, in world pixels -- the shape
    // Game.getMinimapSnapshot actually produces.
    creatures: [{ x: 1200, y: 1100, color: '#ff0000' }],
  };

  it('draws a creature dot at the projected tile, not at a non-finite point', () => {
    const ctx = recordingCtx();
    expect(renderFrame(ctx, 1, BOX, CELL_W, harness(snapshot))).toBe(true);

    const view = {
      centerCol: PLAYER.x / MAP_TILE_SIZE,
      centerRow: PLAYER.y / MAP_TILE_SIZE,
      step: FALLBACK_STEP,
      cellW: CELL_W,
      boxW: BOX,
      boxH: BOX,
    };
    const want = worldTileToView(1200 / MAP_TILE_SIZE, 1100 / MAP_TILE_SIZE, view);

    const dot = ctx.arcs.find((a) => Math.abs(a.x - want.x) < 0.001 && Math.abs(a.y - want.y) < 0.001);
    expect(dot, `no creature dot near (${want.x}, ${want.y}); drew ${JSON.stringify(ctx.arcs)}`).toBeTruthy();
    // Off the box center, or the assertion above would also pass for a marker
    // pinned to the player.
    expect(Math.hypot(want.x - BOX / 2, want.y - BOX / 2)).toBeGreaterThan(1);
  });

  it('never hands the canvas a non-finite coordinate', () => {
    const ctx = recordingCtx();
    renderFrame(ctx, 1, BOX, CELL_W, harness(snapshot));
    expect(ctx.arcs.length).toBeGreaterThan(0);
    for (const a of ctx.arcs) {
      expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
    }
  });

  it('draws one dot per creature', () => {
    const ctx = recordingCtx();
    renderFrame(ctx, 1, BOX, CELL_W, harness({
      ...snapshot,
      creatures: [
        { x: 1200, y: 1100, color: '#ff0000' },
        { x: 800, y: 1300, color: '#00ff00' },
        { x: 1500, y: 900, color: '#0000ff' },
      ],
    }));
    // The player contributes exactly one arc of its own (r=3); creature dots are
    // r=2. Finiteness is part of the filter on purpose -- without it this count
    // is satisfied by three NaN dots, which is precisely the bug.
    const dots = ctx.arcs.filter((a) => a.r === 2 && Number.isFinite(a.x) && Number.isFinite(a.y));
    expect(dots).toHaveLength(3);
  });
});
