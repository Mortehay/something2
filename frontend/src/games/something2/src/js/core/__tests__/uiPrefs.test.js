import { describe, it, expect } from "vitest";
import {
  normalizeUiPrefs, loadUiPrefs, saveUiPrefs, sameUiPrefs, DEFAULT_UI_PREFS, UI_PREFS_KEY,
} from "../uiPrefs.js";
import { shouldShowHealText, Game } from "../Game.js";

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

describe("ui preferences", () => {
  it("defaults when nothing is stored or the stored value is junk", () => {
    expect(loadUiPrefs(memory())).toEqual(DEFAULT_UI_PREFS);
    const s = memory(); s.setItem(UI_PREFS_KEY, "{not json");
    expect(loadUiPrefs(s)).toEqual(DEFAULT_UI_PREFS);
  });

  it("keeps valid fields and replaces invalid ones one by one", () => {
    expect(normalizeUiPrefs({ showLocationBanner: false, minHealText: 15, trackerWidth: 360 }))
      .toEqual({ showLocationBanner: false, minHealText: 15, trackerWidth: 360 });
    expect(normalizeUiPrefs({ showLocationBanner: "no", minHealText: 7, trackerWidth: 9000 }))
      .toEqual(DEFAULT_UI_PREFS);
    expect(normalizeUiPrefs(null)).toEqual(DEFAULT_UI_PREFS);
  });

  it("round-trips through storage", () => {
    const s = memory();
    saveUiPrefs({ showLocationBanner: false, minHealText: 0, trackerWidth: 240 }, s);
    expect(loadUiPrefs(s)).toEqual({ showLocationBanner: false, minHealText: 0, trackerWidth: 240 });
    expect(sameUiPrefs(loadUiPrefs(s), loadUiPrefs(s))).toBe(true);
  });

  it("the heal threshold is the player's: 0 shows every heal, 9999 shows none", () => {
    expect(shouldShowHealText(1, 0)).toBe(true);
    expect(shouldShowHealText(5, 5)).toBe(false);
    expect(shouldShowHealText(6, 5)).toBe(true);
    expect(shouldShowHealText(500, 9999)).toBe(false);
  });

  it("the location banner can be switched off", () => {
    const g = Object.create(Game.prototype);
    g.uiPrefs = { ...DEFAULT_UI_PREFS, showLocationBanner: false };
    g._announceLocation({ name: "Rimehollow", levelMin: 3, levelMax: 9 });
    expect(g.locationBanner).toBeNull();
    g.uiPrefs = { ...DEFAULT_UI_PREFS };
    g._announceLocation({ name: "Rimehollow", levelMin: 3, levelMax: 9 });
    expect(g.locationBanner.name).toBe("Rimehollow");
  });
});
