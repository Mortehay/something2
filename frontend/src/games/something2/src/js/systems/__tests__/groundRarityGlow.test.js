import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { drawInventory, layoutInventory } from "../inventoryPanel.js";
import { RARITY_COLORS, rarityGlowColor, withAlpha } from "../../core/rarityColors.js";

// SOMET-490 -- a dropped item's grade is drawn as a coloured pool of light
// UNDER the item marker.
//
// The four ways this ships looking fine and being wrong, each pinned below:
//   1. the halo drawn OVER the item, or drawn by replacing the canvas
//      transform instead of composing into it (the wall-side bug);
//   2. a second palette that drifts from the inventory panel's, so the ground
//      contradicts the tooltip;
//   3. a white item glowing, which makes every drop look notable;
//   4. a pre-rarity item rendering differently than it used to.

// A context stub that records the ORDER of everything, including transform
// ops, because "which was drawn first" is the assertion that separates a glow
// under the item from a glow over it.
function stubCtx() {
  const ops = [];
  const ctx = {
    ops,
    _fillStyle: null,
    save() { ops.push({ op: "save" }); },
    restore() { ops.push({ op: "restore" }); },
    translate(x, y) { ops.push({ op: "translate", x, y }); },
    scale(x, y) { ops.push({ op: "scale", x, y }); },
    // Present so a mutation that reaches for them is a recorded op rather
    // than a TypeError that could be mistaken for an unrelated crash.
    setTransform(...a) { ops.push({ op: "setTransform", a }); },
    resetTransform() { ops.push({ op: "resetTransform" }); },
    createRadialGradient(x0, y0, r0, x1, y1, r1) {
      const grad = { kind: "gradient", r1, stops: [], addColorStop(o, c) { this.stops.push({ o, c }); } };
      ops.push({ op: "createRadialGradient", x0, y0, r0, x1, y1, r1, grad });
      return grad;
    },
    beginPath() { ops.push({ op: "beginPath" }); },
    moveTo() {}, lineTo() {}, closePath() {},
    arc(x, y, r) { ops.push({ op: "arc", x, y, r }); },
    fill() { ops.push({ op: "fill", style: ctx._fillStyle }); },
    stroke() { ops.push({ op: "stroke", style: ctx._strokeStyle }); },
    fillRect() {},
    // Recorded WITH its colour: the inventory grid outlines a cell with
    // strokeRect, not stroke(), so a stub that swallowed this would make the
    // shared-palette assertion below unable to see anything at all.
    strokeRect() { ops.push({ op: "strokeRect", style: ctx._strokeStyle }); },
    fillText(text) { ops.push({ op: "fillText", text }); },
    drawImage() {},
    set fillStyle(v) { ctx._fillStyle = v; },
    get fillStyle() { return ctx._fillStyle; },
    set strokeStyle(v) { ctx._strokeStyle = v; },
    get strokeStyle() { return ctx._strokeStyle; },
    set lineWidth(_v) {}, set font(_v) {},
    set textAlign(_v) {}, set textBaseline(_v) {}, set globalAlpha(_v) {},
  };
  return ctx;
}

function drawItem(rarity) {
  const ctx = stubCtx();
  const rs = new RenderSystem({ getContext: () => ctx }, null);
  rs.drawGroundItem({ id: "g1", typeId: 7, x: 400, y: 400, width: 24, height: 24, rarity }, null, null);
  return ctx;
}

// The item marker's own fill: the diamond, whose colour is the pre-existing
// category tint and has nothing to do with rarity.
const ITEM_BODY_FILL = "#e3c27e";
const fills = (ctx) => ctx.ops.filter((o) => o.op === "fill");
const gradients = (ctx) => ctx.ops.filter((o) => o.op === "createRadialGradient");

