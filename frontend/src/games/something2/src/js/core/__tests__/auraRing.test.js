import { describe, it, expect } from "vitest";
import { auraRingGeometry, blastScreenRadiusX } from "../blasts.js";

// A stand-in projection: identity in x, halved in y, which is enough to prove
// the helper goes THROUGH worldToScreen rather than using world coords.
const w2s = (x, y) => ({ x: x * 2, y: y / 2 });

describe("auraRingGeometry", () => {
  it("projects a player's aura onto the ground plane as a 2:1 ellipse", () => {
    const g = auraRingGeometry({ x: 100, y: 200, aura: 160 }, w2s);
    expect(g).not.toBeNull();
    expect(g.x).toBe(200);
    expect(g.y).toBe(100);
    expect(g.rx).toBe(blastScreenRadiusX(160));
    // A world circle is an ellipse on an isometric ground plane. Drawing a
    // circle would claim the aura reaches further north/south than it leeches.
    expect(g.ry).toBe(g.rx / 2);
  });

  it("scales with the radius the server sent", () => {
    const small = auraRingGeometry({ x: 0, y: 0, aura: 120 }, w2s);
    const big = auraRingGeometry({ x: 0, y: 0, aura: 200 }, w2s);
    expect(big.rx).toBeGreaterThan(small.rx);
  });

  // THE POINT OF RETURNING null. Canvas 2D silently DROPS a path with
  // non-finite coordinates -- no error, nothing drawn -- and ellipse() THROWS
  // on a negative radius, which would break the entire frame rather than one
  // ring. Every one of these must be filtered here, not trusted.
  it("returns null for anything that would poison the canvas", () => {
    const bad = [
      null,
      undefined,
      {},                                    // no aura at all: the common case
      { x: 0, y: 0 },
      { x: 0, y: 0, aura: 0 },               // no aura node allocated
      { x: 0, y: 0, aura: -50 },             // would THROW in ellipse()
      { x: 0, y: 0, aura: NaN },
      { x: 0, y: 0, aura: "wide" },
      { x: 0, y: 0, aura: Infinity },
      { x: NaN, y: 0, aura: 160 },
      { x: 0, y: undefined, aura: 160 },
    ];
    for (const p of bad) {
      expect(auraRingGeometry(p, w2s)).toBeNull();
    }
  });

  it("returns null when the projection itself yields non-finite screen coords", () => {
    const broken = () => ({ x: NaN, y: 0 });
    expect(auraRingGeometry({ x: 1, y: 1, aura: 160 }, broken)).toBeNull();
  });

  // Every value the helper returns must be finite -- that is the contract the
  // draw site relies on to skip its own guards.
  it("every returned coordinate is finite", () => {
    const g = auraRingGeometry({ x: -400, y: 900, aura: 1 }, w2s);
    if (g) for (const v of Object.values(g)) expect(Number.isFinite(v)).toBe(true);
  });
});
