import { describe, it, expect } from "vitest";
import { hazardsFromFrame, marksFromFrame, markProgress, hazardsAt } from "../worldHazards.js";
import { telegraphsFromFrame } from "../worldTelegraphs.js";

describe("hazardsFromFrame", () => {
  const h = { id: 3, x: 100, y: 200, r: 150, el: "fire", v: "boss_lava_pools", ms: 5000 };
  it("maps the wire fields", () => {
    expect(hazardsFromFrame({ hazards: [h] })).toEqual([{
      id: "3", x: 100, y: 200, r: 150, inner: 0, element: "fire", v: "boss_lava_pools", ms: 5000, calm: false,
    }]);
  });
  it("keeps the hole of a ring, and the calm flag of ground that only slows", () => {
    const [ring] = hazardsFromFrame({ hazards: [{ ...h, in: 60 }] });
    expect(ring.inner).toBe(60);
    expect(hazardsFromFrame({ hazards: [{ ...h, calm: 1 }] })[0].calm).toBe(true);
  });
  it("ignores a hole that is not smaller than the radius, or not a number", () => {
    expect(hazardsFromFrame({ hazards: [{ ...h, in: 150 }] })[0].inner).toBe(0);
    expect(hazardsFromFrame({ hazards: [{ ...h, in: "x" }] })[0].inner).toBe(0);
    expect(hazardsFromFrame({ hazards: [{ ...h, in: -5 }] })[0].inner).toBe(0);
  });
  it("drops what the canvas could not draw", () => {
    expect(hazardsFromFrame({ hazards: [null, { x: NaN, y: 1, r: 5 }, { x: 1, y: 1, r: 0 }, { x: 1, y: 1 }] })).toEqual([]);
  });
  it("a frame without the key means none now", () => {
    expect(hazardsFromFrame({})).toEqual([]);
    expect(hazardsFromFrame(null)).toEqual([]);
    expect(hazardsFromFrame({ hazards: "x" })).toEqual([]);
  });
  it("tolerates missing optional fields", () => {
    const [x] = hazardsFromFrame({ hazards: [{ x: 1, y: 2, r: 3 }] });
    expect(x).toMatchObject({ element: null, v: null, ms: 0, calm: false });
  });
});

describe("hazardsAt: a pool fades on its own clock between frames", () => {
  const list = [{ id: "a", ms: 3000 }, { id: "b", ms: 500 }];
  it("subtracts the time since the frame, and drops what has run out", () => {
    expect(hazardsAt(list, 0)).toEqual(list);
    expect(hazardsAt(list, 1000).map((x) => [x.id, x.ms])).toEqual([["a", 2000]]);
    expect(hazardsAt(list, 5000)).toEqual([]);
    expect(hazardsAt(list, -10)).toEqual(list);
    expect(hazardsAt(null, 10)).toEqual([]);
  });
  it("does not mutate the frame list", () => {
    hazardsAt(list, 1000);
    expect(list[0].ms).toBe(3000);
  });
});

describe("marksFromFrame", () => {
  it("maps who, how wide, how long is left and how long the fuse was", () => {
    expect(marksFromFrame({ marks: [{ u: 7, r: 170, v: "boss_static_charge", ms: 1500, total: 3000 }] })).toEqual([
      { userId: "7", radius: 170, ms: 1500, total: 3000, v: "boss_static_charge" },
    ]);
  });
  it("drops a mark with no player or no usable radius", () => {
    expect(marksFromFrame({ marks: [null, { r: 100 }, { u: 1, r: 0 }, { u: 1, r: "x" }] })).toEqual([]);
    expect(marksFromFrame({})).toEqual([]);
  });
  it("falls back to the remaining time for a missing total", () => {
    expect(marksFromFrame({ marks: [{ u: 1, r: 50, ms: 900 }] })[0].total).toBe(900);
  });
  it("progress runs 0 to 1 over the fuse and never leaves that range", () => {
    expect(markProgress({ ms: 3000, total: 3000 })).toBe(0);
    expect(markProgress({ ms: 1500, total: 3000 })).toBe(0.5);
    expect(markProgress({ ms: 0, total: 3000 })).toBe(1);
    expect(markProgress({ ms: -5, total: 3000 })).toBe(1);
    expect(markProgress({ ms: 9999, total: 3000 })).toBe(0);
    expect(markProgress(null)).toBe(1);
  });
});

describe("a shelter telegraph is flagged safe", () => {
  const base = { creatureId: "b", skill: "Meltdown", x: 1, y: 2, radius: 150, ms: 1000, telegraphMs: 2600 };
  it("keeps the flag, and leaves every ordinary telegraph without it", () => {
    expect(telegraphsFromFrame({ telegraphs: [{ ...base, safe: 1 }] })[0].safe).toBe(true);
    expect(telegraphsFromFrame({ telegraphs: [base] })[0].safe).toBeUndefined();
  });
});
