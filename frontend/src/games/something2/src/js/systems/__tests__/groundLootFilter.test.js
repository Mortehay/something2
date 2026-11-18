import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { defaultFilterConfig } from "../../core/lootFilter.js";

// A ground item is drawn through the loot filter: a hide rule skips it (unless the show-all key is
// held, then it is dimmed), Emphasize always draws the name plate, and a rule's colours, size and
// beam show up in the draw calls. With no rules it must look exactly as it did before.

function stubCtx() {
  const log = { texts: [], fills: [], rects: [], alphas: [], fonts: [], gradients: 0, diamonds: 0 };
  const ctx = {
    log,
    save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, arc() {}, stroke() {},
    moveTo() { }, lineTo() { }, closePath() { log.diamonds += 0; },
    createRadialGradient() { return { addColorStop() {} }; },
    createLinearGradient() { log.gradients += 1; return { addColorStop() {} }; },
    measureText: (s) => ({ width: String(s).length * 6 }),
    fill() { log.fills.push(ctx._fillStyle); },
    fillRect(x, y, w, h) { log.rects.push({ x, y, w, h, style: ctx._fillStyle }); },
    fillText(text) { log.texts.push({ text, style: ctx._fillStyle, font: ctx._font }); },
    set fillStyle(v) { ctx._fillStyle = v; }, get fillStyle() { return ctx._fillStyle; },
    set strokeStyle(_v) {}, set lineWidth(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {},
    set font(v) { ctx._font = v; log.fonts.push(v); },
    set globalAlpha(v) { log.alphas.push(v); },
  };
  return ctx;
}

const TYPES = new Map([[7, { id: 7, name: "Iron Sword", category: "weapon" }]]);
const inventory = { types: TYPES };
const FAR = { x: 99999, y: 99999, width: 64, height: 64 }; // nowhere near the item

function rule(over) {
  return {
    id: "r", name: "r", enabled: true, action: "emphasize",
    conditions: { rarities: [], categories: [], typeIds: [], minLevel: null, maxLevel: null, affixIds: [], affixMode: "any", ...(over.conditions || {}) },
    style: { textColor: null, bgColor: null, fontSize: null, beam: false, beamColor: null, ...(over.style || {}) },
    ...(over.top || {}),
  };
}

function draw({ rules = null, showAll = false, rarity = "white", player = FAR, itemLevel = 1, affixIds = [] } = {}) {
  const ctx = stubCtx();
  const rs = new RenderSystem({ getContext: () => ctx }, null);
  const config = defaultFilterConfig();
  if (rules) config.presets[0].rules = rules;
  rs._lootFilter = { config, version: 1, affixes: [] };
  rs._lootShowAll = showAll;
  rs.drawGroundItem({ id: "g", typeId: 7, x: 400, y: 400, width: 24, height: 24, rarity, itemLevel, affixIds }, inventory, player);
  return ctx.log;
}

describe("no rules: as before", () => {
  it("draws the marker and no name plate when the player is far", () => {
    const log = draw();
    expect(log.fills.length).toBeGreaterThan(0);
    expect(log.texts).toHaveLength(0);
    expect(log.gradients).toBe(0);
  });

  it("with no filter at all it still draws (the renderer used standalone)", () => {
    const ctx = stubCtx();
    const rs = new RenderSystem({ getContext: () => ctx }, null);
    rs.drawGroundItem({ id: "g", typeId: 7, x: 400, y: 400, width: 24, height: 24, rarity: "white" }, inventory, FAR);
    expect(ctx.log.fills.length).toBeGreaterThan(0);
  });
});

describe("hide", () => {
  const hide = [rule({ top: { action: "hide" }, conditions: { rarities: ["white"] } })];

  it("draws nothing for a hidden item", () => {
    const log = draw({ rules: hide });
    expect(log.fills).toHaveLength(0);
    expect(log.texts).toHaveLength(0);
  });

  it("does not hide an item the rule does not match", () => {
    expect(draw({ rules: hide, rarity: "blue" }).fills.length).toBeGreaterThan(0);
  });

  it("the show-all key draws it, dimmed, with its name", () => {
    const log = draw({ rules: hide, showAll: true });
    expect(log.fills.length).toBeGreaterThan(0);
    expect(log.alphas).toContain(0.4);
    expect(log.texts.map((t) => t.text)).toEqual(["Iron Sword"]);
  });

  it("show-all also labels items that are not hidden", () => {
    expect(draw({ showAll: true }).texts).toHaveLength(1);
  });
});

describe("emphasize and show", () => {
  it("emphasize always draws the name plate, even far away", () => {
    expect(draw({ rules: [rule({})] }).texts).toHaveLength(1);
  });

  it("show keeps the normal visibility (name only when near) but still applies the colour", () => {
    const far = draw({ rules: [rule({ top: { action: "show" }, style: { textColor: "#00ff00" } })] });
    expect(far.texts).toHaveLength(0);
    const near = draw({ rules: [rule({ top: { action: "show" }, style: { textColor: "#00ff00" } })], player: { x: 390, y: 390, width: 20, height: 20 } });
    expect(near.texts[0].style).toBe("#00ff00");
  });

  it("applies the rule's text colour, size and plate", () => {
    const log = draw({ rules: [rule({ style: { textColor: "#ff0000", fontSize: 20, bgColor: "#101010" } })] });
    expect(log.texts[0]).toMatchObject({ text: "Iron Sword", style: "#ff0000" });
    expect(log.fonts).toContain("20px sans-serif");
    expect(log.rects.some((r) => r.style === "#101010")).toBe(true);
  });

  it("without its own colour an emphasized item uses its grade colour; white stays white", () => {
    expect(draw({ rules: [rule({})], rarity: "foxy" }).texts[0].style).toBe("#ff7a1a");
    expect(draw({ rules: [rule({})], rarity: "blue" }).texts[0].style).toBe("#4a9eff");
    expect(draw({ rules: [rule({})] }).texts[0].style).toBe("#d6d9e0");
  });

  it("a beam draws a gradient bar", () => {
    expect(draw({ rules: [rule({ style: { beam: true, beamColor: "#ffffff" } })] }).gradients).toBe(1);
    expect(draw({ rules: [rule({})] }).gradients).toBe(0);
  });
});

describe("conditions reach the renderer", () => {
  it("level and affix conditions use what the item carries", () => {
    const byLevel = [rule({ top: { action: "hide" }, conditions: { minLevel: 50 } })];
    expect(draw({ rules: byLevel, itemLevel: 80 }).fills).toHaveLength(0);
    expect(draw({ rules: byLevel, itemLevel: 10 }).fills.length).toBeGreaterThan(0);
    const byAffix = [rule({ top: { action: "hide" }, conditions: { affixIds: [4] } })];
    expect(draw({ rules: byAffix, affixIds: [4, 9] }).fills).toHaveLength(0);
    expect(draw({ rules: byAffix, affixIds: [9] }).fills.length).toBeGreaterThan(0);
  });

  it("the top rule wins: a specific emphasize above a broad hide", () => {
    const rules = [
      rule({ conditions: { affixIds: [4] }, style: { textColor: "#abcdef" } }),
      rule({ top: { action: "hide", id: "b" }, conditions: { rarities: ["white"] } }),
    ];
    expect(draw({ rules, affixIds: [4] }).texts[0].style).toBe("#abcdef");
    expect(draw({ rules, affixIds: [] }).fills).toHaveLength(0);
  });
});
