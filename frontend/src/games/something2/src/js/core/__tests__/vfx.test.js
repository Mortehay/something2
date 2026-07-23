import { describe, it, expect } from "vitest";
import {
  indexEffects, addEffects, pruneEffects, effectProgress, effectAlpha, ease,
  isoArcAngle, DEFAULT_DURATION_MS,
} from "../vfx.js";

const DEF = {
  id: 1, name: "sweep_arc", shape: "arc", color: "#e8e8f0", width: 3,
  duration_ms: 200, ease: "out", fade: true, follows_weapon: true,
};
const DEFS = indexEffects([DEF]);
const EV = (over = {}) => ({
  a: "p:1", v: "sweep_arc", x: 10, y: 20, nx: 1, ny: 0, reach: 190, arc: 1.8, hit: true, ...over,
});

describe("indexEffects", () => {
  it("keys the library by name", () => {
    expect(indexEffects([DEF]).sweep_arc.duration_ms).toBe(200);
  });
  it("survives a missing or malformed library", () => {
    expect(indexEffects(null)).toEqual({});
    expect(indexEffects([null, { shape: "arc" }])).toEqual({});  // rows without a name are unreferenceable
  });
});

describe("addEffects", () => {
  it("stamps arrival time and carries the event geometry", () => {
    const list = addEffects([], [EV()], 1000, DEFS);
    expect(list).toHaveLength(1);
    expect(list[0].startedAt).toBe(1000);
    expect(list[0].reach).toBe(190);
    expect(list[0].arc).toBe(1.8);
    expect(list[0].hit).toBe(true);
    expect(list[0].def).toBe(DEF);
  });

  it("drops an event whose effect name is not in the library", () => {
    // vfx bindings have no referential integrity — a renamed row orphans them.
    // An unresolvable name draws nothing; it must never throw.
    expect(addEffects([], [EV({ v: "renamed_away" })], 0, DEFS)).toHaveLength(0);
    expect(addEffects([], [EV({ v: null })], 0, DEFS)).toHaveLength(0);
  });

  it("drops events with non-finite coordinates", () => {
    expect(addEffects([], [EV({ x: NaN })], 0, DEFS)).toHaveLength(0);
    expect(addEffects([], [EV({ y: undefined })], 0, DEFS)).toHaveLength(0);
  });

  it("tolerates a missing or non-array batch", () => {
    expect(addEffects([], null, 0, DEFS)).toEqual([]);
    expect(addEffects([], undefined, 0, DEFS)).toEqual([]);
  });

  it("defaults a degenerate aim vector to due south rather than zero", () => {
    // A zero vector would make atan2 return 0 and point every such swing east.
    const fx = addEffects([], [EV({ nx: 0, ny: 0 })], 0, DEFS)[0];
    expect(fx.nx).toBe(0);
    expect(fx.ny).toBe(1);
  });
});

describe("pruneEffects", () => {
  it("drops effects past their own duration", () => {
    const list = addEffects([], [EV()], 0, DEFS);
    expect(pruneEffects(list, 199)).toHaveLength(1);
    expect(pruneEffects(list, 200)).toHaveLength(0);
  });

  it("returns a NEW array so an in-progress draw is never mutated", () => {
    const list = addEffects([], [EV()], 0, DEFS);
    expect(pruneEffects(list, 10)).not.toBe(list);
  });

  it("prunes on RAW time, not eased progress", () => {
    // Easing is a display curve. Pruning off it would make an 'out' effect
    // vanish early and an 'in' effect linger past its duration.
    const slow = indexEffects([{ ...DEF, ease: "out", duration_ms: 100 }]);
    const list = addEffects([], [EV()], 0, slow);
    expect(pruneEffects(list, 99)).toHaveLength(1);
  });
});

