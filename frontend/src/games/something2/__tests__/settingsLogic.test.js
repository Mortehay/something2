import { describe, it, expect } from 'vitest';
import {
  readChoice, writeChoice, autoLootToApply, keyFromEvent, mouseBinding, isLeftMouse, assignKeybind, unlistedActions,
} from '../settingsLogic.js';
import { DEFAULT_KEYBINDS } from '../src/js/core/Game.js';
import { KEYBIND_DEFINITIONS } from '../GameSettings.jsx';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
}

describe('saved choices', () => {
  it('reads true, false, and null for never chosen or junk', () => {
    expect(readChoice(memoryStorage({ k: '1' }), 'k')).toBe(true);
    expect(readChoice(memoryStorage({ k: '0' }), 'k')).toBe(false);
    expect(readChoice(memoryStorage(), 'k')).toBeNull();
    expect(readChoice(memoryStorage({ k: 'yes' }), 'k')).toBeNull();
    expect(readChoice(null, 'k')).toBeNull();
  });
  it('survives storage that throws', () => {
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readChoice(bad, 'k')).toBeNull();
    expect(() => writeChoice(bad, 'k', true)).not.toThrow();
  });
  it('writes what readChoice reads', () => {
    const s = memoryStorage();
    writeChoice(s, 'k', true);
    expect(readChoice(s, 'k')).toBe(true);
    writeChoice(s, 'k', false);
    expect(readChoice(s, 'k')).toBe(false);
  });
});

describe('autoLootToApply: auto-loot survives a change of location', () => {
  it('re-applies the choice when the new world starts with it off', () => {
    expect(autoLootToApply({ autoLoot: false }, true)).toBe(true);
  });
  it('turns it back off if that is what the player chose and the game says on', () => {
    expect(autoLootToApply({ autoLoot: true }, false)).toBe(false);
  });
  it('does nothing when the game already agrees', () => {
    expect(autoLootToApply({ autoLoot: true }, true)).toBeNull();
    expect(autoLootToApply({ autoLoot: false }, false)).toBeNull();
  });
  it('does nothing before the player ever chose, or while no world is up', () => {
    expect(autoLootToApply({ autoLoot: false }, null)).toBeNull();
    expect(autoLootToApply({ autoLoot: false }, undefined)).toBeNull();
    expect(autoLootToApply(null, true)).toBeNull();
  });
});

describe('keyFromEvent', () => {
  const ev = (key, code) => ({ key, code });
  it('takes letters from the physical key, so a Ukrainian layout binds the same key', () => {
    expect(keyFromEvent(ev('ш', 'KeyI'))).toBe('i');
    expect(keyFromEvent(ev('i', 'KeyI'))).toBe('i');
    expect(keyFromEvent(ev('I', 'KeyI'))).toBe('i');
    expect(keyFromEvent(ev('і', 'KeyS'))).toBe('s');
  });
  it('takes digits from the physical key (the top row and not the numpad)', () => {
    expect(keyFromEvent(ev('3', 'Digit3'))).toBe('3');
    expect(keyFromEvent(ev('!', 'Digit1'))).toBe('1');
    expect(keyFromEvent(ev('3', 'Numpad3'))).toBe('3');
  });
  it('names space, arrows, function keys and punctuation by what they read', () => {
    expect(keyFromEvent(ev(' ', 'Space'))).toBe('space');
    expect(keyFromEvent(ev('ArrowUp', 'ArrowUp'))).toBe('arrowup');
    expect(keyFromEvent(ev('F5', 'F5'))).toBe('f5');
    expect(keyFromEvent(ev('[', 'BracketLeft'))).toBe('[');
  });
  it('keeps waiting on a modifier alone (Shift is the sprint key) and on junk', () => {
    for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Dead', 'Process', 'Unidentified']) {
      expect(keyFromEvent(ev(k, 'x'))).toBeNull();
    }
    expect(keyFromEvent(ev('', ''))).toBeNull();
    expect(keyFromEvent(null)).toBeNull();
  });
});