describe("ground item rarity glow", () => {
  it("draws a foxy item's halo BENEATH the item marker", () => {
    const ctx = drawItem("foxy");
    const f = fills(ctx);
    expect(f.length).toBe(2); // halo, then the diamond
    // The halo is a gradient object, the body is the flat category colour.
    expect(f[0].style).toEqual(expect.objectContaining({ kind: "gradient" }));
    expect(f[1].style).toBe(ITEM_BODY_FILL);
  });

  it("composes the transform instead of replacing it, and leaves it balanced", () => {
    const ctx = drawItem("foxy");
    // setTransform/resetTransform DISCARD the camera transform already on the
    // stack. The wall-side pass did exactly that once and silently dropped
    // everything drawn before it; nothing in this path may do it again.
    expect(ctx.ops.some((o) => o.op === "setTransform" || o.op === "resetTransform")).toBe(false);
    expect(ctx.ops.some((o) => o.op === "translate")).toBe(true);
    expect(ctx.ops.some((o) => o.op === "scale")).toBe(true);
    // Every translate/scale sits strictly inside a save/restore pair, so the
    // next drawable in the depth sort inherits an untouched transform.
    const t = ctx.ops.findIndex((o) => o.op === "translate");
    const saveBefore = ctx.ops.slice(0, t).filter((o) => o.op === "save").length;
    const restoreBefore = ctx.ops.slice(0, t).filter((o) => o.op === "restore").length;
    expect(saveBefore - restoreBefore).toBeGreaterThanOrEqual(1);
    const saves = ctx.ops.filter((o) => o.op === "save").length;
    const restores = ctx.ops.filter((o) => o.op === "restore").length;
    expect(saves).toBe(restores);
    // The last transform op is undone before the item body is filled: the
    // diamond must land at its real screen position, not inside the halo's
    // squashed space.
    const lastTransform = Math.max(
      ctx.ops.findIndex((o) => o.op === "scale"),
      ctx.ops.findIndex((o) => o.op === "translate"),
    );
    const bodyFill = ctx.ops.findIndex((o) => o.op === "fill" && o.style === ITEM_BODY_FILL);
    const restoreIdx = ctx.ops.findIndex((o, i) => o.op === "restore" && i > lastTransform);
    expect(restoreIdx).toBeGreaterThan(lastTransform);
    expect(restoreIdx).toBeLessThan(bodyFill);
  });

  it("colours the halo from the shared palette, blue/yellow/foxy all distinct", () => {
    const stopColor = (rarity) => gradients(drawItem(rarity))[0].grad.stops[0].c;
    expect(stopColor("blue")).toBe(withAlpha(RARITY_COLORS.blue, 0.55));
    expect(stopColor("yellow")).toBe(withAlpha(RARITY_COLORS.yellow, 0.55));
    expect(stopColor("foxy")).toBe(withAlpha(RARITY_COLORS.foxy, 0.55));
    expect(new Set([stopColor("blue"), stopColor("yellow"), stopColor("foxy")]).size).toBe(3);
  });

  it("fades the halo to fully transparent at its rim, so it reads as light not a disc", () => {
    const grad = gradients(drawItem("foxy"))[0].grad;
    expect(grad.stops.map((s) => s.o)).toEqual([0, 1]);
    expect(grad.stops[1].c).toBe(withAlpha(RARITY_COLORS.foxy, 0));
  });

  it("gives a WHITE item no halo at all — otherwise every drop looks notable", () => {
    const ctx = drawItem("white");
    expect(gradients(ctx).length).toBe(0);
    expect(fills(ctx).map((f) => f.style)).toEqual([ITEM_BODY_FILL]);
  });

  it("renders a pre-rarity item exactly as it did before the feature existed", () => {
    // AC4. `undefined` (an item whose row predates SOMET-480) and an
    // unrecognised grade must both draw the same ops as a plain white one.
    const shape = (ctx) => ctx.ops.map((o) => `${o.op}:${o.op === "fill" ? o.style : ""}`);
    expect(shape(drawItem(undefined))).toEqual(shape(drawItem("white")));
    expect(shape(drawItem("legendary"))).toEqual(shape(drawItem("white")));
  });

  it("a foxy item and a white one differ in what is actually painted", () => {
    // The criterion in one line: whatever else is true, these two must not
    // produce identical canvas output.
    const white = drawItem("white").ops.map((o) => JSON.stringify(o.op === "fill" ? o.style : o.op));
    const foxy = drawItem("foxy").ops.map((o) => JSON.stringify(o.op === "fill" ? o.style : o.op));
    expect(foxy).not.toEqual(white);
  });
});

describe("one palette, two consumers", () => {
  it("the inventory panel borders a graded cell in the SAME colour the glow uses", () => {
    // The whole reason rarityColors.js exists. If these ever came from two
    // maps, the ground would say foxy while the panel said blue, and a player
    // trusts the world over the menu.
    const inventory = {
      types: new Map([[7, { id: 7, name: "Sword", category: "weapon" }]]),
      items: [{ id: "i1", typeId: 7, quantity: 1, rarity: "foxy" }],
      equipment: {},
      ammoCounts: new Map(),
    };
    const layout = layoutInventory({ inventory, page: 0 });
    const ctx = stubCtx();
    drawInventory(ctx, layout, {});
    const strokes = ctx.ops.filter((o) => o.op === "strokeRect").map((o) => o.style);
    // Guard against the probe reading a field that is simply always empty --
    // a stub whose strokeRect recorded nothing would pass a `not.toContain`
    // assertion below while proving nothing at all.
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes).toContain(RARITY_COLORS.foxy);
    expect(RARITY_COLORS.foxy).toBe(rarityGlowColor("foxy"));
  });

  it("a white item's cell keeps the neutral border, so nothing looks graded that isn't", () => {
    const inventory = {
      types: new Map([[7, { id: 7, name: "Sword", category: "weapon" }]]),
      items: [{ id: "i1", typeId: 7, quantity: 1, rarity: "white" }],
      equipment: {},
      ammoCounts: new Map(),
    };
    const ctx = stubCtx();
    drawInventory(ctx, layoutInventory({ inventory, page: 0 }), {});
    const strokes = ctx.ops.filter((o) => o.op === "strokeRect").map((o) => o.style);
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes).not.toContain(RARITY_COLORS.white);
    expect(strokes).not.toContain(RARITY_COLORS.foxy);
  });
});
