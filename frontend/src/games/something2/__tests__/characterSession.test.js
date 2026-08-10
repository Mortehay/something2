import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACTIVE_CHARACTER_KEY, readActiveCharacterId, writeActiveCharacterId,
  clearActiveCharacterId, resolveActiveCharacter, slotsUsed, canCreate,
} from '../characterSession.js';

// vitest runs in a node environment here, so there is no real localStorage.
// characterSession must degrade to an in-memory store rather than throw -- the
// same shape net/auth.js uses for the token.
const store = new Map();
beforeEach(() => {
  store.clear();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  clearActiveCharacterId();
});

const CHARACTERS = [
  { id: 7, slot: 1, name: 'Gorm', className: 'Warrior', level: 4 },
  { id: 9, slot: 2, name: 'Sela', className: 'Mage', level: 1 },
];

describe('active character storage', () => {
  it('round-trips an id as a number', () => {
    writeActiveCharacterId(9);
    expect(readActiveCharacterId()).toBe(9);
  });

  it('uses the documented storage key', () => {
    writeActiveCharacterId(9);
    expect(store.get(ACTIVE_CHARACTER_KEY)).toBe('9');
  });

  it('reads null when nothing is stored', () => {
    expect(readActiveCharacterId()).toBe(null);
  });

  it('reads null for a non-numeric stored value rather than passing it on', () => {
    store.set(ACTIVE_CHARACTER_KEY, 'not-a-number');
    expect(readActiveCharacterId()).toBe(null);
  });

  it('clears', () => {
    writeActiveCharacterId(9);
    clearActiveCharacterId();
    expect(readActiveCharacterId()).toBe(null);
  });

  it('survives storage being unavailable', () => {
    // Private-mode quotas and sandboxed iframes make localStorage throw on
    // access. The in-memory mirror must keep the session working.
    globalThis.localStorage = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    };
    writeActiveCharacterId(4);
    expect(readActiveCharacterId()).toBe(4);
  });
});

describe('resolveActiveCharacter', () => {
  it('returns the matching character', () => {
    expect(resolveActiveCharacter(9, CHARACTERS).name).toBe('Sela');
  });

  it('returns null for an id that is not in the list', () => {
    // A character deleted from another device. This must land on the list, not
    // on a join the server will reject.
    expect(resolveActiveCharacter(999, CHARACTERS)).toBe(null);
  });

  it('returns null when nothing is stored', () => {
    expect(resolveActiveCharacter(null, CHARACTERS)).toBe(null);
  });

  it('returns null while the list is still loading', () => {
    // undefined means "not fetched yet" -- callers must treat that as a third
    // state, or the picker flashes for a frame before the canvas on reload.
    expect(resolveActiveCharacter(9, undefined)).toBe(null);
  });
});

describe('slot arithmetic', () => {
  it('counts characters, not the highest slot', () => {
    expect(slotsUsed([{ slot: 3 }, { slot: 8 }])).toBe(2);
  });

  it('allows creation below the cap', () => {
    expect(canCreate(CHARACTERS, 8)).toBe(true);
  });

  it('refuses creation at the cap', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ id: i, slot: i + 1 }));
    expect(canCreate(eight, 8)).toBe(false);
  });

  it('refuses creation while the list is unknown', () => {
    expect(canCreate(undefined, 8)).toBe(false);
  });
});
