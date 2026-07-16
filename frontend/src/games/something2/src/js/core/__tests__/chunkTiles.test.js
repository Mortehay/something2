import { describe, it, expect } from "vitest";
import { chunkTileCells, chunkVisible } from "../chunkTiles.js";
import { ChunkedMap } from "../ChunkedMap.js";
import { MAP_TILE_SIZE, GAME_WIDTH, GAME_HEIGHT } from "../constants.js";
import { worldToScreen } from "../iso.js";
import { chunkOrigin } from "../worldCoords.js";

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

describe("chunkVisible", () => {
  const CS = 4;

  function cameraOnChunk(cx, cy) {
    const origin = chunkOrigin(cx, cy, CS);
    const center = { x: origin.x + (CS * T) / 2, y: origin.y + (CS * T) / 2 };
    const s = worldToScreen(center.x, center.y);
    return { screenX: s.x, screenY: s.y, width: GAME_WIDTH, height: GAME_HEIGHT };
  }

  it("returns true for a chunk under the camera", () => {
    const camera = cameraOnChunk(0, 0);
    expect(chunkVisible(0, 0, CS, camera)).toBe(true);
  });

  it("returns false for a chunk many chunks away from the camera", () => {
    const camera = cameraOnChunk(0, 0);
    expect(chunkVisible(50, 50, CS, camera)).toBe(false);
  });
});

describe("chunkTileCells with camera culling", () => {
  it("excludes far loaded chunks and includes the near one when a camera is given", () => {
    const m = new ChunkedMap(N);
    m.setChunk(0, 0, [["grass", "dirt"], ["water", "grass"]]);
    m.setChunk(50, 50, [["sand", "sand"], ["sand", "sand"]]);

    const origin = chunkOrigin(0, 0, N);
    const center = { x: origin.x + (N * T) / 2, y: origin.y + (N * T) / 2 };
    const s = worldToScreen(center.x, center.y);
    const camera = { screenX: s.x, screenY: s.y, width: GAME_WIDTH, height: GAME_HEIGHT };

    const culled = chunkTileCells(m, camera);
    expect(culled).toContainEqual({ worldX: T / 2, worldY: T / 2, tile: "grass" });
    expect(culled.some((c) => c.tile === "sand")).toBe(false);

    const uncalled = chunkTileCells(m);
    expect(uncalled.some((c) => c.tile === "sand")).toBe(true);
    expect(uncalled.length).toBe(8);
  });
});
