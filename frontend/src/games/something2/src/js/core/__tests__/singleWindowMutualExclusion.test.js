// frontend/src/games/something2/src/js/core/__tests__/singleWindowMutualExclusion.test.js
import { describe, it, expect } from "vitest";
import { Game } from "../Game.js";

// One window at a time: while a window is open every OTHER window refuses to
// open (it used to close the open one, which made a stray hotkey throw away
// what the player was doing). Closing is the player's job: Esc, hotkey, X.
describe("Single-window exclusion (opening a window is refused while another is open)", () => {
  function makeTestGame() {
    const g = new Game();
    g.canvas = {
      addEventListener: () => {},
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
      width: 1280,
      height: 720,
    };
    g.state = "playing";
    g.chunked = true;
    g.loadQuests = () => Promise.resolve();
    g._refreshRespecQuote = () => Promise.resolve();
    return g;
  }

  const OPEN = {
    inventory: (g) => g.openInventory(),
    passiveTree: (g) => g.openPassiveTree(),
    questLog: (g) => g.openQuestLog(),
    skills: (g) => g.openSkills(),
    gemShop: (g) => g.openGemShop(),
    shop: (g) => g.openShop(),
    bank: (g) => g.openBank(),
  };
  const FLAG = {
    inventory: "inventoryOpen", passiveTree: "passiveTreeOpen", questLog: "questLogOpen",
    skills: "skillsOpen", gemShop: "gemShopOpen", shop: "shopOpen", bank: "bankOpen",
  };

  it("no window can open on top of any other window", () => {
    for (const first of Object.keys(OPEN)) {
      for (const second of Object.keys(OPEN)) {
        if (first === second) continue;
        const g = makeTestGame();
        OPEN[first](g);
        expect(g[FLAG[first]], `${first} opens on a clean screen`).toBe(true);
        OPEN[second](g);
        expect(g[FLAG[second]], `${second} must not open over ${first}`).toBeFalsy();
        expect(g[FLAG[first]], `${first} stays open`).toBe(true);
      }
    }
  });

  it("re-opening the SAME window still works (refresh, tab switch)", () => {
    const g = makeTestGame();
    g.openInventory("inventory");
    g.openInventory("character");
    expect(g.inventoryOpen).toBe(true);
    expect(g.inventoryTab).toBe("character");

    const h = makeTestGame();
    h.openShop({ villageId: 1, catalog: [], buyback: [] });
    h.openShop({ villageId: 1, catalog: [{ id: 1 }], buyback: [] });
    expect(h.shopOpen).toBe(true);
    expect(h.shop.catalog.length).toBe(1);
  });

  it("a window can be opened again once the previous one is closed", () => {
    const g = makeTestGame();
    g.openQuestLog();
    g.openSkills();
    expect(g.skillsOpen).toBeFalsy();
    g.closeQuestLog();
    g.openSkills();
    expect(g.skillsOpen).toBe(true);
  });

  it("an empty hotbar slot does not stack the Skills window on another window", () => {
    const g = makeTestGame();
    g.className = "Mage";
    g.openQuestLog();
    g._activateHotbarSkill(3);
    expect(g.skillsOpen).toBeFalsy();
    expect(g.questLogOpen).toBe(true);
  });

  it("closeAllPanels still closes everything except the named window", () => {
    const g = makeTestGame();
    g.inventoryOpen = true;
    g.skillsOpen = true;
    g.questLogOpen = true;
    g.closeAllPanels("inventory");
    expect(g.inventoryOpen).toBe(true);
    expect(g.skillsOpen).toBe(false);
    expect(g.questLogOpen).toBe(false);
  });
});
