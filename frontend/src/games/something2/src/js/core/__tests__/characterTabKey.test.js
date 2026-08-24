// SOMET-483: the C key, driven through Game's REAL keydown handler.
//
// C used to belong to CharacterSheet.jsx, the standalone level popup that
// SOMET-483 deleted. It is REUSED rather than retired -- it opens the
// inventory panel on its Character tab -- and hotkeyRegistry.test.js pins that
// exactly one handler claims it. What that source-level test cannot see is
// what the key DOES, which is what this file drives: setupInput() attaches the
// handler to a stubbed window (this env is plain node, no jsdom) and the
// handler is then invoked directly, the same technique debugKeyRepeat.test.js
// established.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Game } from '../Game.js';

describe('the C key opens the Character tab', () => {
  let originalWindow;

  beforeEach(() => {
    originalWindow = globalThis.window;
    globalThis.window = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  });
  afterEach(() => { globalThis.window = originalWindow; });

  function makeGame() {
    const g = new Game();
    g.canvas = {
      addEventListener: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      width: 100, height: 100,
    };
    g.state = 'playing';
    g.chunked = true;
    g.renderSystem = { _invHitAreas: [] };
    // Fire-and-forget HTTP; counted rather than performed.
    g._refreshProgressionBundle = () => { g._bundleRefreshes = (g._bundleRefreshes || 0) + 1; };
    g.setupInput();
    return g;
  }

  const press = (g, over = {}) => g._keydownHandler({ key: 'c', repeat: false, ...over });

  it('opens the panel directly on the Character tab from closed', () => {
    const g = makeGame();
    expect(g.inventoryOpen).toBe(false);
    press(g);
    expect(g.inventoryOpen).toBe(true);
    expect(g.inventoryTab).toBe('character');
    expect(g._bundleRefreshes).toBe(1);
  });

  it('closes the panel when it is already showing the Character tab', () => {
    const g = makeGame();
    press(g);
    press(g);
    expect(g.inventoryOpen).toBe(false);
  });

  it('SWITCHES to the Character tab from another tab rather than closing', () => {
    // "Show me my character" is one intent. Closing here would make the key's
    // effect depend on which tab happened to be showing.
    const g = makeGame();
    g.inventoryOpen = true;
    g.inventoryTab = 'stones';
    g.inventoryPage = 3;
    press(g);
    expect(g.inventoryOpen).toBe(true);
    expect(g.inventoryTab).toBe('character');
    expect(g.inventoryPage).toBe(0);
    expect(g.characterModPage).toBe(0);
  });

  it('is layout-independent -- e.code works when e.key is not the latin letter', () => {
    // bfd67ab's rule: a Cyrillic or AZERTY layout must still open the panel.
    const g = makeGame();
    g._keydownHandler({ key: 'с', code: 'KeyC', repeat: false });   // Cyrillic es
    expect(g.inventoryTab).toBe('character');
  });

  it('ignores OS auto-repeat while the key is held', () => {
    const g = makeGame();
    press(g);
    press(g, { repeat: true });
    press(g, { repeat: true });
    expect(g.inventoryOpen).toBe(true);
    expect(g.inventoryTab).toBe('character');
  });

  it('does nothing while another centred panel is open', () => {
    // Same gate 'i' has: two centred panels must never stack.
    for (const flag of ['shopOpen', 'bankOpen', 'passiveTreeOpen']) {
      const g = makeGame();
      g[flag] = true;
      press(g);
      expect(g.inventoryOpen, `${flag} did not gate C`).toBe(false);
    }
  });

  it('does nothing outside a playing chunked world', () => {
    const g = makeGame();
    g.state = 'menu';
    press(g);
    expect(g.inventoryOpen).toBe(false);
  });

  it('does not fire on any other letter', () => {
    // The guard is a claim on ONE letter; a regression that broadened it would
    // make every keystroke open the sheet.
    const g = makeGame();
    for (const key of ['x', 'v', 'd']) {
      g._keydownHandler({ key, repeat: false });
    }
    expect(g.inventoryTab).not.toBe('character');
  });
});
