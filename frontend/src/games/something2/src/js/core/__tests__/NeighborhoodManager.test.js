import { describe, it, expect } from "vitest";
import { neighborhoodKeys, diffNeighborhoods } from "../NeighborhoodManager.js";

describe("neighborhoodKeys", () => {
  it("returns the 3x3 block around the center for radius 1", () => {
    const keys = neighborhoodKeys(0, 0, 1);
    expect(keys.length).toBe(9);
    expect(new Set(keys)).toEqual(new Set([
      "-1,-1", "0,-1", "1,-1",
      "-1,0", "0,0", "1,0",
      "-1,1", "0,1", "1,1",
    ]));
  });

  it("centers on negative coordinates too", () => {
    const keys = neighborhoodKeys(-2, 3, 1);
    expect(keys).toContain("-2,3");   // center
    expect(keys).toContain("-3,2");   // corner
    expect(keys).toContain("-1,4");   // opposite corner
    expect(keys.length).toBe(9);
  });

  it("radius 0 is a single chunk; radius 2 is 25", () => {
    expect(neighborhoodKeys(5, 5, 0)).toEqual(["5,5"]);
    expect(neighborhoodKeys(0, 0, 2).length).toBe(25);
  });
});

describe("diffNeighborhoods", () => {
  it("splits into load (new) and drop (gone), keeping the overlap", () => {
    const prev = neighborhoodKeys(0, 0, 1);
    const next = neighborhoodKeys(1, 0, 1); // stepped one chunk east
    const { toLoad, toDrop } = diffNeighborhoods(prev, next);
    // moving east: load the new east column (cx=2), drop the old west column (cx=-1)
    expect(new Set(toLoad)).toEqual(new Set(["2,-1", "2,0", "2,1"]));
    expect(new Set(toDrop)).toEqual(new Set(["-1,-1", "-1,0", "-1,1"]));
  });

  it("identical neighborhoods diff to nothing", () => {
    const n = neighborhoodKeys(3, -4, 1);
    expect(diffNeighborhoods(n, n)).toEqual({ toLoad: [], toDrop: [] });
  });
});
