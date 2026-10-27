import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { swayShear, swayPhaseSeed } from "../sway.js";
import { shineBand, SHINE_PERIOD_MS, SHINE_BAND_FRACTION } from "../shine.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

// Props v2: a static-image prop whose type has idle_fx 'sway' is sheared about its
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
    const e = deco({ idle_fx: "sway" });
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
      rs.drawEntity(deco({ x, idle_fx: "sway" }));
      return calls.find((c) => c.op === "transform").args[2];
    });
    expect(ks[0]).not.toBeCloseTo(ks[1], 6);
  });

  it("a prop without sway draws with no transform at all", () => {
    for (const idle_fx of ["none", undefined, "bogus"]) {
      const { canvas, calls } = recordingCanvas();
      const rs = new RenderSystem(canvas, { get: () => IMG });
      rs.nowMs = 700;
      rs.drawEntity(deco({ idle_fx }));
      expect(calls.some((c) => c.op === "drawImage")).toBe(true);
      expect(calls.some((c) => c.op === "transform" || c.op === "setTransform" || c.op === "translate")).toBe(false);
    }
  });

  it("collectDecorations carries the catalog's idle_fx onto the drawable", () => {
    const chunkedMap = {
      chunkSize: 16,
      loadedKeys: () => ["0,0"],
      decorationsInChunk: () => [{ name: "Pine", col: 2, row: 3 }, { name: "Rock", col: 4, row: 5 }],
    };
    const decoTypes = new Map([
      ["Pine", { render_mode: "static", image: "p.png", idle_fx: "sway" }],
      ["Rock", { render_mode: "static", image: "r.png", idle_fx: "shine" }],
    ]);
    const out = RenderSystem.collectDecorations(chunkedMap, null, decoTypes);
    expect(out.find((d) => d.ref.name === "Pine").ref.idle_fx).toBe("sway");
    expect(out.find((d) => d.ref.name === "Rock").ref.idle_fx).toBe("shine");
  });
});

// Props v2 'shine': the image draws normally; ONLY while the band is on screen
// a second pass composites a gradient band masked to the sprite's opaque
// pixels ('source-in' on a reused scratch canvas) onto the scene with
// 'lighter' at alpha <= 0.45. Idle frames cost nothing extra.
function stateCanvas(label, log) {
  const stack = [];
  const state = { globalCompositeOperation: "source-over", globalAlpha: 1, fillStyle: "", imageSmoothingEnabled: true };
  const rec = (op) => (...args) => log.push({ on: label, op, args });
  const ctx = {
    strokeStyle: "", lineWidth: 1, font: "", textAlign: "",
    // Records the smoothing in force at each draw (a fresh canvas defaults to true).
    drawImage: (...args) => log.push({ on: label, op: "drawImage", args, smooth: state.imageSmoothingEnabled }), fillRect: rec("fillRect"), clearRect: rec("clearRect"),
    translate: rec("translate"), transform: rec("transform"), setTransform: rec("setTransform"),
    scale: rec("scale"), rotate: rec("rotate"),
    save: (...a) => { stack.push({ ...state }); rec("save")(...a); },
    restore: (...a) => { Object.assign(state, stack.pop() || {}); rec("restore")(...a); },
    createLinearGradient: (...args) => {
      log.push({ on: label, op: "createLinearGradient", args });
      return { stops: [], addColorStop(o, c) { this.stops.push([o, c]); } };
    },
    ellipse() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {},
    fillText() {}, strokeText() {},
  };
  for (const k of Object.keys(state)) {
    Object.defineProperty(ctx, k, {
      get: () => state[k],
      set: (v) => { state[k] = v; log.push({ on: label, op: `set:${k}`, args: [v] }); },
    });
  }
  return { canvas: { getContext: () => ctx }, ctx };
}

function shineRig() {
  const log = [];
  const main = stateCanvas("main", log);
  const rs = new RenderSystem(main.canvas, { get: () => IMG });
  const made = [];
  rs.createCanvas = (w, h) => {
    const c = stateCanvas(`off${made.length}`, log);
    const canvas = { width: w, height: h, getContext: () => c.ctx, label: `off${made.length}` };
    made.push(canvas);
    return canvas;
  };
  return { rs, log, main, made };
}

const SEED = swayPhaseSeed(6400, 6600);
const timeWhere = (pred) => {
  for (let ms = 0; ms < SHINE_PERIOD_MS; ms += 1) if (pred(shineBand(ms, SEED))) return ms;
  throw new Error("no such time");
};

