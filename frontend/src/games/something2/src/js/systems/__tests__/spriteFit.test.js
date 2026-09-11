import { describe, it, expect } from "vitest";
import { fitSpriteRect, RenderSystem } from "../RenderSystem.js";

// SOMET-569. A sprite must keep its own shape, whatever shape the box is.
//
// WHAT WENT WRONG WITHOUT THIS. Sprites were blitted with the five-argument
// drawImage(img, x, y, w, h), which stretches the source canvas into the
// destination box. So a subject rendered true only when its canvas aspect
// happened to match its box aspect -- an undeclared coupling between an image
// file and a database column that nothing asserted, and that was broken in
// both directions at once:
//
//   - 301 creatures draw into a hardcoded square 48x48 (CREATURE_SIZE), so
//     tightly-cropped non-square art squashed them; a staff measured 7.04x too
//     wide.
//   - pine_tree (64x104), dead_tree (56x92), Tree (64x96) and rose_bush
//     (40x44) hold SQUARE art in non-square boxes and had been rendering at
//     0.61-0.67x of their true shape since they were added.
//
// These tests assert the DESTINATION RECTANGLE, because that is the thing that
// was wrong. A test that only checked "drawImage was called" passed throughout.

const aspect = (r) => r.dw / r.dh;

describe("fitSpriteRect", () => {
  it("keeps a wide sprite's shape in a square box", () => {
    // The Beast_Champion case: content 473x222 (2.13:1) in a 48x48 box.
    // Stretching gave 48x48 -- 1.00:1, less than half its true width ratio.
    const r = fitSpriteRect(473, 222, 0, 0, 48, 48);
    expect(aspect(r)).toBeCloseTo(473 / 222, 5);
    expect(r.dw).toBeCloseTo(48, 5);          // limiting axis fills the box
    expect(r.dh).toBeLessThan(48);
  });

  it("keeps a tall sprite's shape in a square box", () => {
    // The archmage_staff case: content 121x856. Stretched, it became a blob.
    const r = fitSpriteRect(121, 856, 0, 0, 48, 48);
    expect(aspect(r)).toBeCloseTo(121 / 856, 5);
    expect(r.dh).toBeCloseTo(48, 5);
    expect(r.dw).toBeLessThan(10);
  });

  it("keeps square art true in a NON-square box", () => {
    // pine_tree: square art, 64x104 box. This is the pre-existing bug -- the
    // old code returned the full 64x104, i.e. 0.62x the true shape.
    const r = fitSpriteRect(500, 500, 0, 0, 64, 104);
    expect(aspect(r)).toBeCloseTo(1, 5);
    expect(r.dw).toBeCloseTo(64, 5);
    expect(r.dh).toBeCloseTo(64, 5);
  });

  it("never exceeds the box on either axis", () => {
    for (const [iw, ih] of [[473, 222], [121, 856], [500, 500], [7, 3], [1, 1000]]) {
      const r = fitSpriteRect(iw, ih, 10, 20, 48, 64);
      expect(r.dw).toBeLessThanOrEqual(48 + 1e-9);
      expect(r.dh).toBeLessThanOrEqual(64 + 1e-9);
    }
  });

  it("stands the sprite on the box's bottom edge, not its middle", () => {
    // THE ONE THAT MATTERS FOR GAMEPLAY. The caller positions the box so the
    // actor's feet land on boxY + boxH -- the projection of the world-box
    // centre that movement and collision resolve against. Centring the fitted
    // sprite vertically would lift a short-and-wide creature off the ground it
    // is standing on by half the leftover space.
    const r = fitSpriteRect(473, 222, 100, 200, 48, 48);
    expect(r.dy + r.dh).toBeCloseTo(200 + 48, 5);   // feet exactly on the anchor
    expect(r.dy).toBeGreaterThan(200);              // and genuinely inset, not a no-op
  });

  it("centres horizontally", () => {
    const r = fitSpriteRect(121, 856, 100, 200, 48, 48);
    const leftGap = r.dx - 100;
    const rightGap = (100 + 48) - (r.dx + r.dw);
    expect(leftGap).toBeCloseTo(rightGap, 5);
  });

  it("falls back to the box for an image that has not decoded yet", () => {
    // An Image reports 0x0 before it decodes. Scaling by 0/0 gives NaN, and
    // Canvas 2D silently DROPS a draw with non-finite coordinates -- so the
    // sprite would disappear with nothing logged anywhere.
    for (const [iw, ih] of [[0, 0], [0, 10], [10, 0], [NaN, 5], [undefined, undefined]]) {
      const r = fitSpriteRect(iw, ih, 5, 6, 48, 64);
      expect(Number.isFinite(r.dx) && Number.isFinite(r.dy)).toBe(true);
      expect(Number.isFinite(r.dw) && Number.isFinite(r.dh)).toBe(true);
      expect([r.dx, r.dy, r.dw, r.dh]).toEqual([5, 6, 48, 64]);
    }
  });
});

// --- the rect the renderer actually hands to the canvas ---------------------

function recordingCanvas() {
  const calls = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    save: () => {}, restore: () => {}, beginPath: () => {}, closePath: () => {},
    moveTo: () => {}, lineTo: () => {}, arc: () => {}, ellipse: () => {},
    fill: () => {}, stroke: () => {}, clip: () => {}, rect: () => {},
    translate: () => {}, scale: () => {}, rotate: () => {}, setTransform: () => {},
    clearRect: () => {}, fillText: () => {}, strokeText: () => {},
    measureText: () => ({ width: 10 }), createLinearGradient: () => ({ addColorStop: () => {} }),
    drawImage: (...args) => calls.push({ op: "drawImage", args }),
    fillRect: (...args) => calls.push({ op: "fillRect", args }),
    strokeRect: () => {},
    set fillStyle(v) {}, get fillStyle() { return "#000"; },
    set strokeStyle(v) {}, get strokeStyle() { return "#000"; },
    set globalAlpha(v) {}, get globalAlpha() { return 1; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set font(v) {}, get font() { return "10px sans-serif"; },
    set textAlign(v) {}, get textAlign() { return "left"; },
    set textBaseline(v) {}, get textBaseline() { return "top"; },
    set shadowBlur(v) {}, get shadowBlur() { return 0; },
    set shadowColor(v) {}, get shadowColor() { return "#000"; },
    set imageSmoothingEnabled(v) {}, get imageSmoothingEnabled() { return false; },
    set lineJoin(v) {}, set lineCap(v) {}, setLineDash: () => {},
  };
  return { canvas: { getContext: () => ctx }, calls };
}

describe("drawCreature", () => {
  it("draws a wide sprite at its own aspect, not the box's", () => {
    const { canvas, calls } = recordingCanvas();
    const rs = new RenderSystem(canvas, {
      // A wide image, the shape a tight crop of Beast_Champion produces.
      get: () => ({ width: 473, height: 222 }),
    });
    rs.drawCreature({ x: 100, y: 100, width: 48, height: 48 }, "k");

    const call = calls.find((c) => c.op === "drawImage");
    expect(call, "no sprite was drawn").toBeTruthy();
    const [, , , dw, dh] = call.args;
    // Stretching would have produced 48 x 48. Anything close to square here
    // means the fit is not being applied.
    expect(dw / dh).toBeCloseTo(473 / 222, 5);
    expect(dw / dh).toBeGreaterThan(2);
  });
});
