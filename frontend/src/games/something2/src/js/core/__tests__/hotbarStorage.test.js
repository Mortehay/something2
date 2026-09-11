// frontend/src/games/something2/src/js/core/__tests__/hotbarStorage.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadHotbarForCharacter,
  saveHotbarForCharacter,
  getDefaultHotbarForClass,
  HOTBAR_STORAGE_PREFIX,
} from '../hotbarStorage.js';
import { getSkillById } from '../skillsData.js';

describe('Hotbar Storage and Persistence', () => {
  let fakeStorage;

  beforeEach(() => {
    fakeStorage = {};
    globalThis.localStorage = {
      getItem: (k) => fakeStorage[k] || null,
      setItem: (k, v) => { fakeStorage[k] = String(v); },
      removeItem: (k) => { delete fakeStorage[k]; },
      clear: () => { fakeStorage = {}; },
    };
  });

  it('provides empty default starter hotbar for classes', () => {
    const warriorHotbar = getDefaultHotbarForClass('Warrior');
    expect(warriorHotbar.size).toBe(0);

    const mageHotbar = getDefaultHotbarForClass('Mage');
    expect(mageHotbar.size).toBe(0);
  });

  it('loads empty default class hotbar when character has no saved hotbar', () => {
    const hotbar = loadHotbarForCharacter(42, 'Druid');
    expect(hotbar.size).toBe(0);
    // And it automatically saves it to storage
    expect(fakeStorage[`${HOTBAR_STORAGE_PREFIX}42`]).toBeDefined();
  });

  it('persists and restores custom assigned skills across sessions for specific character', () => {
    const customMap = new Map();
    customMap.set(1, getSkillById('war_skull_splitter'));
    customMap.set(5, getSkillById('war_whirlwind'));

    saveHotbarForCharacter(101, customMap);

    const loaded = loadHotbarForCharacter(101, 'Warrior');
    expect(loaded.get(1).id).toBe('war_skull_splitter');
    expect(loaded.get(5).id).toBe('war_whirlwind');
    expect(loaded.get(2)).toBeUndefined();
  });

  it('keeps hotbars isolated between different characters', () => {
    const char1Map = new Map([[1, getSkillById('mag_fireball')]]);
    const char2Map = new Map([[1, getSkillById('arc_fan_of_knives')]]);

    saveHotbarForCharacter('char-1', char1Map);
    saveHotbarForCharacter('char-2', char2Map);

    const load1 = loadHotbarForCharacter('char-1', 'Mage');
    const load2 = loadHotbarForCharacter('char-2', 'Archer');

    expect(load1.get(1).id).toBe('mag_fireball');
    expect(load2.get(1).id).toBe('arc_fan_of_knives');
  });
});
