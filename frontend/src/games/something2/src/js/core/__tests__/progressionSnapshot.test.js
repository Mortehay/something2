// SOMET-242 Task 10: Game.getProgressionSnapshot() is the character sheet's
// read-only window into the live progression row (see getMinimapSnapshot.js's
// sibling test for the pattern this borrows -- calling the method against a
// hand-built `this` avoids constructing the full Game, which needs a
// canvas/DOM).
import { describe, it, expect } from 'vitest';
import { Game } from '../Game.js';

function callSnapshot(state) {
  return Game.prototype.getProgressionSnapshot.call(state);
}

describe('getProgressionSnapshot', () => {
  it('returns null when not in a playing chunked world', () => {
    expect(callSnapshot({ state: 'menu', chunked: false, progression: { level: 3 } })).toBeNull();
  });

  it('returns null when playing but no progression has joined yet', () => {
    expect(callSnapshot({ state: 'playing', chunked: true, progression: null, gold: 0 })).toBeNull();
  });

  it('reports the current progression row and gold once joined', () => {
    const progression = { level: 3, experience: 450, stat_points: 2, strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 };
    const snap = callSnapshot({ state: 'playing', chunked: true, progression, gold: 120 });
    expect(snap).toEqual({ progression, gold: 120 });
  });
});

// The onJoined/onProgression wiring itself (Game.js's WorldAuthorityClient
// config) is exercised end-to-end by setupInput-adjacent tests elsewhere
// (authorityDisconnect.test.js, debugKeyRepeat.test.js) using the same
// minimal window/canvas stub; this file only needs to prove the snapshot
// method's own contract, which is what CharacterSheet.jsx actually reads.
describe('Game constructor / re-join reset', () => {
  it('starts with progression null', () => {
    const originalWindow = globalThis.window;
    globalThis.window = undefined;
    try {
      const g = new Game();
      expect(g.progression).toBeNull();
    } finally {
      globalThis.window = originalWindow;
    }
  });
});
