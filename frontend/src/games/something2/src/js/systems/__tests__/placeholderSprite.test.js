import { describe, it, expect } from "vitest";
import { facingToWedge } from "../placeholderSprite.js";

describe("facingToWedge", () => {
  it("returns a unit-ish vector per facing", () => {
    const s = facingToWedge("S");
    expect(Math.hypot(s.dx, s.dy)).toBeCloseTo(1, 6);
  });

  it("S and N point opposite on screen", () => {
    const s = facingToWedge("S");
    const n = facingToWedge("N");
    expect(s.dx).toBeCloseTo(-n.dx, 6);
    expect(s.dy).toBeCloseTo(-n.dy, 6);
  });

  it("defaults unknown facings to S", () => {
    expect(facingToWedge("???")).toEqual(facingToWedge("S"));
  });
});
