import { describe, it, expect } from 'vitest';
import { autoJoinTarget, pickEntryWorld, worldAssetsReady } from '../autoJoin.js';

const TILES = { grass: { color: '#0f0' } };
const CONFIG = { tileTypes: TILES, entityTypes: { Wolf: { color: '#888' } } };
const WORLDS = [
  { id: 3, name: 'Overworld', is_entry: false },
  { id: 1, name: 'Overworld', is_entry: false },
  { id: 7, name: 'Caves', is_entry: true },
];

// hasCharacter is required as of SOMET-262: the authority refuses a join with
// no character, so the ready baseline has to include one. The "refuses without
// a character" case lives in characterGating.test.js alongside the rest of the
// character wiring.
// isGameRoute is required as of SOMET-271. It used to be enforced by accident
// -- the Game instance was only created on the game route, so `hasGame` was
// false everywhere else -- and the baseline has to state it now that the rule
// is explicit. The route cases are asserted in their own describe below.
const base = {
  isAdmin: false, isPlaying: false, alreadyJoined: false, hasGame: true,
  hasCharacter: true, isGameRoute: true,
  worlds: WORLDS, mapTiles: TILES, mapConfig: CONFIG,
};

describe('pickEntryWorld', () => {
  it('prefers the is_entry world over any Overworld', () => {
    expect(pickEntryWorld(WORLDS).id).toBe(7);
  });

  it('falls back to the lowest-id Overworld when nothing is flagged', () => {
    const unflagged = WORLDS.filter(w => !w.is_entry);
    expect(pickEntryWorld(unflagged).id).toBe(1);
  });

  it('returns null when no world qualifies', () => {
    expect(pickEntryWorld([{ id: 2, name: 'Arena', is_entry: false }])).toBeNull();
    expect(pickEntryWorld([])).toBeNull();
    expect(pickEntryWorld(undefined)).toBeNull();
  });
});

describe('worldAssetsReady', () => {
  it('needs both the tile list and the map config', () => {
    expect(worldAssetsReady(TILES, CONFIG)).toBe(true);
    expect(worldAssetsReady(undefined, CONFIG)).toBe(false);
    expect(worldAssetsReady(TILES, undefined)).toBe(false);
  });
});

describe('autoJoinTarget', () => {
  it('joins the entry world once everything is loaded', () => {
    expect(autoJoinTarget(base)).toBe(7);
  });

  // The regression this exists for: /api/worlds and /api/map/config race, and
  // the world list is the smaller response. Joining on `worlds` alone hands
  // initChunked a null entityTypes, which CreatureManager and preloadSprites
  // keep for the whole session — every creature stays a colored box.
  it('waits when the map config has not arrived yet', () => {
    expect(autoJoinTarget({ ...base, mapConfig: undefined })).toBeNull();
  });

  it('waits when the tile types have not arrived yet', () => {
    expect(autoJoinTarget({ ...base, mapTiles: undefined })).toBeNull();
  });

  it('does not re-join, hijack an admin, or fire without a Game', () => {
    expect(autoJoinTarget({ ...base, alreadyJoined: true })).toBeNull();
    expect(autoJoinTarget({ ...base, isPlaying: true })).toBeNull();
    expect(autoJoinTarget({ ...base, isAdmin: true })).toBeNull();
    expect(autoJoinTarget({ ...base, hasGame: false })).toBeNull();
  });

  it('stays null while the world list is still empty', () => {
    expect(autoJoinTarget({ ...base, worlds: [] })).toBeNull();
  });
});

// The epic's headline requirement is "log in at the point where you logged
// out", and the WORLD is half of that point. Before this, auto-join always
// targeted the is_entry world, so a character that logged out in Caves was
// restored to its last position inside Overworld instead -- right coordinates,
// wrong world.
describe('autoJoinTarget resumes the last world', () => {
  it('prefers the character last world over the entry world', () => {
    // 3 is not the entry world (7 is), so this fails against the old code.
    expect(autoJoinTarget({ ...base, lastWorldId: 3 })).toBe(3);
  });

  it('falls back to the entry world for a character that has never played', () => {
    expect(autoJoinTarget({ ...base, lastWorldId: null })).toBe(7);
    expect(autoJoinTarget({ ...base, lastWorldId: undefined })).toBe(7);
  });

  it('falls back when the last world no longer exists', () => {
    // Deleted from another session since this character last played. Joining it
    // would be a guaranteed server refusal, and a refused join never sends
    // 'joined' -- the client would sit there forever rather than error.
    expect(autoJoinTarget({ ...base, lastWorldId: 999 })).toBe(7);
  });

  it('still respects every other gate', () => {
    // A last world must not become a way around the readiness rules.
    expect(autoJoinTarget({ ...base, lastWorldId: 3, isAdmin: true })).toBeNull();
    expect(autoJoinTarget({ ...base, lastWorldId: 3, hasCharacter: false })).toBeNull();
    expect(autoJoinTarget({ ...base, lastWorldId: 3, mapConfig: undefined })).toBeNull();
    expect(autoJoinTarget({ ...base, lastWorldId: 3, alreadyJoined: true })).toBeNull();
  });
});

describe('auto-join only fires on the game route', () => {
  // SOMET-271. The Game instance is no longer created only on /game (a direct
  // load of /game/map left it null forever, which silently broke the World
  // Map's click-to-travel), so `hasGame` no longer doubles as a route check and
  // this rule has to be its own.
  it('refuses off the game route even when everything else is ready', () => {
    expect(autoJoinTarget({ ...base, isGameRoute: false })).toBeNull();
    // The converse, so this cannot pass by refusing everything.
    expect(autoJoinTarget({ ...base, isGameRoute: true })).toBe(7);
  });

  it('refuses when the flag is not supplied at all', () => {
    // The call site has to pass it. An absent flag reads as "not on the game
    // route" rather than as "unknown, proceed anyway" -- the failure mode this
    // project keeps hitting is a guard whose input is never wired, which
    // arrives undefined and silently permits.
    const { isGameRoute, ...withoutFlag } = base;
    expect(autoJoinTarget(withoutFlag)).toBeNull();
  });

  it('does not resume the last world off the game route either', () => {
    // The specific live bug: reading the World Map, auto-join fired anyway and
    // raced a travel click -- the character entered Old Trailhead and was
    // dragged back to its stale lastWorldId nine seconds later.
    expect(autoJoinTarget({ ...base, isGameRoute: false, lastWorldId: 3 })).toBeNull();
  });
});
