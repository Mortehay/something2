import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { EntityAnimState } from "../entityAnimState.js";
import { resolveTileVisual } from "../spriteAtlas.js";
import { ALL_ANIMATIONS_ON, withAllAnimations } from "../../core/animationPrefs.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

// SOMET-768: each key of uiPrefs.animations switches one sprite-or-fallback
// branch of the renderer. Off means what the game drew before that sprite
// family existed -- never a hole.

const ACTIONS = ["idle", "walk", "attack", "cast", "damage"];
const DIRS = ["s", "se", "e", "ne", "n", "nw", "w", "sw"];
function boxSheet(actions = ACTIONS, dirs = DIRS, n = 4) {
  const rows = [];
  const frames = {};
  let row = 0;
  for (const action of actions) {
    for (const direction of dirs) {
      rows.push({ row, action, direction, frames: n });
      for (let i = 0; i < n; i += 1) frames[`${action}/${direction}/${i}`] = [i * 64, row * 64, 64, 64];
      row += 1;
    }
  }
  return { version: 1, cell: [64, 64], actions, frames_per_action: n, rows, frames };
}
const ATLAS = { width: 256, height: 2560 };
const imgs = { get: (k) => (k === "atlas" ? ATLAS : null) };
const creature = (manifest, over = {}) => ({
  id: 9, x: 1000, y: 1000, tx: 1000, ty: 1000, width: 48, height: 48, facing: "NE",
  render_mode: "static",
  sprite: { atlas_key: "atlas", manifest_key: "m", static_frame: "idle/s/0", manifest },
  ...over,
});
const keyOf = (m, crop) => Object.keys(m.frames).find((k) => m.frames[k] === crop) || null;

function recordingCanvas() {
  const calls = [];
  const rec = (op) => (...args) => calls.push({ op, args });
  const ctx = {
    imageSmoothingEnabled: false, imageSmoothingQuality: "low", globalAlpha: 1, globalCompositeOperation: "source-over",
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", shadowBlur: 0, shadowColor: "",
    drawImage: rec("drawImage"), fillRect: rec("fillRect"), save: rec("save"), restore: rec("restore"),
    translate: rec("translate"), transform: rec("transform"), setTransform: rec("setTransform"),
    scale: rec("scale"), rotate: rec("rotate"), ellipse: rec("ellipse"), arc: rec("arc"),
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, fill() {}, stroke() {}, clip() {},
    fillText: rec("fillText"), strokeText: rec("strokeText"), measureText: () => ({ width: 10 }),
    createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
  };
  return { canvas: { getContext: () => ctx }, calls, ctx };
}
const ops = (calls) => calls.map((c) => c.op);

