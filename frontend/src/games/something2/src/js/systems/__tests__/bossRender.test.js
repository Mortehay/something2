import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";

// Records drawImage/fillRect/fillText; implements only what drawEntity's boss
// and ordinary paths touch. _drawWorldBoss (the procedural body) is replaced
// per test with a recorder: what is under test is WHICH path runs.
function setup(images = {}) {
  const calls = [];
  const ctx = {
    imageSmoothingEnabled: true, globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1,
    font: "", textAlign: "", shadowColor: "", shadowBlur: 0,
    drawImage: (...args) => calls.push({ op: "drawImage", args }),
    fillRect: (...args) => calls.push({ op: "fillRect", args }),
    fillText: (text) => calls.push({ op: "fillText", text }),
    strokeText() {}, save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {},
    lineTo() {}, arc() {}, ellipse() {}, fill() {}, stroke() {},
  };
  const rs = new RenderSystem({ getContext: () => ctx }, { get: (k) => images[k] || null });
  const procedural = [];
  rs._drawWorldBoss = (e) => procedural.push(e.element);
  return { rs, calls, procedural };
}

const boss = (over = {}) => ({
  id: "b", type: "zzBoss", name: "zzBoss", bossTier: "world", element: "fire",
  x: 0, y: 0, width: 96, height: 96, hp: 10, maxHp: 10, ...over,
});

describe("boss rendering (SOMET-603)", () => {
  it("a boss with no art draws the procedural body, keyed on its element", () => {
    const { rs, procedural, calls } = setup();
    rs.drawEntity(boss({ element: "ice" }));
    expect(procedural).toEqual(["ice"]);
    expect(calls.some((c) => c.op === "fillText" && c.text.includes("[WORLD BOSS] zzBoss"))).toBe(true);
  });

  it("a boss with approved, loaded art draws it at display size and skips the procedural body", () => {
    const { rs, procedural, calls } = setup({ "img/boss.png": { width: 192, height: 192 } });
    rs.drawEntity(boss({ render_mode: "static", image: "img/boss.png", displayWidth: 160, displayHeight: 160 }));
    expect(procedural).toEqual([]);
    const img = calls.find((c) => c.op === "drawImage");
    expect(img).toBeTruthy();
    const [, , , dw, dh] = img.args;
    expect(dw).toBe(160);
    expect(dh).toBe(160);
    expect(Number.isFinite(img.args[1]) && Number.isFinite(img.args[2])).toBe(true);
    expect(calls.some((c) => c.op === "fillText" && c.text.includes("[WORLD BOSS] zzBoss"))).toBe(true);
  });

  // Review Focus 4.
  it("art approved but the image failed to load falls back to the procedural body", () => {
    const { rs, procedural, calls } = setup({});
    rs.drawEntity(boss({ render_mode: "static", image: "img/missing.png", displayWidth: 160, displayHeight: 160 }));
    expect(procedural).toEqual(["fire"]);
    expect(calls.some((c) => c.op === "drawImage")).toBe(false);
  });

  it("a dungeon-tier boss gets the generic boss plate", () => {
    const { rs, calls } = setup();
    rs.drawEntity(boss({ bossTier: "dungeon_end", name: "zzEnd Boss" }));
    expect(calls.some((c) => c.op === "fillText" && c.text.includes("[BOSS] zzEnd Boss"))).toBe(true);
  });

  it("an untiered creature whose name sounds like a boss is NOT drawn as one", () => {
    const { rs, procedural } = setup();
    rs.drawEntity({ id: "t", type: "Gorgon, the Thunder Titan", name: "Gorgon, the Thunder Titan",
      x: 0, y: 0, width: 48, height: 48, color: "#888" });
    expect(procedural).toEqual([]);
  });

  it("a boss with no size anywhere still draws with finite dimensions", () => {
    const { rs, calls } = setup({ "img/boss.png": { width: 64, height: 64 } });
    rs.drawEntity(boss({ width: undefined, height: undefined, render_mode: "static", image: "img/boss.png" }));
    const img = calls.find((c) => c.op === "drawImage");
    expect(img.args.slice(1).every(Number.isFinite)).toBe(true);
  });

  it("bossPalette keys on element and defaults to fire", () => {
    expect(RenderSystem.bossPalette("ice").baseColor).toBe("#70a1ff");
    expect(RenderSystem.bossPalette(undefined).baseColor).toBe("#ff4757");
    expect(RenderSystem.bossPalette("void").baseColor).toBe(RenderSystem.bossPalette("arcane").baseColor);
  });
});
