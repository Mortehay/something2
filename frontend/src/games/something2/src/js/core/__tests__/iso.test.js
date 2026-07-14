import { describe, it, expect } from "vitest";
import { worldToScreen, screenToWorld, depthKey, ISO_K } from "../iso.js";

describe("iso projection", () => {
  it("maps world origin to screen origin", () => {
    const s = worldToScreen(0, 0);
    expect(s.x).toBeCloseTo(0, 6);
    expect(s.y).toBeCloseTo(0, 6);
  });

  it("is a 2:1 diamond: +x world goes down-right, +y world goes down-left", () => {
    const sx = worldToScreen(100, 0); // one world tile along x
    expect(sx.x).toBeCloseTo(100 * ISO_K, 6);
    expect(sx.y).toBeCloseTo(50 * ISO_K, 6);
    const sy = worldToScreen(0, 100);
    expect(sy.x).toBeCloseTo(-100 * ISO_K, 6);
    expect(sy.y).toBeCloseTo(50 * ISO_K, 6);
  });

  it("screenToWorld is the exact inverse of worldToScreen", () => {
    for (const [wx, wy] of [[0, 0], [123, 456], [-789, 321], [5000, 9999]]) {
      const s = worldToScreen(wx, wy);
      const w = screenToWorld(s.x, s.y);
      expect(w.x).toBeCloseTo(wx, 4);
      expect(w.y).toBeCloseTo(wy, 4);
    }
  });

  it("depthKey increases as world x+y increases (draw order)", () => {
    expect(depthKey(10, 10)).toBeLessThan(depthKey(20, 10));
    expect(depthKey(10, 10)).toBeLessThan(depthKey(10, 20));
  });
});
