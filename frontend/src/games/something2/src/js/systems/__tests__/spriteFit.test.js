import { describe, it, expect } from "vitest";
import { fitSpriteRect, RenderSystem } from "../RenderSystem.js";
import { Camera } from "../../core/Camera.js";
import { worldToScreen } from "../../core/iso.js";

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
    translate: (...args) => calls.push({ op: "translate", args }),
    scale: (...args) => calls.push({ op: "scale", args }),
    rotate: () => {}, setTransform: () => {},
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

// SOMET-706. A 96x128 sheet cell must land in the same on-screen box as a
// 48x64 one: the actor and entity paths fit the FRAME crop into the entity box.
describe("cell size independence (SOMET-706)", () => {
  it("fits a 96x128 frame into a 48x64 box exactly like a 48x64 frame", () => {
    const small = fitSpriteRect(48, 64, 10, 20, 48, 64);
    const big = fitSpriteRect(96, 128, 10, 20, 48, 64);
    expect(big).toEqual(small);
  });

  it("both actor paths fit the resolved frame crop and never draw at native size", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../RenderSystem.js", import.meta.url), "utf8");
    const actor = src.slice(src.indexOf("  drawCreature("), src.indexOf("  _drawSpriteFrame("));
    expect(actor).toMatch(/fitSpriteRect\(resolved\.crop\[2\], resolved\.crop\[3\]/);
    const entity = src.slice(src.indexOf("  _drawEntityArt("));
    expect(entity).toMatch(/fitSpriteRect\(sprite\.crop\[2\], sprite\.crop\[3\]/);
    const frame = src.slice(src.indexOf("  _drawSpriteFrame("), src.indexOf("  _drawSpriteFrame(") + 900);
    expect(frame).not.toMatch(/drawImage\(sprite\.img, sx, sy\)/);
  });
});

// SOMET-706. With smoothing off, a frame drawn smaller than its source keeps
// only some source pixels, and a fractional position decides which. A walking
// 96x128 figure re-sampled 57-63% of its pixels; a 48x64 one 0%.
describe("a downscaled frame draws at whole pixels (SOMET-706)", () => {
  const frame = (w, h, flipX = false) => ({ img: { width: w, height: h }, crop: [0, 0, w, h], flipX });
  const rect = (dx, dy, dw, dh) => ({ dx, dy, dw, dh });
  const drawOf = (calls) => calls.find((c) => c.op === "drawImage").args;

  it("snaps a 96x128 frame drawn into 48x64 and keeps its size", () => {
    const { canvas, calls } = recordingCanvas();
    new RenderSystem(canvas, {})._drawSpriteFrame(frame(96, 128), rect(615.29, 295.77, 48, 64));
    const [, , , , , dx, dy, dw, dh] = drawOf(calls);
    expect(Number.isInteger(dx)).toBe(true);
    expect(Number.isInteger(dy)).toBe(true);
    expect([dw, dh]).toEqual([48, 64]);
  });

  it("leaves a frame drawn 1:1 exactly where it was", () => {
    const { canvas, calls } = recordingCanvas();
    new RenderSystem(canvas, {})._drawSpriteFrame(frame(48, 64), rect(615.29, 295.77, 48, 64));
    expect(drawOf(calls).slice(1)).toEqual([0, 0, 48, 64, 615.29, 295.77, 48, 64]);
  });

  it("leaves a frame drawn larger than its source exactly where it was", () => {
    const { canvas, calls } = recordingCanvas();
    new RenderSystem(canvas, {})._drawSpriteFrame(frame(24, 32), rect(10.5, 20.5, 48, 64));
    expect(drawOf(calls).slice(1)).toEqual([0, 0, 24, 32, 10.5, 20.5, 48, 64]);
  });

  it("snaps a 48x64 frame that a creature box shrinks to 36x48", () => {
    const { canvas, calls } = recordingCanvas();
    new RenderSystem(canvas, {})._drawSpriteFrame(frame(48, 64), rect(10.5, 20.5, 36, 48));
    const [, , , , , dx, dy] = drawOf(calls);
    expect(Number.isInteger(dx) && Number.isInteger(dy)).toBe(true);
  });

  it("a mirrored frame lands on the same whole-pixel rect as the unmirrored one", () => {
    const plain = recordingCanvas();
    new RenderSystem(plain.canvas, {})._drawSpriteFrame(frame(96, 128), rect(615.29, 295.77, 48, 64));
    const [, , , , , dx, dy] = drawOf(plain.calls);

    const flipped = recordingCanvas();
    new RenderSystem(flipped.canvas, {})._drawSpriteFrame(frame(96, 128, true), rect(615.29, 295.77, 48, 64));
    const [cx] = flipped.calls.find((c) => c.op === "translate").args;
    const [, , , , , mx, my, mw] = drawOf(flipped.calls);
    // x maps to cx - x under translate(cx) scale(-1, 1): the draw spans
    // cx - (mx + mw) .. cx - mx on screen.
    expect(cx - (mx + mw)).toBe(dx);
    expect(cx - mx).toBe(dx + 48);
    expect(my).toBe(dy);
  });

  // Whole positions alone left a 96 -> 36 creature changing 10-29% of its
  // pixels: at 8/3 the sample centres land exactly on texel boundaries, where
  // float noise picks the texel. No sample may sit on a boundary.
  it.each([[96, 128, 36, 48], [96, 128, 48, 64], [48, 64, 36, 48]])(
    "%ix%i into %ix%i never samples on a texel boundary, in either direction",
    (sw, sh, dw, dh) => {
      for (const flipX of [false, true]) {
        const { canvas, calls } = recordingCanvas();
        new RenderSystem(canvas, {})._drawSpriteFrame(
          { img: {}, crop: [sw, sh, sw, sh], flipX }, rect(10.5, 20.5, dw, dh),
        );
        const [, sx, sy] = drawOf(calls);
        for (let i = 0; i < dw; i++) {
          const u = sx + ((i + 0.5) * sw) / dw;
          expect(Math.abs(u - Math.round(u))).toBeGreaterThan(1 / 128);
          expect(Math.floor(u)).toBeLessThan(sw * 2); // stays inside its own cell
        }
        for (let i = 0; i < dh; i++) {
          const v = sy + ((i + 0.5) * sh) / dh;
          expect(Math.abs(v - Math.round(v))).toBeGreaterThan(1 / 128);
          expect(Math.floor(v)).toBeLessThan(sh * 2);
        }
      }
    },
  );

  it("still lets Canvas drop a non-finite rect", () => {
    const { canvas, calls } = recordingCanvas();
    new RenderSystem(canvas, {})._drawSpriteFrame(frame(96, 128), rect(NaN, NaN, 48, 64));
    const [, , , , , dx, dy] = drawOf(calls);
    expect(Number.isNaN(dx) && Number.isNaN(dy)).toBe(true);
  });

  // The camera floors its offset, so the player's own figure only holds still
  // on screen if the snap rounds the opposite way. Math.round would step it by
  // a pixel twice per screen pixel walked.
  it("the followed player holds one screen position through a whole walk", () => {
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
      const player = { x: 1000 + i * 0.37, y: 2000 + i * 0.11, width: 48, height: 64 };
      const camera = new Camera();
      camera.update(player);
      const { canvas, calls } = recordingCanvas();
      const ctx = canvas.getContext();
      camera.apply(ctx);
      const [tx, ty] = calls.find((c) => c.op === "translate").args;

      const s = worldToScreen(player.x + 24, player.y + 32);
      const r = fitSpriteRect(96, 128, s.x - 24, s.y - 64, 48, 64);
      new RenderSystem(canvas, {})._drawSpriteFrame(frame(96, 128), r);
      const [, , , , , dx, dy] = drawOf(calls);
      seen.add(`${dx + tx},${dy + ty}`);
    }
    expect([...seen]).toEqual(["616,296"]);
  });
});

