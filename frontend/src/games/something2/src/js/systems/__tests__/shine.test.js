import { describe, it, expect } from "vitest";
import { shineBand, SHINE_PERIOD_MS, SHINE_SWEEP_MS } from "../shine.js";

// Props v2 'shine': a glint band sweeps across the sprite once per ~4.5 s,
// taking ~0.6 s, idle (null) the rest. Phase comes from the same per-position
// hash sway uses, so neighbouring props do not flash in sync.
describe("shineBand", () => {
  it("has a 4.5 s period and a 0.6 s sweep", () => {
    expect(SHINE_PERIOD_MS).toBe(4500);
    expect(SHINE_SWEEP_MS).toBe(600);
  });

  it("is null for most of the period and {t in [0,1)} during the sweep", () => {
    let on = 0;
    const N = 4500;
    for (let ms = 0; ms < N; ms += 1) {
      const b = shineBand(ms, 12345);
      if (b === null) continue;
      on += 1;
      expect(b.t).toBeGreaterThanOrEqual(0);
      expect(b.t).toBeLessThan(1);
    }
    expect(on).toBe(600);
  });

  it("t runs monotonically 0 -> 1 across one sweep", () => {
    const seed = 0; // phase 0: the sweep is the first 600 ms of each period
    expect(shineBand(0, seed).t).toBe(0);
    expect(shineBand(300, seed).t).toBeCloseTo(0.5, 10);
    expect(shineBand(599, seed).t).toBeCloseTo(599 / 600, 10);
    expect(shineBand(600, seed)).toBeNull();
    expect(shineBand(4499, seed)).toBeNull();
  });

  it("is periodic", () => {
    for (const ms of [0, 100, 599, 2000, 4499]) {
      expect(shineBand(ms + SHINE_PERIOD_MS, 777)).toEqual(shineBand(ms, 777));
      expect(shineBand(ms + 7 * SHINE_PERIOD_MS, 777)).toEqual(shineBand(ms, 777));
    }
  });

  it("the phase seed shifts the sweep in time", () => {
    const onsets = [0, 2 ** 30, 2 ** 31, 3 * 2 ** 30].map((seed) => {
      for (let ms = 0; ms < SHINE_PERIOD_MS; ms += 1) {
        const b = shineBand(ms, seed);
        if (b && b.t === 0) return ms;
      }
      // The sweep straddles the period boundary: find where it starts.
      for (let ms = 0; ms < SHINE_PERIOD_MS; ms += 1) if (shineBand(ms, seed) && !shineBand(ms - 1 + SHINE_PERIOD_MS, seed)) return ms;
      return -1;
    });
    expect(new Set(onsets).size).toBe(4);
  });

  it("never throws or returns NaN on bad input", () => {
    for (const [t, s] of [[NaN, 1], [Infinity, 1], [100, NaN], [undefined, undefined], [-500, 3]]) {
      const b = shineBand(t, s);
      if (b !== null) expect(Number.isFinite(b.t)).toBe(true);
    }
  });
});
