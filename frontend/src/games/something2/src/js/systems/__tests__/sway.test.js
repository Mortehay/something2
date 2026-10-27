import { describe, it, expect } from "vitest";
import { swayShear, swayPhaseSeed, SWAY_AMPLITUDE, SWAY_PERIOD_MS } from "../sway.js";

// Props v2: an approved GPU-box prop is one static image; the renderer sways
// it with a horizontal shear about its base. These pin the shear's contract.
describe("swayShear", () => {
  it("is bounded by the amplitude (0.035) for any time and seed", () => {
    expect(SWAY_AMPLITUDE).toBe(0.035);
    let max = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      for (let t = 0; t < 10000; t += 37) max = Math.max(max, Math.abs(swayShear(t, seed * 7919)));
    }
    expect(max).toBeLessThanOrEqual(0.035);
    // ...and actually reaches near it, so it is not a constant 0.
    expect(max).toBeGreaterThan(0.034);
  });

  it("is periodic with a 2.8 s period", () => {
    expect(SWAY_PERIOD_MS).toBe(2800);
    for (const t of [0, 123, 1400, 2799]) {
      expect(swayShear(t + SWAY_PERIOD_MS, 42)).toBeCloseTo(swayShear(t, 42), 12);
      expect(swayShear(t + 5 * SWAY_PERIOD_MS, 42)).toBeCloseTo(swayShear(t, 42), 9);
    }
  });

  it("varies over time", () => {
    expect(swayShear(0, 42)).not.toBeCloseTo(swayShear(700, 42), 4);
  });

  it("a different phase seed gives a different value at the same time", () => {
    expect(swayShear(1000, swayPhaseSeed(0, 0))).not.toBeCloseTo(swayShear(1000, swayPhaseSeed(100, 0)), 4);
  });

  it("is finite for non-finite inputs (Canvas 2D silently drops non-finite transforms)", () => {
    for (const [t, s] of [[NaN, 1], [1, NaN], [Infinity, undefined]]) {
      expect(Number.isFinite(swayShear(t, s))).toBe(true);
    }
  });
});

describe("swayPhaseSeed", () => {
  it("is stable for a position", () => {
    expect(swayPhaseSeed(6400, 6600)).toBe(swayPhaseSeed(6400, 6600));
  });

  it("differs between neighbouring tiles", () => {
    const seeds = new Set();
    for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) seeds.add(swayPhaseSeed(c * 100, r * 100));
    expect(seeds.size).toBe(16);
    // Neighbours are not merely different but out of step: their shear at one
    // instant spreads across the range rather than clustering.
    const ks = [0, 100, 200, 300].map((x) => swayShear(500, swayPhaseSeed(x, 0)));
    expect(Math.max(...ks) - Math.min(...ks)).toBeGreaterThan(0.01);
  });
});
