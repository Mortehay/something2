// The gem shop opens on the class of the character who is playing, so a mage is shown mage gems and
// not a wall of every class's. The player can still switch tab, and the next open starts over.
import { describe, it, expect } from "vitest";
import { Game } from "../Game.js";
import { layoutGemShopPanel, CLASS_TABS } from "../../systems/gemShopPanel.js";
import { getSkillsForClass } from "../skillsData.js";

function makeGame(className) {
  const g = new Game();
  g.state = "playing";
  g.chunked = true;
  g.player = { x: 100, y: 100, width: 64, height: 64, className };
  g.className = className;
  g.canvas = { width: 1280, height: 720 };
  g.camera = { screenX: 0, screenY: 0 };
  return g;
}

describe("the gem shop's starting class", () => {
  it("is the playing character's class, for every class there is", () => {
    for (const tab of CLASS_TABS.filter((t) => t.key !== "all")) {
      const g = makeGame(tab.key);
      g.openGemShop();
      expect(g.gemShopOpen).toBe(true);
      expect(g.gemShopClassFilter).toBe(tab.key);
    }
  });

  it("falls back to every class when the class is unknown or not yet loaded", () => {
    for (const cls of [null, undefined, "", "Paladin"]) {
      const g = makeGame(cls);
      g.player.className = cls;
      g.openGemShop();
      expect(g.gemShopClassFilter).toBe("all");
    }
  });

  it("really lists only that class's gems", () => {
    const g = makeGame("Mage");
    g.openGemShop();
    const layout = layoutGemShopPanel({
      colorFilter: g.gemShopColorFilter, classFilter: g.gemShopClassFilter, page: g.gemShopPage,
      gold: 99999, unlockedSkills: [], playerStats: {},
    });
    expect(layout.classTabs.find((t) => t.active).key).toBe("Mage");
    const mageIds = new Set(getSkillsForClass("Mage").map((s) => s.id));
    expect(layout.rows.length).toBeGreaterThan(0);
    for (const r of layout.rows) expect(mageIds.has(r.gem.id)).toBe(true);

    // ...and "All" really is a bigger list, so the default is doing something.
    const all = layoutGemShopPanel({
      colorFilter: "all", classFilter: "all", page: 0, gold: 99999, unlockedSkills: [], playerStats: {},
    });
    expect(all.totalCount).toBeGreaterThan(layout.totalCount);
  });

  it("starts over on every open: a tab picked last time does not stick", () => {
    const g = makeGame("Mage");
    g.openGemShop();
    g.gemShopClassFilter = "Druid";
    g.gemShopColorFilter = "str";
    g.gemShopPage = 3;
    g.gemShopOpen = false;

    g.openGemShop();
    expect(g.gemShopClassFilter).toBe("Mage");
    expect(g.gemShopColorFilter).toBe("all");
    expect(g.gemShopPage).toBe(0);
  });

  it("keeps the player's own tab choice while the shop stays open", () => {
    const g = makeGame("Mage");
    g.openGemShop();
    g.gemShopClassFilter = "all";
    expect(g.gemShopClassFilter).toBe("all");
  });

  it("applies to the village merchants too, not only the menu shortcut", () => {
    const g = makeGame("Warrior");
    g._showGemShop();
    expect(g.gemShopClassFilter).toBe("Warrior");
    expect(g.gemShopOpen).toBe(true);
  });
});
