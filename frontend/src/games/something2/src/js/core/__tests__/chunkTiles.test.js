import { describe, it, expect } from "vitest";
import { chunkTileCells, chunkVisible, visibleTileRange } from "../chunkTiles.js";
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

// F-029/SOMET-209: chunkTileCells used to enumerate and project every cell of
// every chunk-visible chunk (only culled at whole-chunk granularity), then
// threw most of them away at RenderSystem's per-tile relX/relY check -- up to
// 9*64*64 = 36864 candidates/frame at the backend's default chunk_size of 64
// and the streamer's radius-1 neighborhood. visibleTileRange narrows the
// per-chunk row/col range from the camera directly, so only a small candidate
// set around the actual viewport gets enumerated and projected at all.
describe("visibleTileRange", () => {
  const CS = 64;

  it("narrows a large chunk's range to well under the full grid for a camera covering only part of it", () => {
    // Camera viewport (2*width x 2*height, the same generous margin
    // chunkVisible/RenderSystem use) is far smaller than the chunk's full
    // world-pixel span (64*100 = 6400), so the candidate range should shrink.
    const camera = { screenX: 0, screenY: 0, width: 300, height: 200 };
    const range = visibleTileRange(0, 0, CS, camera);
    const rows = range.lrEnd - range.lrStart + 1;
    const cols = range.lcEnd - range.lcStart + 1;
    expect(rows * cols).toBeLessThan(CS * CS);
    // Sanity: still a valid, non-empty, in-bounds range.
    expect(range.lrStart).toBeGreaterThanOrEqual(0);
    expect(range.lcStart).toBeGreaterThanOrEqual(0);
    expect(range.lrEnd).toBeLessThanOrEqual(CS - 1);
    expect(range.lcEnd).toBeLessThanOrEqual(CS - 1);
  });

  it("covers the whole chunk when the camera's generous margins exceed the chunk's world extent", () => {
    // A small chunk (8 tiles/side, 800 world-pixel span) well inside the real
    // game's generous camera margins (GAME_WIDTH/HEIGHT) -- unlike the
    // 64-tile chunk above (6400 world-pixel span), which those SAME margins
    // do NOT fully cover once inverse-projected (the 45° rotation means a
    // screen-space margin does not map to an equally generous world-space
    // one) -- exactly why tile-level culling still pays off even at
    // chunk_size 64 with these margins.
    const smallCS = 8;
    const origin = chunkOrigin(0, 0, smallCS);
    const center = { x: origin.x + (smallCS * MAP_TILE_SIZE) / 2, y: origin.y + (smallCS * MAP_TILE_SIZE) / 2 };
    const s = worldToScreen(center.x, center.y);
    const camera = { screenX: s.x, screenY: s.y, width: GAME_WIDTH, height: GAME_HEIGHT };
    const range = visibleTileRange(0, 0, smallCS, camera);
    expect(range.lrStart).toBe(0);
    expect(range.lcStart).toBe(0);
    expect(range.lrEnd).toBe(smallCS - 1);
    expect(range.lcEnd).toBe(smallCS - 1);
  });
});

describe("chunkTileCells tile-level culling (F-029/SOMET-209)", () => {
  const CS = 64;
  const T = MAP_TILE_SIZE;

  it("enumerates far fewer than the full 64x64 grid for a camera over only part of the chunk", () => {
    const m = new ChunkedMap(CS);
    const grid = Array.from({ length: CS }, () => Array.from({ length: CS }, () => "grass"));
    m.setChunk(0, 0, grid);

    const camera = { screenX: 0, screenY: 0, width: 300, height: 200 };
    const culled = chunkTileCells(m, camera);
    expect(culled.length).toBeLessThan(CS * CS);
    expect(culled.length).toBeGreaterThan(0);
  });

  // The tile-level range is only a cheap pre-filter; RenderSystem's exact
  // per-tile relX/relY check (against the same camera.width/height margin)
  // still runs on whatever this yields and is what actually decides what's
  // drawn. Reproduce that exact check here and assert every tile it would
  // keep is present in chunkTileCells' output -- i.e. the range never
  // silently drops a tile the existing exact cull would have kept. This is
  // the failure mode strictly worse than the over-draw being fixed.
  function exactlyVisible(cells, camera) {
    return cells.filter((cell) => {
      const s = worldToScreen(cell.worldX, cell.worldY);
      const relX = s.x - camera.screenX;
      const relY = s.y - camera.screenY;
      return !(relX < -camera.width || relX > camera.width || relY < -camera.height || relY > camera.height);
    });
  }

  it("never drops a tile the exact per-tile relX/relY cull would keep", () => {
    const m = new ChunkedMap(CS);
    const grid = Array.from({ length: CS }, (_, lr) => Array.from({ length: CS }, (_, lc) => `${lr},${lc}`));
    m.setChunk(0, 0, grid);

    // A handful of off-center cameras, including one aimed at a chunk edge
    // (where an off-by-one in the padding would first show up) and one
    // aimed at the chunk's exact corner.
    const origin = chunkOrigin(0, 0, CS);
    const cams = [
      { screenX: 0, screenY: 0, width: 300, height: 200 },
      (() => {
        const edge = worldToScreen(origin.x + (CS - 1) * T + T / 2, origin.y + 5 * T + T / 2);
        return { screenX: edge.x, screenY: edge.y, width: 250, height: 150 };
      })(),
      (() => {
        const corner = worldToScreen(origin.x + T / 2, origin.y + T / 2);
        return { screenX: corner.x, screenY: corner.y, width: 180, height: 120 };
      })(),
    ];

    for (const camera of cams) {
      const full = chunkTileCells(m); // ground truth: every cell, uncalled
      const expectedVisible = exactlyVisible(full, camera);
      const culled = chunkTileCells(m, camera);
      const culledKeys = new Set(culled.map((c) => `${c.worldX},${c.worldY}`));
      for (const cell of expectedVisible) {
        expect(culledKeys.has(`${cell.worldX},${cell.worldY}`)).toBe(true);
      }
    }
  });
});
