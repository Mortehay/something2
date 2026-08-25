// SOMET-489: the HUD orbs were cut off unless the game ran fullscreen, because
// the canvas was letterboxed against the WINDOW while it lives inside
// GameShell's content area (window minus the left sidebar and the top header)
// and that container clips what overflows.
//
// Frontend vitest runs in a plain node environment (no DOM -- see
// vitest.config.js), so resizeCanvas() is exercised against hand-built canvas
// and container stubs. They are stubs of the two things the method actually
// reads (a parent rect and a style object), not of the method itself: the code
// under test is the real Game.prototype.resizeCanvas.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fitCanvasBox, GAME_ASPECT } from '../core/canvasFit.js';
import { GAME_WIDTH, GAME_HEIGHT } from '../core/constants.js';
import { Game } from '../core/Game.js';

describe('fitCanvasBox', () => {
  it('fills the height and bars the sides when the box is wider than 16:9', () => {
    const fit = fitCanvasBox(2000, 900);
    expect(fit.height).toBe(900);
    expect(fit.width).toBe(1600);
    expect(fit.left).toBe(200);
    expect(fit.top).toBe(0);
  });

  it('fills the width and bars top/bottom when the box is taller than 16:9', () => {
    const fit = fitCanvasBox(1600, 1200);
    expect(fit.width).toBe(1600);
    expect(fit.height).toBe(900);
    expect(fit.left).toBe(0);
    expect(fit.top).toBe(150);
  });

  it('reports an empty fit for a box with no layout yet', () => {
    expect(fitCanvasBox(0, 0)).toEqual({ width: 0, height: 0, left: 0, top: 0 });
    expect(fitCanvasBox(1200, 0)).toEqual({ width: 0, height: 0, left: 0, top: 0 });
    expect(fitCanvasBox(NaN, NaN)).toEqual({ width: 0, height: 0, left: 0, top: 0 });
  });

  // The property that actually matters: whatever the box, the fitted element
  // plus its centring offset stays inside it. An element one pixel over is an
  // element the container crops, and the cropped strip is the HUD.
  it('never places the element outside the box, at any size', () => {
    const boxes = [
      [1585, 976], [1855, 1061], [1280, 720], [640, 1000], [1000, 641],
      [1367, 769], [301, 173], [1920, 1080], [777, 777],
    ];
    for (const [w, h] of boxes) {
      const fit = fitCanvasBox(w, h);
      expect(fit.left).toBeGreaterThanOrEqual(0);
      expect(fit.top).toBeGreaterThanOrEqual(0);
      expect(fit.left + fit.width).toBeLessThanOrEqual(w);
      expect(fit.top + fit.height).toBeLessThanOrEqual(h);
      // ...and it is still the game's aspect, within the pixel that flooring
      // can take off.
      expect(Math.abs(fit.width / fit.height - GAME_ASPECT)).toBeLessThan(0.01);
    }
  });
});

// A canvas stub exposing exactly what resizeCanvas touches.
function makeCanvas(containerW, containerH) {
  const canvas = {
    width: 300,
    height: 150,
    style: {},
    parentElement: {
      getBoundingClientRect: () => ({ width: containerW, height: containerH }),
    },
  };
  return canvas;
}

function px(value) {
  return Number.parseFloat(value);
}

describe('Game.resizeCanvas', () => {
  let game;

  beforeEach(() => {
    // The real method on a bare instance: the constructor builds a renderer,
    // an image manager and a socket client, none of which resizeCanvas reads.
    game = Object.create(Game.prototype);
    // The window is deliberately LARGER than the container in every case
    // below -- that difference is the bug.
    vi.stubGlobal('window', { innerWidth: 1855, innerHeight: 1061 });
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb) { this.cb = cb; }
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('fits the canvas to its container, not to the window', () => {
    // GameShell's content area at a typical non-maximised window: the window
    // minus the ~270px sidebar and the ~85px header.
    game.canvas = makeCanvas(1585, 976);
    game.resizeCanvas();

    const w = px(game.canvas.style.width);
    const h = px(game.canvas.style.height);
    const left = px(game.canvas.style.left);
    const top = px(game.canvas.style.top);

    expect(left + w).toBeLessThanOrEqual(1585);
    expect(top + h).toBeLessThanOrEqual(976);
    // Sizing to the window would have produced a 1825px-wide element here.
    expect(w).toBeLessThanOrEqual(1585);
  });

  it('centres the canvas with absolute offsets and no margin', () => {
    game.canvas = makeCanvas(1600, 1200);
    game.resizeCanvas();

    expect(game.canvas.style.position).toBe('absolute');
    expect(game.canvas.style.margin).toBe('0');
    expect(game.canvas.style.left).toBe('0px');
    expect(game.canvas.style.top).toBe('150px');
  });

  it('keeps the backing store at the fixed game resolution', () => {
    game.canvas = makeCanvas(1585, 976);
    game.resizeCanvas();
    expect(game.canvas.width).toBe(GAME_WIDTH);
    expect(game.canvas.height).toBe(GAME_HEIGHT);
  });

  it('leaves the last good size alone when the container measures zero', () => {
    game.canvas = makeCanvas(1585, 976);
    game.resizeCanvas();
    const before = { ...game.canvas.style };
    // Pinned to the container-derived value, so this test cannot pass merely
    // because nothing ever changes the box.
    expect(before.width).toBe('1585px');

    // Hidden container (display:none on a route change) -> a 0x0 rect. Sizing
    // to it would collapse the element with nothing to restore it.
    game.canvas.parentElement.getBoundingClientRect = () => ({ width: 0, height: 0 });
    game.resizeCanvas();
    expect(game.canvas.style.width).toBe(before.width);
    expect(game.canvas.style.height).toBe(before.height);
  });

  it('falls back to the window for a canvas with no parent', () => {
    const canvas = makeCanvas(0, 0);
    canvas.parentElement = null;
    game.canvas = canvas;
    game.resizeCanvas();
    // 1855/1061 is 1.75 -- taller than 16:9 -- so the WIDTH is what fills and
    // the height is letterboxed down to it.
    expect(px(game.canvas.style.width)).toBe(1855);
    expect(px(game.canvas.style.height)).toBe(1043);
  });

  it('re-observes after the canvas is rebound to a node in another container', () => {
    const observed = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb) { this.cb = cb; }
      observe(el) { observed.push(el); }
      disconnect() { this.disconnected = true; }
    });

    game.canvas = makeCanvas(1585, 976);
    game.resizeCanvas();
    game.resizeCanvas(); // same node -> must not stack a second observer
    expect(observed).toHaveLength(1);

    game.canvas = makeCanvas(800, 600); // bindGameCanvas gave us a new node
    game.resizeCanvas();
    expect(observed).toHaveLength(2);
    expect(observed[1]).toBe(game.canvas.parentElement);
  });
});
