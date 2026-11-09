import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";

// Boss ground that stays (hazards), the countdown ring on marked players, and the green safe circle of
// a shelter: what is drawn, and that degenerate input never takes the render loop down.
function fakeCtx() {
  const calls = [];
  const ctx = {
    globalAlpha: 1, strokeStyle: null, fillStyle: null, lineWidth: 1, globalCompositeOperation: "source-over",
    imageSmoothingEnabled: false,
    save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {},
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, closePath: () => {},
    stroke: () => calls.push({ op: "stroke", style: ctx.strokeStyle }),
    fill: (rule) => calls.push({ op: "fill", style: ctx.fillStyle, rule }),
    ellipse: (x, y, rx, ry) => {
      if (rx < 0 || ry < 0) throw new Error("IndexSizeError: negative radius");
      calls.push({ op: "ellipse", rx, ry });
    },
    drawImage: () => calls.push({ op: "drawImage" }),
  };
  return { ctx, calls };
}
function renderer(ctx, over = {}) {
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = ctx;
  rs.vfxDefs = {};
  rs.imageManager = { get: () => null };
  Object.assign(rs, over);
  return rs;
}
const hz = (over = {}) => ({ id: "1", x: 100, y: 100, r: 150, inner: 0, element: "fire", v: null, ms: 5000, calm: false, ...over });
const ops = (calls, op) => calls.filter((c) => c.op === op);

describe("_drawHazards", () => {
  it("draws nothing for an empty list", () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx)._drawHazards([], 0);
    renderer(ctx)._drawHazards(null, 0);
    expect(calls).toEqual([]);
  });
  it("draws each pool as a filled and outlined disc", () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx)._drawHazards([hz(), hz({ id: "2", x: 400 })], 0);
    expect(ops(calls, "fill")).toHaveLength(2);
    expect(ops(calls, "stroke")).toHaveLength(2);
  });
  it("fills a ring with the even-odd rule so its hole stays clear, and draws the hole's ellipse", () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx)._drawHazards([hz({ r: 700, inner: 400 })], 0);
    expect(ops(calls, "fill")[0].rule).toBe("evenodd");
    expect(ops(calls, "ellipse")).toHaveLength(2);
  });
  it("draws ground that only slows in a cooler colour than ground that hurts", () => {
    const hurt = fakeCtx(); const calm = fakeCtx();
    renderer(hurt.ctx)._drawHazards([hz()], 0);
    renderer(calm.ctx)._drawHazards([hz({ calm: true })], 0);
    expect(ops(calm.calls, "fill")[0].style).toBe("#8fdcff");
    expect(ops(hurt.calls, "fill")[0].style).not.toBe("#8fdcff");
  });
  it("lays a loaded sprite over a pool, and falls back to the disc alone without one", () => {
    const sheet = { naturalWidth: 256, naturalHeight: 64 };
    const withArt = fakeCtx();
    renderer(withArt.ctx, {
      vfxDefs: { boss_lava_pools: { sprite_image: "vfx/a.png", sprite_frames: 4, duration_ms: 800 } },
      imageManager: { get: (k) => (k === "vfx:vfx/a.png" ? sheet : null) },
    })._drawHazards([hz({ v: "boss_lava_pools" })], 0);
    expect(ops(withArt.calls, "drawImage")).toHaveLength(1);
    const without = fakeCtx();
    renderer(without.ctx, { vfxDefs: { boss_lava_pools: { sprite_image: "vfx/a.png", sprite_frames: 4 } } })._drawHazards([hz({ v: "boss_lava_pools" })], 0);
    expect(ops(without.calls, "drawImage")).toHaveLength(0);
    expect(ops(without.calls, "fill")).toHaveLength(1);
  });
  it("skips a pool whose time has run out on the client clock", () => {
    const { ctx, calls } = fakeCtx();
    const rs = renderer(ctx);
    const longAgo = performance.now() - 60_000;
    rs._drawHazards([hz({ ms: 1000 })], longAgo);
    expect(calls).toEqual([]);
  });
  it("survives zero and negative sizes and NaN positions", () => {
    const { ctx } = fakeCtx();
    const rs = renderer(ctx);
    expect(() => rs._drawHazards([hz({ r: 0 }), hz({ x: NaN }), hz({ r: 10, inner: 99 })], 0)).not.toThrow();
  });
});

describe("_drawMarks", () => {
  const mark = (over = {}) => ({ userId: "7", radius: 170, ms: 1500, total: 3000, v: null, ...over });
  const actors = {
    player: { x: 100, y: 100, width: 64, height: 64 }, localUserId: "1",
    remotePlayers: new Map([["7", { x: 500, y: 500, width: 64, height: 64 }]]),
  };
  it("puts a ring and a fuse disc on a remote player", () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx)._drawMarks([mark()], actors);
    expect(ops(calls, "stroke")).toHaveLength(1);
    expect(ops(calls, "fill")).toHaveLength(1);
  });
  it("puts it on the local player too", () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx)._drawMarks([mark({ userId: "1" })], actors);
    expect(ops(calls, "stroke")).toHaveLength(1);
  });
  it("the fuse disc grows as the time runs down", () => {
    const early = fakeCtx(); const late = fakeCtx();
    renderer(early.ctx)._drawMarks([mark({ ms: 2900 })], actors);
    renderer(late.ctx)._drawMarks([mark({ ms: 100 })], actors);
    const fuse = (c) => ops(c.calls, "ellipse")[1].rx;
    expect(fuse(late)).toBeGreaterThan(fuse(early));
  });
  it("draws nothing for a player who is not in view, and survives junk", () => {
    const { ctx, calls } = fakeCtx();
    const rs = renderer(ctx);
    rs._drawMarks([mark({ userId: "999" })], actors);
    expect(calls).toEqual([]);
    expect(() => rs._drawMarks([mark({ radius: 0 }), mark({ ms: NaN })], actors)).not.toThrow();
    expect(() => rs._drawMarks(null, actors)).not.toThrow();
    expect(() => rs._drawMarks([mark()], {})).not.toThrow();
  });
});

describe("a shelter telegraph", () => {
  const t = (over = {}) => ({ x: 100, y: 100, radius: 150, ms: 1000, telegraphMs: 2600, v: "boss_meltdown", ...over });
  it("is a whole green circle from the first frame, not the growing red one", () => {
    const { ctx, calls } = fakeCtx();
    const rs = renderer(ctx);
    rs._drawTelegraphs([t({ safe: true })]);
    expect(ops(calls, "fill")[0].style).toBe("#34d399");
    const full = ops(calls, "ellipse")[0].rx;
    const early = fakeCtx();
    renderer(early.ctx)._drawTelegraphs([t({ safe: true, ms: 2590 })]);
    expect(ops(early.calls, "ellipse")[0].rx).toBe(full);
  });
  it("an ordinary telegraph is still the red circle", () => {
    const { ctx, calls } = fakeCtx();
    renderer(ctx)._drawTelegraphs([t()]);
    expect(ops(calls, "fill")[0].style).toBe("#ff4757");
  });
});
