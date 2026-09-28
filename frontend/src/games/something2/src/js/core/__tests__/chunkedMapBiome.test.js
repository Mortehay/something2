import { describe, it, expect } from 'vitest';
import { ChunkedMap } from '../ChunkedMap.js';
import { MAP_TILE_SIZE } from '../constants.js';

const size = 64;
const grid = Array.from({ length: size }, () => Array(size).fill('grass'));
const biomes = Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => (c < 4 ? 'forest' : 'desert')));

describe('ChunkedMap.biomeAt', () => {
  it('reads the chunk biome grid at the 8-tile cell under a world position', () => {
    const m = new ChunkedMap(size);
    m.setChunk(1, 0, grid, [], biomes);
    const x0 = 1 * size * MAP_TILE_SIZE;
    expect(m.biomeAt(x0 + 2 * MAP_TILE_SIZE, 5 * MAP_TILE_SIZE)).toBe('forest');   // tile col 2 -> cell 0
    expect(m.biomeAt(x0 + 40 * MAP_TILE_SIZE, 5 * MAP_TILE_SIZE)).toBe('desert');  // tile col 40 -> cell 5
  });
  // undefined = "don't know yet" (chunk not loaded), null = "loaded, this
  // world has no biome grid here" -- the audio engine needs to tell them apart
  // to fall back to world ambience in a biome-less world (SOMET-590 F6).
  it('is undefined for an unloaded or removed chunk, null for a loaded chunk without a grid', () => {
    const m = new ChunkedMap(size);
    expect(m.biomeAt(0, 0)).toBe(undefined);
    m.setChunk(0, 0, grid, []);
    expect(m.biomeAt(0, 0)).toBe(null);
    m.setChunk(0, 0, grid, [], biomes);
    m.removeChunk(0, 0);
    expect(m.biomeAt(0, 0)).toBe(undefined);
  });
  it('derives the cell step from grid.length instead of assuming 8 (32-tile chunk, 4x4 grid)', () => {
    const smallSize = 32;
    const smallGrid = Array.from({ length: smallSize }, () => Array(smallSize).fill('grass'));
    // 4x4 grid over a 32-tile chunk -> step = 8 tiles per cell.
    const smallBiomes = Array.from({ length: 4 }, (_, r) => Array.from({ length: 4 }, (_, c) => (c < 2 ? 'forest' : 'desert')));
    const m = new ChunkedMap(smallSize);
    m.setChunk(0, 0, smallGrid, [], smallBiomes);
    expect(m.biomeAt(2 * MAP_TILE_SIZE, 0)).toBe('forest');   // tile col 2 -> cell 0
    expect(m.biomeAt(20 * MAP_TILE_SIZE, 0)).toBe('desert');  // tile col 20 -> cell 2
  });
});
