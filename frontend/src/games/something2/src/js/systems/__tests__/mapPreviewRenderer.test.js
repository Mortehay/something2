import { describe, it, expect } from "vitest";
import { isoFit, tileToScreen, revealAlpha } from "../mapPreviewRenderer.js";

describe("isoFit", () => {
  it("fits every tile inside the box", () => {
    const rows = 30, cols = 40, boxW = 600, boxH = 400;
    const fit = isoFit(rows, cols, boxW, boxH, 8);
    expect(fit.tileW).toBeGreaterThan(0);
    // Check the four extreme tiles land within the box (allowing a half-diamond).
    for (const [r, c] of [[0, 0], [0, cols - 1], [rows - 1, 0], [rows - 1, cols - 1]]) {
      const { x, y } = tileToScreen(r, c, fit);
      expect(x - fit.tileW / 2).toBeGreaterThanOrEqual(-0.5);
      expect(x + fit.tileW / 2).toBeLessThanOrEqual(boxW + 0.5);
      expect(y - fit.tileH / 2).toBeGreaterThanOrEqual(-0.5);
      expect(y + fit.tileH / 2).toBeLessThanOrEqual(boxH + 0.5);
    }
  });

  it("centers a single tile", () => {
    const fit = isoFit(1, 1, 200, 100, 0);
    const { x, y } = tileToScreen(0, 0, fit);
    expect(x).toBeCloseTo(100, 5);
    expect(y).toBeCloseTo(50, 5);
  });

  it("returns zero size for an empty map", () => {
    expect(isoFit(0, 0, 100, 100)).toEqual({ tileW: 0, tileH: 0, offsetX: 0, offsetY: 0 });
  });
});

describe("revealAlpha", () => {
  it("is 0 at progress 0 and 1 at progress >= 1", () => {
    expect(revealAlpha(0, 0, 10, 10, 0)).toBe(0);
    expect(revealAlpha(9, 9, 10, 10, 1)).toBe(1);
  });

  it("reveals the center before the corners", () => {
    const p = 0.2;
    const center = revealAlpha(5, 5, 11, 11, p);
    const corner = revealAlpha(0, 0, 11, 11, p);
    expect(center).toBeGreaterThan(corner);
  });
});
