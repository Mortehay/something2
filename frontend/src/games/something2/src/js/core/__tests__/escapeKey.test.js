import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Game } from '../Game.js';

describe('Game Escape key handling', () => {
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
    g.setupInput();
    return g;
  }

  it('closes open inventory on Escape without pausing the game', () => {
    const g = makeGame();
    g.inventoryOpen = true;
    g.inventorySelectedItemId = 'item-123';
    const preventDefault = vi.fn();

    g._keydownHandler({ key: 'Escape', code: 'Escape', preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(g.inventoryOpen).toBe(false);
    expect(g.inventorySelectedItemId).toBeNull();
    expect(g.state).toBe('playing');
  });

  it('closes open shop on Escape without closing or pausing game', () => {
    const g = makeGame();
    g.shopOpen = true;
    const preventDefault = vi.fn();

    g._keydownHandler({ key: 'Escape', code: 'Escape', preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(g.shopOpen).toBe(false);
    expect(g.state).toBe('playing');
  });

  it('closes open bank on Escape without pausing game', () => {
    const g = makeGame();
    g.bankOpen = true;
    const preventDefault = vi.fn();

    g._keydownHandler({ key: 'Escape', code: 'Escape', preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(g.bankOpen).toBe(false);
    expect(g.state).toBe('playing');
  });

  it('does not pause or interrupt when playing and no panel is open', () => {
    const g = makeGame();
    g.pause = vi.fn();
    const preventDefault = vi.fn();

    g._keydownHandler({ key: 'Escape', code: 'Escape', preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(g.pause).not.toHaveBeenCalled();
    expect(g.state).toBe('playing');
  });
});
