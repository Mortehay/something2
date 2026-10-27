import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { blastScreenRadiusX } from "../../core/blasts.js";

// SOMET-608 (S6). _drawTelegraphs draws a creature skill's wind-up as a
// filled, growing ground ellipse -- "Browser: telegraph visible before a
// slam lands" is this ticket's own acceptance line. Recorded the same way
// auraRender.test.js records RenderSystem's other ground-ring methods.
function setup() {
  const calls = [];
  const ctx = {
    globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1,
    ellipse: (...args) => calls.push({ op: "ellipse", args, color: ctx.fillStyle, alpha: ctx.globalAlpha }),
    stroke: () => calls.push({ op: "stroke", color: ctx.strokeStyle, alpha: ctx.globalAlpha }),
    fill: () => calls.push({ op: "fill", color: ctx.fillStyle, alpha: ctx.globalAlpha }),
    save() {}, restore() {}, beginPath() {},
  };
  const rs = new RenderSystem({ getContext: () => ctx }, { get: () => null });
  return { rs, calls };
}

const telegraph = (over = {}) => ({ creatureId: "c:1", skill: "Ground Slam", x: 0, y: 0, radius: 80, ms: 250, telegraphMs: 500, ...over });

describe("skill telegraph rendering (SOMET-608)", () => {
  it("empty/missing list draws nothing, never throws", () => {
    const { rs, calls } = setup();
    expect(() => rs._drawTelegraphs([])).not.toThrow();
    expect(() => rs._drawTelegraphs(null)).not.toThrow();
    expect(calls.length).toBe(0);
  });

  it("a telegraph just starting draws at its minimum (30%) fill size", () => {
    const { rs, calls } = setup();
    rs._drawTelegraphs([telegraph({ ms: 500, telegraphMs: 500 })]); // progress 0
    const ring = calls.find((c) => c.op === "ellipse");
    expect(ring).toBeTruthy();
    const [, , rx] = ring.args;
    expect(rx).toBeCloseTo(blastScreenRadiusX(80) * 0.3, 3);
  });

  it("a telegraph about to land draws at full fill size, more opaque than at the start", () => {
    const { rs, calls } = setup();
    rs._drawTelegraphs([telegraph({ ms: 0, telegraphMs: 500 })]); // progress 1
    const ring = calls.find((c) => c.op === "ellipse");
    const [, , rx] = ring.args;
    expect(rx).toBeCloseTo(blastScreenRadiusX(80), 3);
    const fillAtEnd = calls.find((c) => c.op === "fill").alpha;

    const { rs: rs2, calls: calls2 } = setup();
    rs2._drawTelegraphs([telegraph({ ms: 500, telegraphMs: 500 })]); // progress 0
    const fillAtStart = calls2.find((c) => c.op === "fill").alpha;
    expect(fillAtEnd).toBeGreaterThan(fillAtStart);
  });

  it("fills AND strokes -- a stroked outline alone would read as a boundary marker, not a threat", () => {
    const { rs, calls } = setup();
    rs._drawTelegraphs([telegraph()]);
    expect(calls.some((c) => c.op === "fill")).toBe(true);
    expect(calls.some((c) => c.op === "stroke")).toBe(true);
  });

  it("a non-finite or zero/negative radius is skipped, never a throw", () => {
    const { rs, calls } = setup();
    expect(() => rs._drawTelegraphs([
      telegraph({ radius: NaN }), telegraph({ radius: 0 }), telegraph({ radius: -80 }),
    ])).not.toThrow();
    expect(calls.length).toBe(0);
  });

  it("draws one entry per telegraph in a mixed list", () => {
    const { rs, calls } = setup();
    rs._drawTelegraphs([telegraph(), telegraph({ x: 100 }), telegraph({ x: 200 })]);
    expect(calls.filter((c) => c.op === "ellipse").length).toBe(3);
  });

  // SOMET-610 (S7): the skill's own vfx.telegraph binding tints the fill --
  // the hardcoded red stays the fallback for every un-bound skill, not the
  // only color there ever was.
  it("tints fill AND stroke with the bound vfx's color when `v` resolves in vfxDefs", () => {
    const { rs, calls } = setup();
    rs.vfxDefs = { fireball_blast: { color: "#ff6b35" } };
    rs._drawTelegraphs([telegraph({ v: "fireball_blast" })]);
    expect(calls.find((c) => c.op === "fill").color).toBe("#ff6b35");
    expect(calls.find((c) => c.op === "stroke").color).toBe("#ff6b35");
  });

  it("falls back to the hardcoded red when `v` is null, unresolved, or vfxDefs isn't loaded", () => {
    for (const { v, vfxDefs } of [
      { v: null, vfxDefs: { fireball_blast: { color: "#ff6b35" } } },
      { v: "nonexistent_effect", vfxDefs: { fireball_blast: { color: "#ff6b35" } } },
      { v: "fireball_blast", vfxDefs: undefined },
    ]) {
      const { rs, calls } = setup();
      if (vfxDefs) rs.vfxDefs = vfxDefs;
      rs._drawTelegraphs([telegraph({ v })]);
      expect(calls.find((c) => c.op === "fill").color).toBe("#ff4757");
    }
  });
});
