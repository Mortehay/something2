// The Loot Filter in a real Game: the hotkey, the window, saves, and what the server's echo may do.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Game } from '../Game.js';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.js';
import { activePreset, defaultFilterConfig, verdictFor } from '../lootFilter.js';

const realWindow = globalThis.window;
const realPerf = globalThis.performance;

function makeGame() {
  const g = new Game();
  g.state = 'playing';
  g.chunked = true;
  g.canvas = {
    addEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: GAME_WIDTH, height: GAME_HEIGHT }),
    width: GAME_WIDTH, height: GAME_HEIGHT,
  };
  g.sent = [];
  g.authorityClient = { sendLootFilter: (config) => { g.sent.push(config); return true; } };
  g.setupInput();
  return g;
}
const press = (g, key, extra = {}) => g._keydownHandler({ key, code: `Key${key.toUpperCase()}`, target: null, preventDefault() {}, ...extra });
const rules = (g) => activePreset(g.lootFilterState.config).rules;

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.window = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  globalThis.performance = { now: () => 1000 };
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.window = realWindow;
  globalThis.performance = realPerf;
});

describe('opening', () => {
  it('L toggles the window and Escape closes it', () => {
    const g = makeGame();
    press(g, 'l');
    expect(g.lootFilterOpen).toBe(true);
    press(g, 'l');
    expect(g.lootFilterOpen).toBe(false);
    press(g, 'l');
    press(g, 'Escape');
    expect(g.lootFilterOpen).toBe(false);
  });

  it('refuses to open over another window, and opening closes none silently', () => {
    const g = makeGame();
    g.questLogOpen = true;
    press(g, 'l');
    expect(g.lootFilterOpen).toBe(false);
  });

  it('while typing a name, L is a letter, not the hotkey', () => {
    const g = makeGame();
    press(g, 'l');
    g.lootUi.focus = 'preset';
    g.lootUi.draft = '';
    press(g, 'l');
    expect(g.lootFilterOpen).toBe(true);
    expect(g.lootUi.draft).toBe('l');
  });
});

describe('saving', () => {
  it('a burst of edits is ONE send, after the last one', () => {
    const g = makeGame();
    press(g, 'l');
    const base = g.lootFilterState.config;
    for (let i = 0; i < 5; i += 1) {
      g.saveLootFilter({ ...base, presets: [{ ...base.presets[0], name: `v${i}` }] });
      vi.advanceTimersByTime(100);
    }
    expect(g.sent).toHaveLength(0);
    vi.advanceTimersByTime(400);
    expect(g.sent).toHaveLength(1);
    expect(g.sent[0].presets[0].name).toBe('v4');
  });

  it('closing the window sends what is pending at once', () => {
    const g = makeGame();
    press(g, 'l');
    g.saveLootFilter({ ...g.lootFilterState.config, activeId: 'default' });
    press(g, 'l');
    expect(g.sent).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(g.sent).toHaveLength(1);
  });

  it('every edit bumps the version so ground items re-evaluate', () => {
    const g = makeGame();
    const v = g.lootFilterState.version;
    g.saveLootFilter(defaultFilterConfig());
    expect(g.lootFilterState.version).toBe(v + 1);
  });
});

describe('the server echo', () => {
  const server = (name) => ({ activeId: 'default', presets: [{ id: 'default', name, autolootSkipHidden: true, rules: [] }] });

  it('the joined frame installs the saved filter and the affix catalog', () => {
    const g = makeGame();
    g._setLootFilter(server('Saved'), [{ id: 1, key: 'of_might', label: 'of Might' }]);
    expect(activePreset(g.lootFilterState.config).name).toBe('Saved');
    expect(g.lootFilterState.affixes).toHaveLength(1);
  });

  it('an echo that arrives after the player edited again is dropped, not applied over the edit', () => {
    const g = makeGame();
    g.saveLootFilter(server('first'));
    vi.advanceTimersByTime(500); // sent
    g.saveLootFilter(server('second')); // edited again while the echo for 'first' is in flight
    g._setLootFilter(server('first')); // the (stale) echo
    expect(activePreset(g.lootFilterState.config).name).toBe('second');
    vi.advanceTimersByTime(500);
    g._setLootFilter(server('second')); // the echo of the latest
    expect(activePreset(g.lootFilterState.config).name).toBe('second');
  });

  it('with nothing pending the echo is applied (the server normalised it)', () => {
    const g = makeGame();
    g.saveLootFilter(server('mine'));
    vi.advanceTimersByTime(500);
    g._setLootFilter(server('mine, normalised'));
    expect(activePreset(g.lootFilterState.config).name).toBe('mine, normalised');
  });

  it('a malformed config is ignored', () => {
    const g = makeGame();
    const before = g.lootFilterState.config;
    g._setLootFilter({ presets: [] });
    g._setLootFilter('nope');
    expect(g.lootFilterState.config).toBe(before);
  });
});

describe('show-all key', () => {
  it('is a HOLD: true while the key is down, false after', () => {
    const g = makeGame();
    expect(g._lootShowAllHeld()).toBe(false);
    press(g, 'Alt');
    expect(g._lootShowAllHeld()).toBe(true);
    g._keyupHandler({ key: 'Alt', code: 'AltLeft', target: null });
    expect(g._lootShowAllHeld()).toBe(false);
  });
});

describe('drawing verdicts follow the filter', () => {
  const TYPES = new Map([[1, { category: 'weapon' }]]);
  const typeOf = (id) => TYPES.get(id) || null;

  it('hides a white item once a hide rule exists, shows it again when removed, and caches per version', () => {
    const g = makeGame();
    const item = { typeId: 1, rarity: 'white', itemLevel: 1, affixIds: [] };
    expect(verdictFor(item, g.lootFilterState, typeOf).hidden).toBe(false);
    const cfg = defaultFilterConfig();
    cfg.presets[0].rules = [{ id: 'a', name: 'a', enabled: true, action: 'hide', conditions: { rarities: ['white'], categories: [], typeIds: [], minLevel: null, maxLevel: null, affixIds: [], affixMode: 'any' }, style: {} }];
    g.saveLootFilter(cfg);
    expect(verdictFor(item, g.lootFilterState, typeOf).hidden).toBe(true);
    expect(rules(g)).toHaveLength(1);
    g.saveLootFilter(defaultFilterConfig());
    expect(verdictFor(item, g.lootFilterState, typeOf).hidden).toBe(false);
  });
});
