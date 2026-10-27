// frontend/src/games/something2/src/js/core/__tests__/singleWindowMutualExclusion.test.js
import { describe, it, expect } from "vitest";
import { Game } from "../Game.js";

describe("Single-window mutual exclusion (no overlapping panels)", () => {
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

  it("closeAllPanels closes all panels except the specified one", () => {
    const g = makeTestGame();
    g.inventoryOpen = true;
    g.skillsOpen = true;
    g.questLogOpen = true;

    g.closeAllPanels("inventory");

    expect(g.inventoryOpen).toBe(true);
    expect(g.skillsOpen).toBe(false);
    expect(g.questLogOpen).toBe(false);
  });

  it("opening Quest Log closes Inventory, Skills, and Passive Tree", () => {
    const g = makeTestGame();
    g.openInventory();
    expect(g.inventoryOpen).toBe(true);

    g.openQuestLog();
    expect(g.questLogOpen).toBe(true);
    expect(g.inventoryOpen).toBe(false);

    g.openSkills();
    expect(g.skillsOpen).toBe(true);
    expect(g.questLogOpen).toBe(false);

    g.openPassiveTree();
    expect(g.passiveTreeOpen).toBe(true);
    expect(g.skillsOpen).toBe(false);
  });

  it("opening Gem Shop or Shop closes Quest Log and Skills", () => {
    const g = makeTestGame();
    g.openQuestLog();
    expect(g.questLogOpen).toBe(true);

    g.openGemShop();
    expect(g.gemShopOpen).toBe(true);
    expect(g.questLogOpen).toBe(false);

    g.openShop();
    expect(g.shopOpen).toBe(true);
    expect(g.gemShopOpen).toBe(false);
  });
});
