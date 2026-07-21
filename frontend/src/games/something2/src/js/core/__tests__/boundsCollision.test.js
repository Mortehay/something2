import { describe, it, expect } from 'vitest';
import { ChunkedMap } from '../ChunkedMap.js';
import { MAP_TILE_SIZE } from '../constants.js';

const TILES = {
  grass: { color: '#0f0', walkable: true, speed: 1 },
  map_wall: { color: '#2b2b2b', walkable: false, speed: 1 },
  map_doorway: { color: '#6b4f2a', walkable: true, speed: 1 },
};

describe('bounded-world wall collision (client)', () => {
  it('treats map_wall as non-walkable and map_doorway/grass as walkable', () => {
    const chunkSize = 4;
    const cm = new ChunkedMap(chunkSize, TILES);

    // A 4x4 chunk (0,0): row 0 all wall except a doorway at col 2; interior grass.
    const grid = [
      ['map_wall', 'map_wall', 'map_doorway', 'map_wall'],
      ['map_wall', 'grass', 'grass', 'map_wall'],
      ['map_wall', 'grass', 'grass', 'map_wall'],
      ['map_wall', 'map_wall', 'map_wall', 'map_wall'],
    ];
    cm.setChunk(0, 0, grid);

    const T = MAP_TILE_SIZE;
    const worldCenterAt = (col, row) => ({
      x: col * T + T / 2,
      y: row * T + T / 2
    });

    // Test wall is non-walkable
    const wallCenter = worldCenterAt(0, 0);
    expect(cm.isWalkable(wallCenter.x, wallCenter.y)).toBe(false);

    // Test doorway is walkable
    const doorwayCenter = worldCenterAt(2, 0);
    expect(cm.isWalkable(doorwayCenter.x, doorwayCenter.y)).toBe(true);

    // Test interior grass is walkable
    const grassCenter = worldCenterAt(1, 1);
    expect(cm.isWalkable(grassCenter.x, grassCenter.y)).toBe(true);
  });
});