describe("effectProgress", () => {
  it("runs 0 to 1 across the lifetime and clamps outside it", () => {
    const fx = addEffects([], [EV()], 1000, indexEffects([{ ...DEF, ease: "linear" }]))[0];
    expect(effectProgress(fx, 1000)).toBe(0);
    expect(effectProgress(fx, 1100)).toBeCloseTo(0.5);
    expect(effectProgress(fx, 1200)).toBe(1);
    expect(effectProgress(fx, 5000)).toBe(1);
    expect(effectProgress(fx, 900)).toBe(0);
  });

  it("applies the effect's own easing", () => {
    const out = addEffects([], [EV()], 0, indexEffects([{ ...DEF, ease: "out" }]))[0];
    // 'out' is fast-then-slow: half the time is more than half the sweep.
    expect(effectProgress(out, 100)).toBeGreaterThan(0.5);
    const inn = addEffects([], [EV()], 0, indexEffects([{ ...DEF, ease: "in" }]))[0];
    expect(effectProgress(inn, 100)).toBeLessThan(0.5);
  });

  it("falls back to the default duration when the def carries none", () => {
    const fx = addEffects([], [EV()], 0, indexEffects([{ ...DEF, duration_ms: 0 }]))[0];
    expect(effectProgress(fx, DEFAULT_DURATION_MS)).toBe(1);
  });
});

describe("effectAlpha", () => {
  it("fades linearly when fade is set", () => {
    const fx = addEffects([], [EV()], 0, indexEffects([{ ...DEF, ease: "out" }]))[0];
    // Linear, NOT eased: an eased alpha makes a fast 'out' effect disappear
    // almost immediately and the swing reads as a flicker.
    expect(effectAlpha(fx, 100)).toBeCloseTo(0.5);
  });

  it("stays opaque when fade is off", () => {
    const fx = addEffects([], [EV()], 0, indexEffects([{ ...DEF, fade: false }]))[0];
    expect(effectAlpha(fx, 199)).toBe(1);
  });
});

describe("ease", () => {
  it("pins both endpoints for every mode", () => {
    for (const m of ["linear", "out", "in", "nonsense", undefined]) {
      expect(ease(0, m)).toBe(0);
      expect(ease(1, m)).toBe(1);
    }
  });
  it("treats an unknown mode as linear", () => {
    expect(ease(0.5, "nonsense")).toBe(0.5);
  });
});

describe("isoArcAngle", () => {
  it("maps a world direction to the iso ellipse's PARAMETRIC angle", () => {
    // worldToScreen sends (R·cosθ, R·sinθ) to
    //   (R·√2·ISO_K·cos(θ+π/4), R·√2·ISO_K/2·sin(θ+π/4))
    // and canvas ellipse() draws (x + rx·cos φ, y + ry·sin φ) — so φ = θ+π/4.
    // Passing the raw world angle instead points every swing 45° off.
    expect(isoArcAngle(1, 0)).toBeCloseTo(Math.PI / 4);
    expect(isoArcAngle(0, 1)).toBeCloseTo(Math.PI / 2 + Math.PI / 4);
    expect(isoArcAngle(-1, 0)).toBeCloseTo(Math.PI + Math.PI / 4);
  });

  it("agrees with the screen position of the aim point", () => {
    // The strongest check available without a canvas: for a unit aim vector,
    // (cos φ, sin φ/2) must be parallel to the screen-space offset the iso
    // projection produces, which for (nx,ny) is ((nx-ny), (nx+ny)/2) up to a
    // positive scale.
    for (const [nx, ny] of [[1, 0], [0, 1], [-1, 0], [0, -1], [0.6, 0.8]]) {
      const phi = isoArcAngle(nx, ny);
      const ex = Math.cos(phi), ey = Math.sin(phi) / 2;
      const sx = (nx - ny) / Math.SQRT2, sy = (nx + ny) / (2 * Math.SQRT2);
      expect(ex).toBeCloseTo(sx, 6);
      expect(ey).toBeCloseTo(sy, 6);
    }
  });
});