// SOMET-668. A walk frame whose body sits off its row's mean carries anchorDx
// (source px); the draw shifts it back, the other way when the frame is mirrored.
describe("a walk frame is re-anchored horizontally (SOMET-668)", () => {
  const frame = (w, h, extra) => ({ img: { width: w, height: h }, crop: [0, 0, w, h], flipX: false, ...extra });
  const rect = (dx, dy, dw, dh) => ({ dx, dy, dw, dh });
  const drawOf = (calls) => calls.find((c) => c.op === "drawImage").args;

  it("shifts a 1:1 frame by anchorDx", () => {
    const { canvas, calls } = recordingCanvas();
    new RenderSystem(canvas, {})._drawSpriteFrame(frame(48, 64, { anchorDx: 5.5 }), rect(100, 200, 48, 64));
    expect(drawOf(calls)[5]).toBe(105.5);
  });

  it("scales the shift with the drawn size and keeps it whole when downscaled", () => {
    const { canvas, calls } = recordingCanvas();
    new RenderSystem(canvas, {})._drawSpriteFrame(frame(96, 128, { anchorDx: 10 }), rect(100, 200, 48, 64));
    expect(drawOf(calls)[5]).toBe(105); // 10 * 48/96, integer start
  });

  it("shifts a mirrored frame the other way", () => {
    const plain = recordingCanvas();
    new RenderSystem(plain.canvas, {})._drawSpriteFrame(frame(48, 64, { anchorDx: 4 }), rect(100, 200, 48, 64));
    const flipped = recordingCanvas();
    new RenderSystem(flipped.canvas, {})._drawSpriteFrame(frame(48, 64, { anchorDx: 4, flipX: true }), rect(100, 200, 48, 64));
    const [cx] = flipped.calls.find((c) => c.op === "translate").args;
    const [, , , , , mx, , mw] = drawOf(flipped.calls);
    expect(cx - (mx + mw)).toBe(96); // 100 - 4
    expect(drawOf(plain.calls)[5]).toBe(104);
  });

  it("draws exactly as before when there is no anchorDx", () => {
    const { canvas, calls } = recordingCanvas();
    new RenderSystem(canvas, {})._drawSpriteFrame(frame(48, 64), rect(100.5, 200.5, 48, 64));
    expect(drawOf(calls).slice(1)).toEqual([0, 0, 48, 64, 100.5, 200.5, 48, 64]);
  });
});