describe('mouse buttons', () => {
  it('maps every button to its binding name', () => {
    expect([0, 1, 2, 3, 4, 7].map(mouseBinding)).toEqual(['mouse1', 'mouse3', 'mouse2', 'mouse4', 'mouse5', 'mouse8']);
  });
  it('recognises every spelling of the left button', () => {
    for (const n of ['mouse1', 'LMB', ' left ', 'Left Click']) expect(isLeftMouse(n)).toBe(true);
    for (const n of ['mouse2', 'rmb', 'e', '', null]) expect(isLeftMouse(n)).toBe(false);
  });
});

describe('assignKeybind', () => {
  const binds = { ...DEFAULT_KEYBINDS };
  it('puts the key on the action', () => {
    const r = assignKeybind(binds, 'inventory', 'o');
    expect(r.refused).toBeNull();
    expect(r.binds.inventory).toBe('o');
    expect(r.displaced).toEqual([]);
  });
  it('never mutates its input', () => {
    const copy = { ...binds };
    assignKeybind(binds, 'inventory', 'c');
    expect(binds).toEqual(copy);
  });
  it('takes a key from the action that had it and says so, instead of binding two actions to one key', () => {
    const r = assignKeybind(binds, 'inventory', 'c'); // C is the character sheet
    expect(r.binds.inventory).toBe('c');
    expect(r.binds.character).toBe('');
    expect(r.displaced).toEqual(['character']);
    expect(Object.values(r.binds).filter((v) => v === 'c')).toHaveLength(1);
  });
  it('compares case-insensitively and ignores padding', () => {
    const r = assignKeybind({ a: ' E ', b: 'x' }, 'b', 'e');
    expect(r.displaced).toEqual(['a']);
  });
  it('rebinding an action to its own key displaces nothing', () => {
    const r = assignKeybind(binds, 'inventory', 'i');
    expect(r.displaced).toEqual([]);
    expect(r.binds.inventory).toBe('i');
  });
  it('refuses the left mouse button for EVERY action, not only the hotbar', () => {
    for (const action of ['pickup', 'inventory', 'slot3', 'teleport']) {
      const r = assignKeybind(binds, action, 'mouse1');
      expect(r.refused).toBe('lmb');
      expect(r.binds).toEqual(binds);
    }
  });
  it('accepts the right and middle buttons and takes them from whoever had them', () => {
    const r = assignKeybind({ ...binds, bank: 'mouse2' }, 'pickup', 'mouse2');
    expect(r.refused).toBeNull();
    expect(r.displaced).toEqual(['bank']);
  });
  it('refuses an empty binding', () => {
    expect(assignKeybind(binds, 'pickup', '').refused).toBe('empty');
    expect(assignKeybind(binds, 'pickup', null).refused).toBe('empty');
  });
  it('an unbound action (empty string) is not a conflict for another empty binding', () => {
    const r = assignKeybind({ trade: '', pickup: 'g' }, 'pickup', 'h');
    expect(r.displaced).toEqual([]);
  });
});

describe('the panel lists every action that has a default key', () => {
  it('has a row for each default binding, so none is stuck where the player cannot move it', () => {
    expect(unlistedActions(DEFAULT_KEYBINDS, KEYBIND_DEFINITIONS)).toEqual([]);
  });
  it('includes the quest log and the achievements that were missing', () => {
    const keys = KEYBIND_DEFINITIONS.map((d) => d.key);
    expect(keys).toContain('questLog');
    expect(keys).toContain('achievements');
  });
  it('lists no action twice, and none the game does not know', () => {
    const keys = KEYBIND_DEFINITIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(Object.keys(DEFAULT_KEYBINDS)).toContain(k);
  });
  it('reports a gap when one exists', () => {
    expect(unlistedActions({ a: 1, b: 2 }, [{ key: 'a' }])).toEqual(['b']);
  });
});
