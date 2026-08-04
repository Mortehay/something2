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

// D1 regression guard ("the sheet does not refresh after a successful
// allocation"): CharacterSheet.jsx's own state update was already correct --
// the actual bug was that Game's CACHE (this.progression/this.gold, the very
// thing getProgressionSnapshot reads) never learned about an HTTP-only
// allocate/respec, so the next live-poll tick echoed the stale pre-mutation
// row straight back over the sheet's freshly-set state. applyProgressionResult
// is the write-through fix; this proves it actually closes that loop by
// calling it and then reading the snapshot back, the same two calls
// CharacterSheet.jsx and its poll effect make in sequence.
function callApply(state, result) {
  return Game.prototype.applyProgressionResult.call(state, result);
}

describe('applyProgressionResult (D1 fix: keep Game.progression/gold in sync with an HTTP-only mutation)', () => {
  it('a call with no progression/gold does nothing (no-arg call)', () => {
    const state = { progression: { level: 1, constitution: 5 }, gold: 10 };
    callApply(state, undefined);
    expect(state.progression).toEqual({ level: 1, constitution: 5 });
    expect(state.gold).toBe(10);
  });

  it('updates this.progression from an allocate response', () => {
    const state = { progression: { level: 1, constitution: 5, stat_points: 6 }, gold: 10 };
    callApply(state, { progression: { level: 1, constitution: 8, stat_points: 3 } });
    expect(state.progression).toEqual({ level: 1, constitution: 8, stat_points: 3 });
  });

  it('updates both this.progression and this.gold from a respec response', () => {
    const state = { progression: { level: 1, constitution: 8 }, gold: 10 };
    callApply(state, { progression: { level: 1, constitution: 5 }, gold: 0 });
    expect(state.progression).toEqual({ level: 1, constitution: 5 });
    expect(state.gold).toBe(0); // 0 is a legitimate balance, not "missing" -- must not be skipped
  });

  // The actual end-to-end regression: after the write-through, the very poll
  // read (getProgressionSnapshot) that used to hand the sheet a stale row
  // now reflects the mutation immediately -- no reconnect, no extra HTTP call.
  it('getProgressionSnapshot reflects the mutation immediately after applyProgressionResult', () => {
    const state = { state: 'playing', chunked: true, progression: { level: 1, constitution: 5, stat_points: 6 }, gold: 10 };
    callApply(state, { progression: { level: 1, constitution: 8, stat_points: 3 }, gold: 10 });
    expect(callSnapshot(state)).toEqual({ progression: { level: 1, constitution: 8, stat_points: 3 }, gold: 10 });
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
