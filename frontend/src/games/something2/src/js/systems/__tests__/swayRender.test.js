import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { swayShear, swayPhaseSeed } from "../sway.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

// Props v2: a static-image prop whose type has sway=true is sheared about its
// image's bottom-centre. The shear must COMPOSE with the camera transform
// (ctx.transform), never replace it (ctx.setTransform) -- the renderer draws
// world entities under a camera translate/scale.
function recordingCanvas() {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const ctx = {
    imageSmoothingEnabled: true, globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "",
    drawImage: rec("drawImage"), fillRect: rec("fillRect"), save: rec("save"), restore: rec("restore"),
    translate: rec("translate"), transform: rec("transform"), setTransform: rec("setTransform"),
    scale: rec("scale"), rotate: rec("rotate"),
    ellipse() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {},
    fillText() {}, strokeText() {},
  };
  return { canvas: { getContext: () => ctx }, calls };
}

const IMG = { width: 64, height: 140 };
const deco = (over = {}) => ({
  x: 6400, y: 6600, width: MAP_TILE_SIZE, height: MAP_TILE_SIZE,
  displayWidth: 64, displayHeight: 140, render_mode: "static", image: "sprites/pine/image.png", ...over,
});

describe("prop sway in the static image path", () => {
  it("shears a sway prop about its image's bottom-centre with a composed transform", () => {
    const { canvas, calls } = recordingCanvas();
    const rs = new RenderSystem(canvas, { get: (k) => (k === "sprites/pine/image.png" ? IMG : null) });
    rs.nowMs = 700;
    const e = deco({ sway: true });
    rs.drawEntity(e);

    expect(calls.some((c) => c.op === "setTransform")).toBe(false);
    const ops = calls.map((c) => c.op);
    const iDraw = ops.indexOf("drawImage");
    expect(iDraw).toBeGreaterThan(-1);
    // save, translate(base), transform(shear), translate(-base), drawImage, restore
    expect(ops.slice(iDraw - 4, iDraw + 2)).toEqual(["save", "translate", "transform", "translate", "drawImage", "restore"]);
    const [dx, dy, dw, dh] = calls[iDraw].args.slice(-4);
    const [tx, ty] = calls[iDraw - 3].args;
    expect(tx).toBeCloseTo(dx + dw / 2, 10);
    expect(ty).toBeCloseTo(dy + dh, 10);
    expect(calls[iDraw - 1].args).toEqual([-tx, -ty]);
    const k = swayShear(700, swayPhaseSeed(e.x, e.y));
    expect(k).not.toBe(0);
    expect(calls[iDraw - 2].args).toEqual([1, 0, k, 1, 0, 0]);
  });

  it("neighbouring sway props get different shears at the same instant", () => {
    const ks = [6400, 6500].map((x) => {
      const { canvas, calls } = recordingCanvas();
      const rs = new RenderSystem(canvas, { get: () => IMG });
      rs.nowMs = 700;
      rs.drawEntity(deco({ x, sway: true }));
      return calls.find((c) => c.op === "transform").args[2];
    });
    expect(ks[0]).not.toBeCloseTo(ks[1], 6);
  });

  it("a prop without sway draws with no transform at all", () => {
    for (const sway of [false, undefined]) {
      const { canvas, calls } = recordingCanvas();
      const rs = new RenderSystem(canvas, { get: () => IMG });
      rs.nowMs = 700;
      rs.drawEntity(deco({ sway }));
      expect(calls.some((c) => c.op === "drawImage")).toBe(true);
      expect(calls.some((c) => c.op === "transform" || c.op === "setTransform" || c.op === "translate")).toBe(false);
    }
  });

  it("collectDecorations carries the catalog's sway onto the drawable", () => {
    const chunkedMap = {
      chunkSize: 16,
      loadedKeys: () => ["0,0"],
      decorationsInChunk: () => [{ name: "Pine", col: 2, row: 3 }, { name: "Rock", col: 4, row: 5 }],
    };
    const decoTypes = new Map([
      ["Pine", { render_mode: "static", image: "p.png", sway: true }],
      ["Rock", { render_mode: "static", image: "r.png", sway: false }],
    ]);
    const out = RenderSystem.collectDecorations(chunkedMap, null, decoTypes);
    expect(out.find((d) => d.ref.name === "Pine").ref.sway).toBe(true);
    expect(out.find((d) => d.ref.name === "Rock").ref.sway).toBe(false);
  });
});
