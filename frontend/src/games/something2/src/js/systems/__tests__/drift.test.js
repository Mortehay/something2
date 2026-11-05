import { describe, it, expect } from "vitest";
import {
  driftX, driftY, DRIFT_X_PX, DRIFT_Y_PX, DRIFT_X_PERIOD_MS, DRIFT_Y_PERIOD_MS,
} from "../drift.js";
import { swayPhaseSeed } from "../sway.js";

// SOMET-677: 'drift' moves a static prop a few pixels left/right and up/down
// in slow motion -- a calm alternative to the shine glint. These pin the offset
// contract: small, slow, continuous, per-prop phase, always finite.
describe("driftX / driftY", () => {
  it("stays within a few pixels for any time and seed, and actually moves", () => {
    let maxX = 0, maxY = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      for (let t = 0; t < 30000; t += 41) {
        maxX = Math.max(maxX, Math.abs(driftX(t, seed * 7919)));
        maxY = Math.max(maxY, Math.abs(driftY(t, seed * 7919)));
      }
    }
    expect(maxX).toBeLessThanOrEqual(DRIFT_X_PX);
    expect(maxY).toBeLessThanOrEqual(DRIFT_Y_PX);
    expect(DRIFT_X_PX).toBeLessThanOrEqual(3);
    expect(DRIFT_Y_PX).toBeLessThanOrEqual(3);
    // A floor as well as a cap: at +-0.3 this suite stayed green while the
    // motion was too small to read (SOMET-677).
    expect(DRIFT_X_PX).toBeGreaterThanOrEqual(1);
    expect(DRIFT_Y_PX).toBeGreaterThanOrEqual(1);
    expect(maxX).toBeGreaterThan(DRIFT_X_PX * 0.95);
    expect(maxY).toBeGreaterThan(DRIFT_Y_PX * 0.95);
  });

  it("is slow motion: periods of several seconds, x and y out of step", () => {
    expect(DRIFT_X_PERIOD_MS).toBeGreaterThanOrEqual(3000);
    expect(DRIFT_Y_PERIOD_MS).toBeGreaterThanOrEqual(3000);
    expect(DRIFT_X_PERIOD_MS).not.toBe(DRIFT_Y_PERIOD_MS);
    for (const t of [0, 123, 2500]) {
      expect(driftX(t + DRIFT_X_PERIOD_MS, 42)).toBeCloseTo(driftX(t, 42), 9);
      expect(driftY(t + DRIFT_Y_PERIOD_MS, 42)).toBeCloseTo(driftY(t, 42), 9);
    }
  });

  it("is continuous: a 60 fps frame moves well under a pixel (no jitter)", () => {
    let worst = 0;
    for (let t = 0; t < 20000; t += 16) {
      worst = Math.max(worst, Math.abs(driftX(t + 16, 9) - driftX(t, 9)), Math.abs(driftY(t + 16, 9) - driftY(t, 9)));
    }
    expect(worst).toBeLessThan(0.05);
  });

  it("neighbouring props drift out of step", () => {
    const xs = [0, 100, 200, 300].map((x) => driftX(1000, swayPhaseSeed(x, 0)));
    const ys = [0, 100, 200, 300].map((x) => driftY(1000, swayPhaseSeed(x, 0)));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.2);
  });

  it("is finite for non-finite inputs (Canvas 2D silently drops non-finite coords)", () => {
    for (const [t, s] of [[NaN, 1], [1, NaN], [Infinity, undefined]]) {
      expect(Number.isFinite(driftX(t, s))).toBe(true);
      expect(Number.isFinite(driftY(t, s))).toBe(true);
    }
  });
});
