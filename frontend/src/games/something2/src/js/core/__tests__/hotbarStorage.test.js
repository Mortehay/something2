// frontend/src/games/something2/src/js/core/__tests__/hotbarStorage.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadHotbarForCharacter,
  saveHotbarForCharacter,
  getDefaultHotbarForClass,
  loadUnlockedSkillsForCharacter,
  unlockSkillForCharacter,
  isSkillUnlocked,
  HOTBAR_STORAGE_PREFIX,
  UNLOCKED_SKILLS_PREFIX,
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

  it('starts with 0 default skills on hotbar for a new character', () => {
    const warriorHotbar = getDefaultHotbarForClass('Warrior');
    expect(warriorHotbar.size).toBe(0);

    const mageHotbar = getDefaultHotbarForClass('Mage');
    expect(mageHotbar.size).toBe(0);
  });

  it('loads empty hotbar when character has no saved hotbar', () => {
    const hotbar = loadHotbarForCharacter(42, 'Druid');
    expect(hotbar.size).toBe(0);
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

  // SOMET-618: a hotbar saved before the plague_globule -> cul_plague_globule
  // rename (SOMET-571) still has the OLD bare id sitting in a real player's
  // localStorage. Writing it directly (bypassing saveHotbarForCharacter,
  // which would already persist the current id) reproduces that stale state.
  it('resolves a hotbar slot saved under the old plague_globule id to the renamed cul_plague_globule skill', () => {
    const key = `${HOTBAR_STORAGE_PREFIX}char-legacy`;
    globalThis.localStorage.setItem(key, JSON.stringify({ 7: 'plague_globule' }));

    const loaded = loadHotbarForCharacter('char-legacy', 'Cultist');
    expect(loaded.get(7)).toBeDefined();
    expect(loaded.get(7).id).toBe('cul_plague_globule');
  });

  it('resolves an "owned gem" unlocked under the old plague_globule id to the renamed skill', () => {
    const key = `${UNLOCKED_SKILLS_PREFIX}char-legacy-gem`;
    globalThis.localStorage.setItem(key, JSON.stringify(['plague_globule']));

    const unlocked = loadUnlockedSkillsForCharacter('char-legacy-gem');
    expect(unlocked.has('cul_plague_globule')).toBe(true);
    expect(unlocked.has('plague_globule')).toBe(false);
    expect(isSkillUnlocked('char-legacy-gem', 'cul_plague_globule')).toBe(true);
  });

  it('keeps the legacy id resolvable after a fresh unlock under the current id', () => {
    unlockSkillForCharacter('char-fresh-gem', 'cul_plague_globule');
    expect(isSkillUnlocked('char-fresh-gem', 'cul_plague_globule')).toBe(true);
  });
});
