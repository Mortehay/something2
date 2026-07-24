import { describe, it, expect } from 'vitest';
import { Game } from '../Game.js';

// Call the method against a hand-built `this` to avoid constructing the full
// Game (which needs a canvas/DOM). This tests the snapshot logic in isolation.
function callSnapshot(state) {
  return Game.prototype.getMinimapSnapshot.call(state);
}

describe('getMinimapSnapshot', () => {
  it('returns null when not in a playing chunked world', () => {
    expect(callSnapshot({ state: 'menu', chunked: false })).toBeNull();
  });

  it('reports player center, worldId, chunkSize, and creatures', () => {
    const snap = callSnapshot({
      state: 'playing', chunked: true, worldId: 'w1',
      chunkedMap: { chunkSize: 64 },
      player: { x: 100, y: 200, width: 64, height: 64 },
      keys: {},
      creatures: { all: () => [{ x: 10, y: 20, color: '#f00' }] },
    });
    expect(snap.worldId).toBe('w1');
    expect(snap.chunkSize).toBe(64);
    expect(snap.player.x).toBe(132); // 100 + 64/2
    expect(snap.player.y).toBe(232);
    expect(snap.creatures).toEqual([{ x: 10, y: 20, color: '#f00' }]);
  });

  it('derives facing from held movement keys', () => {
    const snap = callSnapshot({
      state: 'playing', chunked: true, worldId: 'w1',
      chunkedMap: { chunkSize: 64 },
      player: { x: 0, y: 0, width: 0, height: 0 },
      keys: { d: true },              // moving east
      creatures: { all: () => [] },
    });
    expect(snap.player.dir.dx).toBeGreaterThan(0);
    expect(snap.player.dir.dy).toBe(0);
  });
});
