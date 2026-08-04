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

// D1 (Task 10's first browser pass) fixed "the sheet does not refresh after
// a successful allocation" by write-through-caching BOTH progression and
// gold from an HTTP allocate/respec response into Game's cache
// (applyProgressionResult). A LATER browser pass (F1) found that write-
// through racy: the HTTP response travels on its own connection with no
// ordering guarantee relative to a concurrent kill/death websocket push, so
// a late, stale allocate response could overwrite a NEWER push's level-up.
//
// Fixed by removing progression from the write-through entirely --
// Game.applyGoldResult (renamed, narrowed) now touches ONLY gold. Nothing an
// HTTP response carries can ever clobber this.progression again; the only
// remaining writer is the websocket 'progression' handler wired into
// initChunked (onProgression, an unconditional `this.progression =
// msg.progression`), which is on a single ordered connection and therefore
// cannot itself be raced by anything on that same connection.
function callApplyGold(state, gold) {
  return Game.prototype.applyGoldResult.call(state, gold);
}

describe('applyGoldResult (F1: narrowed from applyProgressionResult -- gold only, progression untouched)', () => {
  it('a non-number leaves gold untouched (defensive no-op, mirrors the old no-arg case)', () => {
    const state = { progression: { level: 1, constitution: 5 }, gold: 10 };
    callApplyGold(state, undefined);
    expect(state.progression).toEqual({ level: 1, constitution: 5 });
    expect(state.gold).toBe(10);
  });

  it('updates this.gold from a respec response\'s gold field', () => {
    const state = { progression: { level: 1, constitution: 8 }, gold: 10 };
    callApplyGold(state, 0);
    expect(state.gold).toBe(0); // 0 is a legitimate balance, not "missing" -- must not be skipped
  });

  it('never touches this.progression, no matter what', () => {
    const state = { progression: { level: 1, constitution: 8, stat_points: 3 }, gold: 10 };
    callApplyGold(state, 999);
    expect(state.progression).toEqual({ level: 1, constitution: 8, stat_points: 3 }); // byte-identical, untouched
  });
});

// F1 regression guard, literal values, the reviewer's own reproduction:
// "the player clicks +CON; the server commits; before the response returns,
// their in-flight arrow kills a creature, awardXp levels them to 2 and
// pushes a progression frame that arrives first. The late allocate response
// then overwrites Game.progression with the pre-kill {level 1} snapshot."
//
// This is a PURE ordering test: apply the newer push first (exactly what
// Game's onProgression handler does -- an unconditional assignment,
// reproduced inline here since that handler is a closure inside initChunked,
// not a prototype method, and is already covered end-to-end by
// WorldAuthorityClient.test.js's "a progression message invokes
// onProgression" case), then apply what USED TO BE the vulnerable
// HTTP-response write-through path, and assert the newer state survived.
describe('F1: a newer websocket push is not clobbered by a later HTTP-response-shaped call', () => {
  it('the level-2 push survives; the late level-1 allocate response never gets a chance to apply', () => {
    const state = { progression: { level: 1, experience: 200, stat_points: 0 }, gold: 50 };

    // The kill's XP push arrives first: Game.onProgression's own logic.
    state.progression = { level: 2, experience: 250, stat_points: 3 };

    // The late, stale allocate HTTP response "arrives" after it. Before F1,
    // this would have been `applyProgressionResult({ progression: { level: 1,
    // experience: 200, stat_points: 0 }, gold: 999 })`, silently reverting
    // state.progression to the pre-kill snapshot. applyGoldResult is the
    // only remaining thing an HTTP response can still reach, and it no
    // longer has a `progression` parameter to do that with at all.
    callApplyGold(state, 999);

    expect(state.progression).toEqual({ level: 2, experience: 250, stat_points: 3 });
    expect(state.gold).toBe(999); // gold is still applied -- untouched by this fix, see the module header
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
