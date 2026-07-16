import { describe, it, expect } from "vitest";
import { ChunkedMap } from "../ChunkedMap.js";
import { MAP_TILE_SIZE } from "../constants.js";

const N = 4;
const T = MAP_TILE_SIZE;
const CHUNK_PX = N * T;

// A distinct 4x4 grid so we can tell cells apart. grid[lr][lc].
function grid(fill) {
  return Array.from({ length: N }, (_, r) =>
    Array.from({ length: N }, (_, c) => `${fill}-${r}${c}`));
}

const TILE_DEFS = {
  grass: { walkable: true, speed: 1 },
  water: { walkable: false, speed: 1 },
  mud: { walkable: true, speed: 0.5 },
};

describe("ChunkedMap storage", () => {
  it("stores and reports loaded chunks incl. negatives", () => {
    const m = new ChunkedMap(N);
    m.setChunk(0, 0, grid("a"));
    m.setChunk(-1, 2, grid("b"));
    expect(m.hasChunk(0, 0)).toBe(true);
    expect(m.hasChunk(-1, 2)).toBe(true);
    expect(m.hasChunk(5, 5)).toBe(false);
    expect(m.loadedKeys().sort()).toEqual(["-1,2", "0,0"]);
    m.removeChunk(0, 0);
    expect(m.hasChunk(0, 0)).toBe(false);
  });
});

describe("ChunkedMap.getTileAt across a neighborhood", () => {
  it("resolves cells in the correct chunk and local position", () => {
    const m = new ChunkedMap(N);
    m.setChunk(0, 0, grid("A"));
    m.setChunk(1, 0, grid("B"));
    // (0,0) px -> chunk 0, local (0,0)
    expect(m.getTileAt(0, 0)).toBe("A-00");
    // last column of chunk 0 -> local (0, N-1)
    expect(m.getTileAt(CHUNK_PX - 1, 0)).toBe(`A-0${N - 1}`);
    // first column of chunk 1 -> chunk 1, local (0,0)
    expect(m.getTileAt(CHUNK_PX, 0)).toBe("B-00");
  });

  it("returns null for an unloaded chunk", () => {
    const m = new ChunkedMap(N);
    m.setChunk(0, 0, grid("A"));
    expect(m.getTileAt(CHUNK_PX + 10, 0)).toBe(null); // chunk (1,0) not loaded
  });

  it("resolves negative-coordinate chunks", () => {
    const m = new ChunkedMap(N);
    m.setChunk(-1, -1, grid("Z"));
    // (-1,-1) px -> chunk (-1,-1), local (N-1, N-1)
    expect(m.getTileAt(-1, -1)).toBe(`Z-${N - 1}${N - 1}`);
  });
});

describe("ChunkedMap.isWalkable / speedAt", () => {
  it("uses tile defs; unloaded is blocked", () => {
    const m = new ChunkedMap(N, TILE_DEFS);
    m.setChunk(0, 0, [
      ["grass", "water", "mud", "grass"],
      ["grass", "grass", "grass", "grass"],
      ["grass", "grass", "grass", "grass"],
      ["grass", "grass", "grass", "grass"],
    ]);
    expect(m.isWalkable(0, 0)).toBe(true);            // grass
    expect(m.isWalkable(T, 0)).toBe(false);           // water at local (0,1)
    expect(m.speedAt(2 * T, 0)).toBe(0.5);            // mud at local (0,2)
    expect(m.speedAt(0, 0)).toBe(1);                  // grass
    expect(m.isWalkable(CHUNK_PX, 0)).toBe(false);    // unloaded chunk -> blocked
    expect(m.speedAt(CHUNK_PX, 0)).toBe(1);           // unknown -> default speed 1
  });

  it("accepts an array-shaped mapTiles table too", () => {
    const arr = [{ name: "grass", walkable: true, speed: 1 }, { name: "water", walkable: false, speed: 1 }];
    const m = new ChunkedMap(N, arr);
    m.setChunk(0, 0, [["water", "grass", "grass", "grass"], ...Array.from({ length: N - 1 }, () => Array(N).fill("grass"))]);
    expect(m.isWalkable(0, 0)).toBe(false); // water via array lookup
    expect(m.isWalkable(T, 0)).toBe(true);  // grass
  });
});