describe("sheet actions (idle / walk / attack / ...)", () => {
  // Two observations 10 px apart make the actor "moving".
  function walking(animations) {
    const m = boxSheet();
    const anim = new EntityAnimState();
    const e = creature(m);
    RenderSystem.resolveSprite(e, imgs, "static", 0, anim, "c:9", animations);
    const moved = { ...e, x: 1010, tx: 1010 };
    const r = RenderSystem.resolveSprite(moved, imgs, "static", 100, anim, "c:9", animations);
    return { key: keyOf(m, r.crop), flipX: r.flipX, anim, m };
  }

  it("everything on: a moving actor walks (unchanged behaviour)", () => {
    expect(walking(ALL_ANIMATIONS_ON).key).toMatch(/^walk\/e\//);
    // the default parameter is the same
    const m = boxSheet();
    const anim = new EntityAnimState();
    const e = creature(m);
    RenderSystem.resolveSprite(e, imgs, "static", 0, anim, "c:9");
    const r = RenderSystem.resolveSprite({ ...e, x: 1010, tx: 1010 }, imgs, "static", 100, anim, "c:9");
    expect(keyOf(m, r.crop)).toMatch(/^walk\/e\//);
  });

  it("walk off: the idle row plays while the actor moves", () => {
    expect(walking({ ...ALL_ANIMATIONS_ON, walk: false }).key).toMatch(/^idle\/e\//);
  });

  it("walk and idle off: one idle frame is held, still facing the way the actor moves", () => {
    const off = withAllAnimations(false);
    const w = walking(off);
    expect(w.key).toBe("idle/e/0");
    // facing NE is screen e: the box's e row mirrored (SOMET-767) -- the flip survives
    expect(w.flipX).toBe(true);
    // ... and it stays on frame 0 whatever the clock says
    const later = RenderSystem.resolveSprite({ ...creature(w.m), x: 1020, tx: 1020 }, imgs, "static", 1375, w.anim, "c:9", off);
    expect(keyOf(w.m, later.crop)).toBe("idle/e/0");
  });

  it("attack off: a swing plays idle instead; attack on plays the attack row", () => {
    const m = boxSheet();
    const e = creature(m);
    for (const [animations, want] of [[ALL_ANIMATIONS_ON, /^attack\/e\//], [{ ...ALL_ANIMATIONS_ON, attack: false }, /^idle\/e\//]]) {
      const anim = new EntityAnimState();
      RenderSystem.resolveSprite(e, imgs, "static", 0, anim, "c:9", animations);
      anim.noteAttack("c:9", 1000, false);
      const r = RenderSystem.resolveSprite(e, imgs, "static", 1100, anim, "c:9", animations);
      expect(keyOf(m, r.crop)).toMatch(want);
    }
  });

  it("the instance methods hand the renderer's own choices to resolveSprite", () => {
    const { canvas, calls } = recordingCanvas();
    const rs = new RenderSystem(canvas, imgs);
    rs.entityAnim = new EntityAnimState();
    rs.animations = withAllAnimations(false);
    const m = boxSheet();
    const e = creature(m);
    rs.nowMs = 0;
    rs.drawEntity(e, "c:9");
    rs.nowMs = 100;
    rs.drawEntity({ ...e, x: 1010, tx: 1010 }, "c:9");
    const draws = calls.filter((c) => c.op === "drawImage" && c.args[0] === ATLAS);
    expect(draws.length).toBe(2);
    // both draws crop frame 0 of the idle/e row (x 0, the row's y)
    const rowY = m.frames["idle/e/0"][1];
    // (floor: a downscaled frame samples SOURCE_NUDGE texels in, see _drawSpriteFrame)
    for (const d of draws) expect(d.args.slice(1, 3).map(Math.floor)).toEqual([0, rowY]);
  });
});

describe("effect, aura and buff sheets", () => {
  const SHEET = { width: 128, height: 32 };
  const sheetImgs = { get: (k) => (k.startsWith("vfx:") ? SHEET : null) };

  it("vfx off: the vector shape is drawn, the sheet is not even consulted", () => {
    for (const on of [true, false]) {
      const { canvas } = recordingCanvas();
      const rs = new RenderSystem(canvas, sheetImgs);
      rs.animations = { ...ALL_ANIMATIONS_ON, vfx: on };
      let sprite = 0;
      let shape = 0;
      rs._drawVfxSprite = () => { sprite += 1; return true; };
      rs._drawVfxShape = () => { shape += 1; };
      rs._drawVfxParticles = () => {};
      rs.drawVfx([{ def: { shape: "burst", sprite_image: "s.png", sprite_frames: 4 }, x: 0, y: 0, startedAt: 0 }]);
      expect([sprite, shape]).toEqual(on ? [1, 0] : [0, 1]);
    }
  });

  it("auras off: the ring is drawn and the ground disc pass draws nothing", () => {
    const def = { sprite_image: "aura.png", sprite_frames: 4, radius: 100, color: "#fff" };
    for (const on of [true, false]) {
      const { canvas, calls } = recordingCanvas();
      const rs = new RenderSystem(canvas, sheetImgs);
      rs.auraDefs = { chill: def };
      rs.animations = { ...ALL_ANIMATIONS_ON, auras: on };
      rs.nowMs = 100;
      rs._drawAuraEffects(50, 50, ["chill"]);
      const rings = ops(calls).filter((o) => o === "ellipse").length;
      rs._drawSpriteAuraGround([{ x: 1000, y: 1000, width: 48, height: 48, auras: ["chill"] }]);
      const discs = calls.filter((c) => c.op === "drawImage" && c.args[0] === SHEET).length;
      expect({ rings: rings > 0, discs }).toEqual(on ? { rings: false, discs: 1 } : { rings: true, discs: 0 });
    }
  });

  it("buffs off: no buff or status sheet resolves, so every caller takes its drawn fallback", () => {
    const { canvas } = recordingCanvas();
    const rs = new RenderSystem(canvas, sheetImgs);
    const v = { sprite_image: "haste.png", sprite_frames: 4 };
    expect(rs._buffSheet(v)).not.toBeNull();
    rs.animations = { ...ALL_ANIMATIONS_ON, buffs: false };
    expect(rs._buffSheet(v)).toBeNull();
    rs.animations = ALL_ANIMATIONS_ON;
    expect(rs._buffSheet(v)).not.toBeNull();
  });
});

describe("world: props and tiles", () => {
  const IMG = { width: 64, height: 140 };
  const deco = (over = {}) => ({
    x: 6400, y: 6600, width: MAP_TILE_SIZE, height: MAP_TILE_SIZE,
    displayWidth: 64, displayHeight: 140, render_mode: "static", image: "sprites/pine/image.png", ...over,
  });

  it("prop motion off: a sway prop is drawn still, with no shear transform", () => {
    for (const on of [true, false]) {
      const { canvas, calls } = recordingCanvas();
      const rs = new RenderSystem(canvas, { get: (k) => (k === "sprites/pine/image.png" ? IMG : null) });
      rs.nowMs = 700;
      rs.animations = { ...ALL_ANIMATIONS_ON, props: on };
      rs.drawEntity(deco({ idle_fx: "sway" }));
      expect(ops(calls).includes("transform")).toBe(on);
      expect(ops(calls).filter((o) => o === "drawImage").length).toBe(1);
    }
  });

  it("prop motion off: a shine prop gets no glint pass", () => {
    const { canvas } = recordingCanvas();
    const rs = new RenderSystem(canvas, { get: () => IMG });
    rs.nowMs = 700;
    let shines = 0;
    rs._drawShine = () => { shines += 1; };
    rs.drawEntity(deco({ idle_fx: "shine" }));
    rs.animations = { ...ALL_ANIMATIONS_ON, props: false };
    rs.drawEntity(deco({ idle_fx: "shine" }));
    expect(shines).toBe(1);
  });

  it("tile animation off: an animated tile resolves to its still image", () => {
    const atlas = { width: 64, height: 16 };
    const still = { width: 16, height: 16 };
    const im = { get: (k) => (k === "tiles/water-atlas.png" ? atlas : k === "tiles/water.png" ? still : null) };
    const def = {
      render_mode: "animated", image: "tiles/water.png",
      sprite: { atlas_key: "tiles/water-atlas.png" },
      _manifest: { cell: [16, 16], frames: { 0: [0, 0, 16, 16], 1: [16, 0, 16, 16] } },
    };
    expect(resolveTileVisual("water", def, im, 0).img).toBe(atlas);
    // the renderer passes "image" as the override while tiles are off
    expect(resolveTileVisual("water", def, im, 0, "image").img).toBe(still);
  });
});