describe("prop shine in the static image path", () => {
  it("an idle frame draws only the image: no offscreen canvas, no composite change", () => {
    const { rs, log, made } = shineRig();
    rs.nowMs = timeWhere((b) => b === null);
    rs.drawEntity(deco({ idle_fx: "shine" }));
    expect(made).toHaveLength(0);
    const main = log.filter((c) => c.on === "main");
    expect(main.filter((c) => c.op === "drawImage")).toHaveLength(1);
    expect(main.some((c) => c.op.startsWith("set:globalCompositeOperation"))).toBe(false);
  });

  it("mid-sweep: image, then a masked band composited 'lighter' at alpha <= 0.45, state restored", () => {
    const { rs, log, main, made } = shineRig();
    rs.nowMs = timeWhere((b) => b && b.t > 0.45 && b.t < 0.55);
    rs.drawEntity(deco({ idle_fx: "shine" }));

    expect(log.some((c) => c.op === "setTransform")).toBe(false);
    const mainOps = log.filter((c) => c.on === "main");
    const draws = mainOps.filter((c) => c.op === "drawImage");
    expect(draws).toHaveLength(2);
    expect(draws[0].args[0]).toBe(IMG);
    const [dx, dy, dw, dh] = draws[0].args.slice(-4);

    // The glint pass: save, 'lighter', alpha, drawImage(scratch -> same rect), restore.
    const iSecond = mainOps.indexOf(draws[1]);
    const between = mainOps.slice(mainOps.indexOf(draws[0]) + 1, iSecond + 2).map((c) => c.op);
    expect(between[0]).toBe("save");
    expect(between).toContain("set:globalCompositeOperation");
    expect(between[between.length - 1]).toBe("restore");
    const gco = mainOps.find((c) => c.op === "set:globalCompositeOperation").args[0];
    expect(["lighter", "screen"]).toContain(gco);
    const alpha = mainOps.find((c) => c.op === "set:globalAlpha").args[0];
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThanOrEqual(0.45);
    const scratch = draws[1].args[0];
    expect(made).toContain(scratch);
    expect(draws[1].args.slice(-4)).toEqual([dx, dy, dw, dh]);
    expect(main.ctx.globalCompositeOperation).toBe("source-over");
    expect(main.ctx.globalAlpha).toBe(1);

    // On the scratch: clear, draw the cached mask, 'source-in', fill the band, back to source-over.
    const s = log.filter((c) => c.on === scratch.label).map((c) => c.op);
    const iMask = s.indexOf("drawImage");
    expect(s.indexOf("clearRect")).toBeLessThan(iMask);
    const iIn = log.findIndex((c) => c.on === scratch.label && c.op === "set:globalCompositeOperation" && c.args[0] === "source-in");
    const iFill = log.findIndex((c) => c.on === scratch.label && c.op === "fillRect");
    const iMaskAbs = log.findIndex((c) => c.on === scratch.label && c.op === "drawImage");
    expect(iMaskAbs).toBeLessThan(iIn);
    expect(iIn).toBeLessThan(iFill);
    expect(scratch.getContext().globalCompositeOperation).toBe("source-over");
    // The mask drawn is the cached per-(image,size) offscreen holding the image.
    const maskCanvas = log[iMaskAbs].args[0];
    expect(made).toContain(maskCanvas);
    expect(log.some((c) => c.on === maskCanvas.label && c.op === "drawImage" && c.args[0] === IMG)).toBe(true);
  });

  it("no per-frame allocation: many frames across sweeps build the mask and scratch once", () => {
    const { rs, made } = shineRig();
    const e = deco({ idle_fx: "shine" });
    for (let ms = 0; ms < 3 * SHINE_PERIOD_MS; ms += 16) {
      rs.nowMs = ms;
      rs.drawEntity(e);
    }
    expect(made).toHaveLength(2); // one mask (this image at this size) + one scratch (this size bucket)
  });

  it("the band position follows t", () => {
    const at = (pred) => {
      const { rs, log } = shineRig();
      rs.nowMs = timeWhere(pred);
      rs.drawEntity(deco({ idle_fx: "shine" }));
      return log.find((c) => c.op === "createLinearGradient").args[0];
    };
    expect(at((b) => b && b.t < 0.1)).toBeLessThan(at((b) => b && b.t > 0.9));
  });

  it("mask and scratch draw with smoothing off, the glint pass with the sprite's own smoothing", () => {
    const { rs, log, made } = shineRig();
    rs.nowMs = timeWhere((b) => b && b.t > 0.45 && b.t < 0.55);
    rs.drawEntity(deco({ idle_fx: "shine" }));
    const off = log.filter((c) => c.op === "drawImage" && c.on !== "main");
    expect(off.length).toBe(2); // the image onto the mask, the mask onto the scratch
    expect(made.map((m) => m.getContext().imageSmoothingEnabled)).toEqual([false, false]);
    for (const d of off) expect(d.smooth).toBe(false);
    const draws = log.filter((c) => c.on === "main" && c.op === "drawImage");
    expect(draws).toHaveLength(2);
    expect(draws[0].smooth).toBe(false); // RenderSystem's main ctx: nearest sampling
    expect(draws[1].smooth).toBe(draws[0].smooth);
  });

  it("an exception in the glint draw still restores composite and alpha", () => {
    const { rs, main } = shineRig();
    rs.nowMs = timeWhere((b) => b && b.t > 0.45 && b.t < 0.55);
    const real = main.ctx.drawImage;
    let n = 0;
    main.ctx.drawImage = (...a) => {
      n += 1;
      if (n === 2) throw new Error("boom");
      return real(...a);
    };
    expect(() => rs.drawEntity(deco({ idle_fx: "shine" }))).toThrow("boom");
    expect(main.ctx.globalCompositeOperation).toBe("source-over");
    expect(main.ctx.globalAlpha).toBe(1);
  });

  it("the band is a thin streak: SHINE_BAND_FRACTION of the sprite's diagonal extent", () => {
    expect(SHINE_BAND_FRACTION).toBeCloseTo(0.28, 10);
    const { rs, log } = shineRig();
    rs.nowMs = timeWhere((b) => b && b.t > 0.45 && b.t < 0.55);
    rs.drawEntity(deco({ idle_fx: "shine" }));
    const [x0, y0, x1, y1] = log.find((c) => c.op === "createLinearGradient").args;
    const draw = log.find((c) => c.on === "main" && c.op === "drawImage");
    const [, , dw, dh] = draw.args.slice(-4);
    const w = Math.ceil(dw);
    const h = Math.ceil(dh);
    // Along the 45-degree diagonal, in units of (x+y)/2: the band spans
    // (x1+y1)/2 - (x0+y0)/2 of the sprite's (w+h)/2.
    const width = (x1 + y1) / 2 - (x0 + y0) / 2;
    expect(width / ((w + h) / 2)).toBeCloseTo(0.28, 2);
  });
});
