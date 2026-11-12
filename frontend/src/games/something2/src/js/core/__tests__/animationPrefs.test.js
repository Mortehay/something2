import { describe, it, expect } from "vitest";
import {
  ANIMATION_KEYS, ACTION_KEYS, ANIMATION_GROUPS, ALL_ANIMATIONS_ON,
  normalizeAnimations, withAllAnimations, allAnimationsOn, anyAnimationOn, sameAnimations,
} from "../animationPrefs.js";
import { normalizeUiPrefs, DEFAULT_UI_PREFS } from "../uiPrefs.js";
import { Game } from "../Game.js";

// SOMET-768: the Animations settings tab's data.
describe("animation preferences", () => {
  it("lists every key exactly once across the settings groups, in the stated order", () => {
    const listed = ANIMATION_GROUPS.flatMap((g) => g.rows.map((r) => r.key));
    expect(listed).toEqual([...ANIMATION_KEYS]);
    for (const g of ANIMATION_GROUPS) {
      expect(g.title).toBeTruthy();
      for (const r of g.rows) {
        expect(r.label, r.key).toBeTruthy();
        expect(r.hint, r.key).toMatch(/Off: /);
      }
    }
  });

  it("action keys are the sheet action names, so the renderer can look an action up directly", () => {
    expect([...ACTION_KEYS]).toEqual(["idle", "walk", "attack", "cast", "damage", "death", "use"]);
  });

  it("defaults everything on and normalises field by field", () => {
    expect(normalizeAnimations(null)).toEqual(ALL_ANIMATIONS_ON);
    expect(normalizeAnimations("junk")).toEqual(ALL_ANIMATIONS_ON);
    expect(normalizeAnimations({ walk: false, vfx: "no", bogus: false }))
      .toEqual({ ...ALL_ANIMATIONS_ON, walk: false });
    expect(Object.isFrozen(ALL_ANIMATIONS_ON)).toBe(true);
  });

  it("select all / unselect all and the button states", () => {
    const on = withAllAnimations(true);
    const off = withAllAnimations(false);
    expect(on).toEqual(ALL_ANIMATIONS_ON);
    expect(Object.values(off).every((v) => v === false)).toBe(true);
    expect(allAnimationsOn(on)).toBe(true);
    expect(allAnimationsOn({ ...on, tiles: false })).toBe(false);
    expect(anyAnimationOn(off)).toBe(false);
    expect(anyAnimationOn({ ...off, idle: true })).toBe(true);
    // undefined reads as everything on
    expect(allAnimationsOn(undefined)).toBe(true);
  });

  it("sameAnimations compares normalised values", () => {
    expect(sameAnimations(null, ALL_ANIMATIONS_ON)).toBe(true);
    expect(sameAnimations({ walk: false }, { walk: false, bogus: 1 })).toBe(true);
    expect(sameAnimations({ walk: false }, {})).toBe(false);
  });

  it("rides along in uiPrefs", () => {
    expect(DEFAULT_UI_PREFS.animations).toEqual(ALL_ANIMATIONS_ON);
    expect(normalizeUiPrefs({ animations: { death: false } }).animations)
      .toEqual({ ...ALL_ANIMATIONS_ON, death: false });
    expect(normalizeUiPrefs({ animations: 5 }).animations).toEqual(ALL_ANIMATIONS_ON);
  });
});

describe("Game applies animation preferences", () => {
  const game = () => {
    const g = Object.create(Game.prototype);
    g.uiPrefs = { ...DEFAULT_UI_PREFS };
    g.renderSystem = { animations: null };
    g.corpses = { cleared: 0, clear() { this.cleared += 1; } };
    g.loaded = [];
    g.imageManager = { load: (k) => g.loaded.push(k) };
    g.vfxDefs = { slash: { sprite_image: "vfx/slash.png" } };
    g.auraDefs = { chill: { sprite_image: "aura/chill.png" } };
    g.buffVisuals = { haste: { sprite_image: "buff/haste.png" } };
    g.statusVisuals = { amber: { sprite_image: "status/amber.png" } };
    g.tileTypes = { water: { render_mode: "animated", image: "tiles/water.png", sprite: { atlas_key: "tiles/water-atlas.png" } } };
    return g;
  };

  it("_animOn is true unless the key is explicitly off, even with no prefs at all", () => {
    const g = Object.create(Game.prototype);
    expect(g._animOn("walk")).toBe(true);
    g.uiPrefs = { animations: { walk: false } };
    expect(g._animOn("walk")).toBe(false);
    expect(g._animOn("idle")).toBe(true);
  });

  it("setUiPrefs hands the choices to the renderer and clears corpses when death goes off", () => {
    const g = game();
    const saved = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    try {
      g.setUiPrefs({ ...g.uiPrefs, animations: { ...ALL_ANIMATIONS_ON, death: false } });
    } finally {
      globalThis.localStorage = saved;
    }
    expect(g.renderSystem.animations.death).toBe(false);
    expect(g.renderSystem.animations.walk).toBe(true);
    expect(g.corpses.cleared).toBe(1);
  });

  it("a family switched ON after entry is fetched then; one left on is not fetched again", () => {
    const g = game();
    g.uiPrefs = { ...DEFAULT_UI_PREFS, animations: { ...ALL_ANIMATIONS_ON, vfx: true, auras: true, buffs: true, tiles: true } };
    g._applyAnimationPrefs({ ...ALL_ANIMATIONS_ON, vfx: false, buffs: false, tiles: false });
    // effect/buff sheets load under vfx.js's spriteKey ("vfx:" + path); tiles under their asset key
    expect(g.loaded).toEqual(["vfx:vfx/slash.png", "vfx:buff/haste.png", "vfx:status/amber.png", "tiles/water.png", "tiles/water-atlas.png"]);
    expect(g.corpses.cleared).toBe(0);
  });

  it("the preloads skip a family that is off", () => {
    const g = game();
    g.uiPrefs = { ...DEFAULT_UI_PREFS, animations: { ...ALL_ANIMATIONS_ON, buffs: false, tiles: false } };
    g._loadBuffSheets();
    g._preloadTileAssets(g.tileTypes);
    expect(g.loaded).toEqual(["tiles/water.png"]);
  });
});
