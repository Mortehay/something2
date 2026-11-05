import { describe, it, expect } from "vitest";
import { createEtaTracker, formatEta, percent } from "../assetProgress.js";

describe("percent", () => {
  it("is 0 with nothing queued and never exceeds 100", () => {
    expect(percent(0, 0)).toBe(0);
    expect(percent(5, 10)).toBe(50);
    expect(percent(12, 10)).toBe(100);
  });
});

describe("eta tracker", () => {
  it("says nothing until it has seen progress", () => {
    const t = createEtaTracker();
    expect(t.eta(0, 100)).toBeNull();
    t.sample(0, 0);
    t.sample(1000, 0);
    expect(t.eta(1000, 100)).toBeNull();
  });
  it("extrapolates the recent rate", () => {
    const t = createEtaTracker();
    t.sample(0, 0);
    t.sample(2000, 10); // 5 images/s
    expect(t.eta(2000, 50)).toBeCloseTo(10, 5);
  });
  it("is 0 when nothing remains", () => {
    expect(createEtaTracker().eta(0, 0)).toBe(0);
  });
  it("forgets a slow start: only the recent window counts", () => {
    const t = createEtaTracker(6000);
    t.sample(0, 0);
    t.sample(5000, 1);     // crawling
    t.sample(10000, 1);
    t.sample(11000, 21);   // burst: 20 in the last second
    expect(t.eta(11000, 40)).toBeLessThan(15);
  });
});

describe("formatEta", () => {
  it("formats seconds and minutes, and unknown as null", () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(0.2)).toEqual({ m: 0, s: 1 });
    expect(formatEta(65)).toEqual({ m: 1, s: 5 });
  });
});
