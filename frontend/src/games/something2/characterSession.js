// Which character this browser is playing, and the pure rules around it.
//
// Separate from the components for the same reason autoJoin.js is separate:
// vitest runs in a node environment in this project, so nothing under
// games/something2 can be rendered in a test. The branching lives here, where
// it can actually be asserted.

export const ACTIVE_CHARACTER_KEY = "something2.activeCharacterId";

// Mirrors net/auth.js's approach: an in-memory copy so a session keeps working
// where localStorage is unavailable (private-mode quotas, sandboxed iframes),
// with storage as the source of truth across a reload.
let memoryId = null;

function storage() {
  try {
    return typeof globalThis !== "undefined" && globalThis.localStorage
      ? globalThis.localStorage
      : null;
  } catch {
    // Accessing localStorage can itself throw, not just using it.
    return null;
  }
}

export function readActiveCharacterId() {
  const s = storage();
  let raw = memoryId;
  if (raw == null && s) {
    try { raw = s.getItem(ACTIVE_CHARACTER_KEY); } catch { raw = null; }
  }
  if (raw == null) return null;
  const id = Number(raw);
  // A non-numeric stored value is corruption, not an id. Returning it would
  // send garbage to the server as a character_id.
  if (!Number.isInteger(id)) return null;
  memoryId = id;
  return id;
}

export function writeActiveCharacterId(id) {
  memoryId = Number(id);
  const s = storage();
  if (s) {
    try { s.setItem(ACTIVE_CHARACTER_KEY, String(id)); } catch { /* memory still holds it */ }
  }
}

export function clearActiveCharacterId() {
  memoryId = null;
  const s = storage();
  if (s) {
    try { s.removeItem(ACTIVE_CHARACTER_KEY); } catch { /* best-effort */ }
  }
}

// The stored id resolved against the account's real characters, or null.
//
// Returning null for an id that is not in the list is the important case: a
// character deleted from another device leaves a stored id that would otherwise
// produce a join the server rejects, surfacing as an error the player has to
// dismiss instead of simply landing on the picker.
//
// `characters` undefined means the list has not loaded yet. That is a THIRD
// state, not "no character": treating it as "no character" flashes the picker
// for a frame before the canvas on every reload.
export function resolveActiveCharacter(storedId, characters) {
  if (!Array.isArray(characters)) return null;
  if (storedId == null) return null;
  return characters.find((c) => c.id === storedId) || null;
}

export function slotsUsed(characters) {
  return Array.isArray(characters) ? characters.length : 0;
}

// Deliberately false while the list is unknown: enabling Create before the
// count is known lets a player at 8/8 fire a request that can only 409.
export function canCreate(characters, maxCharacters) {
  if (!Array.isArray(characters)) return false;
  return characters.length < maxCharacters;
}
