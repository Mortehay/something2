import { describe, it, expect, vi } from 'vitest';
import { bindGameCanvas } from '../gameCanvasBinding.js';

// A fake Game standing in for core/Game.js's real class: its constructor
// takes no argument (matching the real one exactly — see the comment in
// gameCanvasBinding.js), so any test that relies on `new FakeGame(canvas)`
// implicitly binding the canvas is testing the actual historical bug.
class FakeGame {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.resizeCanvas = vi.fn();
    // Real Game.js has `init` as a prototype method — always a truthy
    // function reference. Keep that here so a test failure is driven by
    // the actual bug under test (missing resizeCanvas()/canvas rebind),
    // not by this fake missing an unrelated method.
    this.init = () => {};
  }
}

function fakeCanvas(ctxSentinel) {
  return { getContext: vi.fn(() => ctxSentinel) };
}

describe('bindGameCanvas', () => {
  it('does nothing when there is no canvas element yet', () => {
    const createGame = vi.fn();
    const result = bindGameCanvas(null, null, createGame);
    expect(result).toBeNull();
    expect(createGame).not.toHaveBeenCalled();
  });

  // Regression for the "Enter World occasionally no-ops on a mount race"
  // observation: a freshly created Game must actually end up bound to the
  // canvas it was created for, not rely on a constructor argument that
  // the real Game class silently ignores.
  it('binds canvas + ctx + sizing on a fresh Game, not just constructs one', () => {
    const ctxA = { tag: 'ctxA' };
    const canvasA = fakeCanvas(ctxA);
    const createGame = vi.fn(() => new FakeGame());

    const game = bindGameCanvas(null, canvasA, createGame);

    expect(createGame).toHaveBeenCalledTimes(1);
    expect(game.canvas).toBe(canvasA);
    expect(game.ctx).toBe(ctxA);
    expect(game.resizeCanvas).toHaveBeenCalledTimes(1);
  });

  it('does not create a second Game when one already exists', () => {
    const existing = new FakeGame();
    const createGame = vi.fn();

    const game = bindGameCanvas(existing, fakeCanvas({}), createGame);

    expect(game).toBe(existing);
    expect(createGame).not.toHaveBeenCalled();
  });

  // Regression for F-045 itself: signing out and back in (no page reload)
  // unmounts and remounts the <canvas> DOM node while the same Game/gameRef
  // instance survives underneath. Rebinding to the new node must update
  // canvas/ctx AND re-run resizeCanvas() — otherwise the new node is stuck
  // at the browser's 300x150 default and the game renders blank while the
  // authority socket and rAF loop keep running (confirmed live: HP dropped
  // with no visible feedback).
  it('rebinds an existing Game to a brand-new canvas node and re-sizes it', () => {
    const ctxOld = { tag: 'old' };
    const ctxNew = { tag: 'new' };
    const canvasOld = fakeCanvas(ctxOld);
    const canvasNew = fakeCanvas(ctxNew);
    const existing = new FakeGame();
    existing.canvas = canvasOld;
    existing.ctx = ctxOld;

    const game = bindGameCanvas(existing, canvasNew, () => {
      throw new Error('must not construct a second Game');
    });

    expect(game).toBe(existing);
    expect(game.canvas).toBe(canvasNew);
    expect(game.canvas).not.toBe(canvasOld);
    expect(game.ctx).toBe(ctxNew);
    expect(game.resizeCanvas).toHaveBeenCalledTimes(1);
  });
});
