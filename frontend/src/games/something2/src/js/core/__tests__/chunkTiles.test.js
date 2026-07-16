import { describe, it, expect } from "vitest";
import { chunkTileCells } from "../chunkTiles.js";
import { ChunkedMap } from "../ChunkedMap.js";
import { MAP_TILE_SIZE } from "../constants.js";

const N = 2;
const T = MAP_TILE_SIZE;

describe("chunkTileCells", () => {
  it("enumerates world-pixel tile centers for loaded chunks", () => {
    const m = new ChunkedMap(N);
    m.setChunk(0, 0, [["grass", "dirt"], ["water", "grass"]]); // grid[lr][lc]
    const cells = chunkTileCells(m);
    expect(cells.length).toBe(4);
    // local (lr=0,lc=0) -> world center (T/2, T/2), tile grid[0][0] = grass
    expect(cells).toContainEqual({ worldX: T / 2, worldY: T / 2, tile: "grass" });
    // local (lr=1,lc=0) -> (T/2, T + T/2), tile grid[1][0] = water
    expect(cells).toContainEqual({ worldX: T / 2, worldY: T + T / 2, tile: "water" });
  });

  it("offsets by chunk origin incl. negative chunks", () => {
    const m = new ChunkedMap(N);
    m.setChunk(-1, 0, [["a", "b"], ["c", "d"]]);
    const cells = chunkTileCells(m);
    // chunk (-1,0) origin.x = -1*N*T = -2T; local (0,0) center = -2T + T/2
    expect(cells).toContainEqual({ worldX: -2 * T + T / 2, worldY: T / 2, tile: "a" });
  });
});
