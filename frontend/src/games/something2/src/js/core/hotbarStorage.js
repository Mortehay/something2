// frontend/src/games/something2/src/js/core/hotbarStorage.js
// Client-side persistence for character skill hotbar assignments (slots 1-9).
// Stored per-character in localStorage: `something2.hotbar.${characterId}`

import { getSkillById, getSkillsForClass } from './skillsData.js';

export const HOTBAR_STORAGE_PREFIX = 'something2.hotbar.';
export const UNLOCKED_SKILLS_PREFIX = 'something2.unlocked_skills.';

function getStorage() {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

// In-memory fallback map keyed by characterId
const memoryStorage = new Map();

/**
 * Loads the set of learned/unlocked skill IDs for a character.
 * @param {string|number} characterId
 * @returns {Set<string>}
 */
export function loadUnlockedSkillsForCharacter(characterId) {
  const result = new Set();
  if (characterId == null) return result;

  const key = `${UNLOCKED_SKILLS_PREFIX}${characterId}`;
  let raw = memoryStorage.get(key) || null;

  const s = getStorage();
  if (!raw && s) {
    try {
      raw = s.getItem(key);
    } catch {
      raw = null;
    }
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string') result.add(id);
        }
        return result;
      }
    } catch {
      // JSON parse error
    }
  }

  return result;
}

/**
 * Persists an unlocked skill ID for a character.
 * @param {string|number} characterId
 * @param {string} skillId
 * @returns {Set<string>} Updated set of unlocked skill IDs
 */
export function unlockSkillForCharacter(characterId, skillId) {
  const set = loadUnlockedSkillsForCharacter(characterId);
  if (!skillId) return set;
  set.add(skillId);

  if (characterId == null) return set;
  const key = `${UNLOCKED_SKILLS_PREFIX}${characterId}`;
  const json = JSON.stringify(Array.from(set));
  memoryStorage.set(key, json);

  const s = getStorage();
  if (s) {
    try {
      s.setItem(key, json);
    } catch {
      // Quota exceeded
    }
  }

  return set;
}

/**
 * Checks whether a specific skill is unlocked for a character.
 * @param {string|number} characterId
 * @param {string} skillId
 * @returns {boolean}
 */
export function isSkillUnlocked(characterId, skillId) {
  if (!skillId) return false;
  const set = loadUnlockedSkillsForCharacter(characterId);
  return set.has(skillId);
}

/**
 * Returns default starter hotbar for a given character/class.
 * Returns an empty Map so players start with an unassigned skill bar.
 * @param {string} [className]
 * @returns {Map<number, object>} Map of slot (1..9) -> Skill object (initially empty)
 */
export function getDefaultHotbarForClass(className) {
  return new Map();
}

/**
 * Loads hotbar skill assignments for a specific character.
 * @param {string|number} characterId
 * @param {string} [className]
 * @returns {Map<number, object>}
 */
export function loadHotbarForCharacter(characterId, className = 'Warrior') {
  const result = new Map();
  if (characterId == null) {
    return getDefaultHotbarForClass(className);
  }

  const key = `${HOTBAR_STORAGE_PREFIX}${characterId}`;
  let raw = memoryStorage.get(key) || null;

  const s = getStorage();
  if (!raw && s) {
    try {
      raw = s.getItem(key);
    } catch {
      raw = null;
    }
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (let slot = 1; slot <= 9; slot++) {
          const skillId = parsed[slot] || parsed[String(slot)];
          if (skillId) {
            const skill = getSkillById(skillId);
            if (skill) {
              result.set(slot, skill);
            }
          }
        }
        return result;
      }
    } catch {
      // JSON parse error, fall back to default
    }
  }

  // If no saved hotbar exists yet for this character, initialize with empty defaults
  const defaults = getDefaultHotbarForClass(className);
  saveHotbarForCharacter(characterId, defaults);
  return defaults;
}

/**
 * Saves the current hotbar assignments for a character.
 * @param {string|number} characterId
 * @param {Map<number, object>} hotbarSkillsMap
 */
export function saveHotbarForCharacter(characterId, hotbarSkillsMap) {
  if (characterId == null) return;
  const key = `${HOTBAR_STORAGE_PREFIX}${characterId}`;

  const payload = {};
  if (hotbarSkillsMap && typeof hotbarSkillsMap.forEach === 'function') {
    hotbarSkillsMap.forEach((skill, slot) => {
      if (skill && skill.id && slot >= 1 && slot <= 9) {
        payload[slot] = skill.id;
      }
    });
  }

  const json = JSON.stringify(payload);
  memoryStorage.set(key, json);

  const s = getStorage();
  if (s) {
    try {
      s.setItem(key, json);
    } catch {
      // Quota exceeded or disabled storage
    }
  }
}
