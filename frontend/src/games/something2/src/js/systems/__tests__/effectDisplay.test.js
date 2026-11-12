import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { amberSheetFor, indexStatusVisuals } from "../../core/amber.js";
import { Game } from "../../core/Game.js";
import { DEFAULT_UI_PREFS } from "../../core/uiPrefs.js";

// SOMET-769: an effect row whose admin set display = 'code' never shows its sheet,
// whatever the player's Animations setting says; a 'sprite' row (or an old row with
// no value) behaves as before.
const SHEET = { width: 128, height: 32 };
const imgs = { get: (k) => (k.startsWith("vfx:") ? SHEET : null) };
const rs = () => new RenderSystem({ getContext: () => ({}) }, imgs);

describe("display = code in the renderer", () => {
  it("_vfxSheet (vfx and auras) resolves a sprite row and an old row, never a code row", () => {
    const r = rs();
    expect(r._vfxSheet({ sprite_image: "a.png", sprite_frames: 4, display: "sprite" })).not.toBeNull();
    expect(r._vfxSheet({ sprite_image: "a.png", sprite_frames: 4 })).not.toBeNull();
    expect(r._vfxSheet({ sprite_image: "a.png", sprite_frames: 4, display: "code" })).toBeNull();
    expect(r._vfxSheet(null)).toBeNull();
  });

  it("_buffSheet likewise, even with buff animations on", () => {
    const r = rs();
    expect(r._buffSheet({ sprite_image: "b.png", sprite_frames: 4 })).not.toBeNull();
    expect(r._buffSheet({ sprite_image: "b.png", sprite_frames: 4, display: "code" })).toBeNull();
    expect(r._buffSheet(null)).toBeNull();
  });
});

describe("display = code for the amber seal", () => {
  it("amberSheetFor treats a code variant as having no sheet", () => {
    const byKey = indexStatusVisuals([
      { key: "amber_stance_1", sprite_image: "s1.png", display: "sprite" },
      { key: "amber_stance_2", sprite_image: "s2.png", display: "code" },
      { key: "amber_stance_3", sprite_image: "s3.png" },
    ]);
    expect(amberSheetFor(1, byKey)).not.toBeNull();
    expect(amberSheetFor(2, byKey)).toBeNull();
    expect(amberSheetFor(3, byKey)).not.toBeNull();
  });
});

describe("display = code and the preloads", () => {
  it("a code row's sheet is not fetched", () => {
    const g = Object.create(Game.prototype);
    g.uiPrefs = { ...DEFAULT_UI_PREFS };
    const loaded = [];
    g.imageManager = { load: (k) => loaded.push(k) };
    g._loadEffectSheets({ a: { sprite_image: "a.png" }, b: { sprite_image: "b.png", display: "code" } });
    g.buffVisuals = { haste: { sprite_image: "h.png", display: "code" } };
    g.statusVisuals = { amber_stance_1: { sprite_image: "s.png", display: "sprite" } };
    g._loadBuffSheets();
    expect(loaded).toEqual(["vfx:a.png", "vfx:s.png"]);
  });
});
