// Switching between the builds of a class in the U window: the layout of the switcher row, and how Game keeps
// the choice (per character, applied to the window and to the Passive Tree route).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Game } from "../Game.js";
import { BUILD_GUIDES } from "../buildGuides.data.js";
import { BUILD_GUIDE_VARIANTS } from "../buildGuides.variants.data.js";
import { variantStorageKey } from "../buildGuide.js";
import { layoutBuildGuide, drawBuildGuide, BG_PANEL_W, BG_PANEL_H } from "../../systems/buildGuidePanel.js";
import { setLang } from "../../i18n/i18n.js";

const realWindow = globalThis.window;
const realStorage = globalThis.localStorage;
let storage;

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

function makeGame({ className = "Druid", characterId = 7 } = {}) {
  const g = new Game();
  g.canvas = {
    addEventListener: () => {}, removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    width: 1280, height: 720,
  };
  g.state = "playing";
  g.chunked = true;
  g.className = className;
  g.characterId = characterId;
  g.loadQuests = () => Promise.resolve();
  g._ensurePassiveTree = vi.fn();
  g.toasts = [];
  g._showToast = (m) => g.toasts.push(m);
  return g;
}

beforeEach(() => {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
  storage = fakeStorage();
  globalThis.localStorage = storage;
});
afterEach(() => {
  globalThis.window = realWindow;
  globalThis.localStorage = realStorage;
  setLang("en");
});

describe("Game: choosing a build", () => {
  it("shows the main build until another is chosen", () => {
    const g = makeGame();
    expect(g.getBuildGuide()).toBe(BUILD_GUIDES.Druid);
    expect(g.getBuildGuideEntryId()).toBe("main");
  });

  it("switches to the chosen build, remembers it per character and starts at the top of the Overview", () => {
    const g = makeGame();
    g.buildGuideScroll = 300;
    g.buildGuideTab = "passives";
    g.selectBuildVariant("druid_wolf");
    expect(g.getBuildGuide().id).toBe("druid_wolf");
    expect(g.buildGuideScroll).toBe(0);
    expect(g.buildGuideTab).toBe("overview");
    expect(storage.m.get(variantStorageKey(7))).toBe("druid_wolf");
    expect(storage.m.has(variantStorageKey(8))).toBe(false);
    expect(g.toasts.join(" ")).toContain("Wolf Pack");
  });

  it("going back to the main build clears the saved choice", () => {
    const g = makeGame();
    g.selectBuildVariant("druid_moon");
    g.selectBuildVariant("main");
    expect(g.getBuildGuide()).toBe(BUILD_GUIDES.Druid);
    expect(storage.m.has(variantStorageKey(7))).toBe(false);
  });

  it("ignores an unknown id and a re-click on the build already shown", () => {
    const g = makeGame();
    g.selectBuildVariant("no_such_build");
    g.selectBuildVariant("warrior_bulwark");                 // another class's build
    g.selectBuildVariant("main");                            // already shown
    expect(g.toasts).toEqual([]);
    expect(storage.m.size).toBe(0);
    expect(g.getBuildGuide()).toBe(BUILD_GUIDES.Druid);
  });

  it("a saved id that no longer exists falls back to the main build instead of an empty window", () => {
    const g = makeGame();
    g.buildVariantId = "removed_build";
    expect(g.getBuildGuide()).toBe(BUILD_GUIDES.Druid);
    expect(g.getBuildGuideEntryId()).toBe("main");
  });

  it("the window state lists every build and marks the one shown", () => {
    const g = makeGame();
    g.selectBuildVariant("druid_moon");
    const st = g._buildGuideState();
    expect(st.variants.map((v) => v.id)).toEqual(["main", "druid_wolf", "druid_moon"]);
    expect(st.variants.filter((v) => v.selected).map((v) => v.id)).toEqual(["druid_moon"]);
    expect(st.guide.id).toBe("druid_moon");
    expect(st.hotbar.map((h) => h.skillId)).toEqual(BUILD_GUIDE_VARIANTS.Druid[1].hotbar.map((h) => h.skillId));
  });

  it("a class without a guide has no switcher and no window content", () => {
    const g = makeGame({ className: "Paladin" });
    expect(g.getBuildGuide()).toBeNull();
    expect(g._buildGuideState().variants).toEqual([]);
  });

  it("following keeps following, but now the route of the build shown", () => {
    const g = makeGame();
    g.toggleBuildFollowing(true);
    g.toasts.length = 0;
    g.selectBuildVariant("druid_wolf");
    expect(g.buildFollowing).toBe(true);
    expect(g._passiveBuildState().guide.id).toBe("druid_wolf");
    expect(g.toasts.join(" ")).toContain("Following build");
    expect(g.toasts.join(" ")).toContain("Wolf Pack");
  });

  it("a click on a switcher button in the window picks that build", () => {
    const g = makeGame();
    g.buildGuideOpen = true;
    const layout = layoutBuildGuide(g._buildGuideState());
    g.renderSystem = { _bgHitAreas: layout.hitAreas };
    const target = layout.variantTabs.find((v) => v.id === "druid_wolf");
    g._cursorX = target.x + 5;
    g._cursorY = target.y + 5;
    // The window's click handler reads the cursor and the hit areas, like the real mousedown does.
    const areas = g.renderSystem._bgHitAreas;
    const hit = areas.find((a) => g._cursorX >= a.x && g._cursorX <= a.x + a.w && g._cursorY >= a.y && g._cursorY <= a.y + a.h);
    expect(hit.kind).toBe("bgvariant");
    g.selectBuildVariant(hit.id);
    expect(g.getBuildGuide().id).toBe("druid_wolf");
  });
});

