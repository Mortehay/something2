// frontend/src/games/something2/src/js/core/hotbarStorage.js
// Client-side persistence for character skill hotbar assignments (slots 1-9).
// Stored per-character in localStorage: `something2.hotbar.${characterId}`

import { getSkillById, getSkillsForClass } from './skillsData.js';

export const HOTBAR_STORAGE_PREFIX = 'something2.hotbar.';

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
 * Returns default starter active skills for a given class in slots 1, 2, 3.
 * @param {string} className
 * @returns {Map<number, object>} Map of slot (1..9) -> Skill object
 */
export function getDefaultHotbarForClass(className) {
  const result = new Map();
  const classSkills = getSkillsForClass(className || 'Warrior');
  if (!classSkills || classSkills.length === 0) return result;

  // Prefer first 3 active skills of the class
  const starterSkills = classSkills.slice(0, 3);
  starterSkills.forEach((skill, idx) => {
    result.set(idx + 1, skill);
  });

  return result;
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
        let count = 0;
        for (let slot = 1; slot <= 9; slot++) {
          const skillId = parsed[slot] || parsed[String(slot)];
          if (skillId) {
            const skill = getSkillById(skillId);
            if (skill) {
              result.set(slot, skill);
              count++;
            }
          }
        }
        if (count > 0) {
          return result;
        }
      }
    } catch {
      // JSON parse error, fall back to default
    }
  }

  // If no saved hotbar exists yet for this character, initialize with class defaults
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
