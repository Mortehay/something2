import { describe, it, expect } from "vitest";
import {
  worldToChunkLocal, chunkOf, chunkOrigin, CHUNK_KEY,
} from "../worldCoords.js";
import { MAP_TILE_SIZE } from "../constants.js";

const N = 4;                // small chunk (tiles) for legible tests
const T = MAP_TILE_SIZE;    // 100 px per tile
const CHUNK_PX = N * T;     // 400 px per chunk

describe("worldToChunkLocal", () => {
  it("puts the origin tile at chunk (0,0) local (0,0)", () => {
    expect(worldToChunkLocal(0, 0, N)).toEqual({ cx: 0, cy: 0, lr: 0, lc: 0 });
  });

  it("local indices stay within [0, N) and rebuild the global tile index", () => {
    for (const [wx, wy] of [[0, 0], [350, 999], [-1, -1], [-350, 12345], [4321, -6789]]) {
      const { cx, cy, lr, lc } = worldToChunkLocal(wx, wy, N);
      expect(lr).toBeGreaterThanOrEqual(0); expect(lr).toBeLessThan(N);
      expect(lc).toBeGreaterThanOrEqual(0); expect(lc).toBeLessThan(N);
      // global tile index == cx*N + lc  (matches Phase 1 chunk ownership)
      expect(cx * N + lc).toBe(Math.floor(wx / T));
      expect(cy * N + lr).toBe(Math.floor(wy / T));
    }
  });

  it("is seam-consistent: last tile of a chunk and first of the next are adjacent", () => {
    // worldX just inside chunk 0's last column vs chunk 1's first column.
    const lastOf0 = worldToChunkLocal(CHUNK_PX - 1, 0, N); // cx 0, lc N-1
    const firstOf1 = worldToChunkLocal(CHUNK_PX, 0, N);    // cx 1, lc 0
    expect(lastOf0).toMatchObject({ cx: 0, lc: N - 1 });
    expect(firstOf1).toMatchObject({ cx: 1, lc: 0 });
  });

  it("handles negative coordinates with floor semantics", () => {
    // -1 px is global tile -1 => chunk -1, local col N-1.
    expect(worldToChunkLocal(-1, -1, N)).toEqual({ cx: -1, cy: -1, lr: N - 1, lc: N - 1 });
  });
});

describe("chunkOf / chunkOrigin", () => {
  it("chunkOf agrees with worldToChunkLocal", () => {
    for (const [wx, wy] of [[123, 456], [-5, -5], [CHUNK_PX + 7, -CHUNK_PX - 7]]) {
      const full = worldToChunkLocal(wx, wy, N);
      expect(chunkOf(wx, wy, N)).toEqual({ cx: full.cx, cy: full.cy });
    }
  });

  it("chunkOrigin is the top-left world pixel of a chunk, and contains its points", () => {
    expect(chunkOrigin(0, 0, N)).toEqual({ x: 0, y: 0 });
    expect(chunkOrigin(2, -1, N)).toEqual({ x: 2 * CHUNK_PX, y: -1 * CHUNK_PX });
    // Any point in chunk (2,-1) is within [origin, origin+CHUNK_PX).
    const { cx, cy } = chunkOf(2 * CHUNK_PX + 5, -CHUNK_PX + 5, N);
    const o = chunkOrigin(cx, cy, N);
    expect(2 * CHUNK_PX + 5 - o.x).toBeGreaterThanOrEqual(0);
    expect(2 * CHUNK_PX + 5 - o.x).toBeLessThan(CHUNK_PX);
  });
});

describe("CHUNK_KEY", () => {
  it("formats a canonical key incl. negatives", () => {
    expect(CHUNK_KEY(0, 0)).toBe("0,0");
    expect(CHUNK_KEY(-2, 3)).toBe("-2,3");
  });
});

import { parseKey } from "../worldCoords.js";

describe("parseKey", () => {
  it("is the inverse of CHUNK_KEY, incl. negatives", () => {
    for (const [cx, cy] of [[0, 0], [3, -2], [-5, 7], [-1, -1]]) {
      expect(parseKey(CHUNK_KEY(cx, cy))).toEqual({ cx, cy });
    }
  });
});