describe("the window: the switcher row", () => {
  const variants = [
    { id: "main", name: "Shapeshifter", selected: true },
    { id: "druid_wolf", name: "Wolf Pack", selected: false },
    { id: "druid_moon", name: "Moon Caster", selected: false },
  ];
  const base = { guide: BUILD_GUIDES.Druid, tab: "overview", variants };

  it("offers one button per build, each a hit area that names its build", () => {
    const l = layoutBuildGuide(base);
    expect(l.variantTabs.map((v) => v.id)).toEqual(["main", "druid_wolf", "druid_moon"]);
    expect(l.variantTabs.map((v) => v.selected)).toEqual([true, false, false]);
    const areas = l.hitAreas.filter((a) => a.kind === "bgvariant");
    expect(areas.map((a) => a.id)).toEqual(["main", "druid_wolf", "druid_moon"]);
  });

  it("moves the section tabs and the text down to make room, and nothing leaves the window", () => {
    const plain = layoutBuildGuide({ ...base, variants: [] });
    const withRow = layoutBuildGuide(base);
    expect(plain.variantTabs).toEqual([]);
    const shift = withRow.tabs[0].y - plain.tabs[0].y;
    expect(shift).toBeGreaterThan(0);
    expect(withRow.area.y - plain.area.y).toBe(shift);
    expect(withRow.area.h).toBe(plain.area.h - shift);
    expect(withRow.variantTabs[0].y + withRow.variantTabs[0].h).toBeLessThan(withRow.tabs[0].y);
    for (const a of withRow.hitAreas) {
      expect(a.x).toBeGreaterThanOrEqual(withRow.panel.x);
      expect(a.x + a.w).toBeLessThanOrEqual(withRow.panel.x + BG_PANEL_W);
      expect(a.y + a.h).toBeLessThanOrEqual(withRow.panel.y + BG_PANEL_H);
    }
  });

  it("shows no row for a class with a single build, so its window is exactly as before", () => {
    const one = layoutBuildGuide({ ...base, variants: [variants[0]] });
    const none = layoutBuildGuide({ guide: BUILD_GUIDES.Druid, tab: "overview" });
    expect(one.variantTabs).toEqual([]);
    expect(one.tabs.map((t) => t.y)).toEqual(none.tabs.map((t) => t.y));
    expect(one.area).toEqual(none.area);
  });

  it("draws the names of the builds", () => {
    const texts = [];
    const ctx = new Proxy({}, {
      get(t, key) {
        if (key in t) return t[key];
        if (key === "measureText") return (s) => ({ width: String(s).length * 7 });
        if (key === "fillText") return (s) => { texts.push(String(s)); };
        return () => {};
      },
      set(t, key, v) { t[key] = v; return true; },
    });
    drawBuildGuide(ctx, layoutBuildGuide(base));
    const all = texts.join("\n");
    for (const v of variants) expect(all).toContain(v.name);
  });
});
