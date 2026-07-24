import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Game } from '../Game.js';

// F-031/SOMET-211: the 't' (toggle tile textures) and 'm' (cycle render-mode
// override) dev keydown handlers were missing the `!e.repeat` guard every
// other one-shot hotkey in setupInput() already has ('i', 'e', 'g') -- so
// holding the key down re-fired the toggle/cycle on every OS auto-repeat
// tick instead of once per physical press, leaving the rendered state after
// release effectively unpredictable (whichever parity the repeat count
// happened to land on).
//
// setupInput() reaches out to `window`/`this.canvas` (this test's env is
// plain node, no jsdom), so both are stubbed just enough to let it attach
// listeners without throwing; the handler itself is then invoked directly.
describe('Game debug key repeat guard', () => {
  let originalWindow;

  beforeEach(() => {
    originalWindow = globalThis.window;
    globalThis.window = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  function makeGame() {
    const g = new Game();
    g.canvas = {
      addEventListener: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      width: 100,
      height: 100,
    };
    g.state = 'playing';
    g.chunked = true;
    g.renderSystem = {
      toggleTileTextures: vi.fn(() => true),
      cycleRenderModeOverride: vi.fn(() => 'rect'),
    };
    g.setupInput();
    return g;
  }

  it("does not re-toggle tile textures on OS auto-repeat while 't' is held", () => {
    const g = makeGame();
    g._keydownHandler({ key: 't', repeat: false });
    // OS auto-repeat: the same physical press, key still down.
    g._keydownHandler({ key: 't', repeat: true });
    g._keydownHandler({ key: 't', repeat: true });
    expect(g.renderSystem.toggleTileTextures).toHaveBeenCalledTimes(1);
  });

  it("does not re-cycle the render-mode override on OS auto-repeat while 'm' is held", () => {
    const g = makeGame();
    g._keydownHandler({ key: 'm', repeat: false });
    g._keydownHandler({ key: 'm', repeat: true });
    g._keydownHandler({ key: 'm', repeat: true });
    expect(g.renderSystem.cycleRenderModeOverride).toHaveBeenCalledTimes(1);
  });

  it('still fires once on a fresh (non-repeat) press after release', () => {
    const g = makeGame();
    g._keydownHandler({ key: 't', repeat: false });
    g._keydownHandler({ key: 't', repeat: true });
    // Key released, then pressed again -- a genuinely new press.
    g._keydownHandler({ key: 't', repeat: false });
    expect(g.renderSystem.toggleTileTextures).toHaveBeenCalledTimes(2);
  });
});
