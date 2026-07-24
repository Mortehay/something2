import { describe, it, expect } from 'vitest';
import { autoJoinTarget, pickEntryWorld, worldAssetsReady } from '../autoJoin.js';

const TILES = { grass: { color: '#0f0' } };
const CONFIG = { tileTypes: TILES, entityTypes: { Wolf: { color: '#888' } } };
const WORLDS = [
  { id: 3, name: 'Overworld', is_entry: false },
  { id: 1, name: 'Overworld', is_entry: false },
  { id: 7, name: 'Caves', is_entry: true },
];

const base = {
  isAdmin: false, isPlaying: false, alreadyJoined: false, hasGame: true,
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
