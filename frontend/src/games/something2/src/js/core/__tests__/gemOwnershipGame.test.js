// Skill gems, enchant scrolls and skill levels as the GAME wires them, against a real
// Game instance: the server's frames land in the right state, the buttons send the right
// message (or none), and the browser's old local unlocks are offered once and then retired.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Game } from "../Game.js";
import { SKILLS } from "../skillsData.js";
import { createInventory } from "../inventory.js";

const realWindow = globalThis.window;
const realPerf = globalThis.performance;
let clock = 0;

const STARTER = SKILLS.find((s) => (s.reqQuests || []).length === 0 && s.reqLvl <= 5);
const OTHER = SKILLS.find((s) => s.id !== STARTER.id && (s.reqQuests || []).length === 0 && s.reqLvl <= 5);

function makeGame() {
  const g = new Game();
  g.state = "playing";
  g.chunked = true;
  g.player = { x: 100, y: 100, width: 64, height: 64 };
  g.canvas = { width: 1280, height: 720 };
  g.camera = { screenX: 0, screenY: 0 };
  g.hotbarSkills = new Map();
  g.inventory = createInventory();
  g.gold = 5000;
  g.toasts = [];
  g.showToast = (t) => g.toasts.push(t);
  g.saveHotbar = () => { g.hotbarSaved = (g.hotbarSaved || 0) + 1; };
  g.sent = [];
  g.authorityClient = {
    sendBuyGem: (id) => g.sent.push(["buyGem", id]),
    sendImportGems: (ids) => g.sent.push(["importGems", ids]),
    sendEnchant: (s, i) => g.sent.push(["enchant", s, i]),
    sendUpgradeSkill: (id) => g.sent.push(["upgradeSkill", id]),
    sendInteract: () => {},
  };
  return g;
}

beforeEach(() => {
  clock = 10_000;
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.performance = { now: () => clock };
});

afterEach(() => {
  globalThis.window = realWindow;
  globalThis.performance = realPerf;
});

describe("gem ownership comes from the server", () => {
  it("a purchase confirmation unlocks, sockets and pays — and nothing happens before it", () => {
    const g = makeGame();
    g.unlockedSkills = new Set();
    g._gemsSettled = true;
    expect(g.unlockedSkills.has(STARTER.id)).toBe(false);

    g._onGemBought({ skillId: STARTER.id, price: 100, gold: 4900 });
    expect(g.gold).toBe(4900);
    expect(g.unlockedSkills.has(STARTER.id)).toBe(true);
    expect(g.ownedGems.has(STARTER.id)).toBe(true);
    expect([...g.hotbarSkills.values()].map((s) => s.id)).toEqual([STARTER.id]);
    expect(g.inventory.items.some((i) => i.skillId === STARTER.id)).toBe(true);
    expect(g.toasts.join(" ")).toContain("Acquired");
    expect(g.hotbarSaved).toBeGreaterThan(0);
  });

  it("a confirmation for an unknown skill changes nothing", () => {
    const g = makeGame();
    g.unlockedSkills = new Set();
    g._onGemBought({ skillId: "nope", price: 1, gold: 1 });
    expect(g.gold).toBe(5000);
    expect(g.unlockedSkills.size).toBe(0);
  });

  it("sockets into the first FREE hotbar slot", () => {
    const g = makeGame();
    g.unlockedSkills = new Set([OTHER.id]);
    g._gemsSettled = true;
    g.hotbarSkills.set(1, OTHER);
    g._onGemBought({ skillId: STARTER.id, price: 100, gold: 4900 });
    expect(g.hotbarSkills.get(2).id).toBe(STARTER.id);
  });

  it("reconcile keeps owned hotbar entries and drops ones the server does not know", () => {
    const g = makeGame();
    g.unlockedSkills = new Set([STARTER.id]);
    g.hotbarSkills.set(1, STARTER);
    g.hotbarSkills.set(2, OTHER);              // never bought
    g._gemsSettled = true;
    g._reconcileGems();
    expect(g.hotbarSkills.has(1)).toBe(true);
    expect(g.hotbarSkills.has(2)).toBe(false);
    expect(g.hotbarSaved).toBeGreaterThan(0);
  });

  it("reconcile leaves the hotbar alone until the legacy import has been answered", () => {
    const g = makeGame();
    g.unlockedSkills = new Set();
    g.hotbarSkills.set(1, STARTER);
    g._gemsSettled = false;
    g._reconcileGems();
    expect(g.hotbarSkills.has(1)).toBe(true);
  });

  it("an import answer unlocks what was granted, settles, and retires the local list", () => {
    const g = makeGame();
    g.unlockedSkills = new Set();
    g._gemsSettled = false;
    g._legacyGemIds = [STARTER.id, OTHER.id];
    g.hotbarSkills.set(1, STARTER);
    g.hotbarSkills.set(2, OTHER);
    g._onGemsImported({ granted: [STARTER.id] });
    expect(g.unlockedSkills.has(STARTER.id)).toBe(true);
    expect(g.unlockedSkills.has(OTHER.id)).toBe(false);
    expect(g._gemsSettled).toBe(true);
    expect(g._legacyGemIds).toEqual([]);
    expect(g.hotbarSkills.has(2)).toBe(false);       // the ungranted gem leaves the bar
    expect(g.toasts.join(" ")).toContain("Restored 1 skill gem");
  });

  it("an import that grants nothing is silent", () => {
    const g = makeGame();
    g.unlockedSkills = new Set();
    g._onGemsImported({ granted: [], refused: "already imported" });
    expect(g.toasts).toEqual([]);
    expect(g._gemsSettled).toBe(true);
  });
});

describe("the gem shop Buy button asks the server and edits nothing itself", () => {
  it("source: the shop branch sends buyGem and no longer touches gold or local storage", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../Game.js"), "utf8");
    expect(src).toContain("sendBuyGem(hit.gem.id)");
    expect(src).not.toMatch(/unlockSkillForCharacter\(/);
    expect(src).not.toMatch(/isSkillUnlocked\(/);
    expect(src).not.toContain("'skills_buy'");
    // the old local deduction is gone from the shop branch
    expect(src).not.toMatch(/this\.gold = Math\.max\(0, \(this\.gold \|\| 0\) - price\)/);
  });
});

describe("enchant and skill-level buttons", () => {
  const CFG = {
    maxLevel: 15, safeMaxLevel: 3, damagePerLevel: 0.08, glowMinLevel: 4, glowFireLevel: 10,
    scrollItemName: "enchant_scroll",
    chances: { 1: 100, 2: 100, 3: 100, 4: 60, 5: 50, 6: 40, 7: 30, 8: 20, 9: 15, 10: 10, 11: 7, 12: 5, 13: 3, 14: 2, 15: 1 },
  };
  function withBag(g, level, scrolls = 1) {
    g.enchantCfg = CFG;
    g.inventory.types.set(1, { id: 1, name: "sword", category: "weapon" });
    g.inventory.types.set(2, { id: 2, name: "enchant_scroll", category: "consumable" });
    g.inventory.items = [{ id: "w", typeId: 1, quantity: 1, enchantLevel: level }];
    if (scrolls) g.inventory.items.push({ id: "s", typeId: 2, quantity: scrolls });
  }

  it("a safe enchant is sent at once", () => {
    const g = makeGame();
    withBag(g, 1);
    g._onEnchantClick("w");
    expect(g.sent).toEqual([["enchant", "s", "w"]]);
  });

  it("a dangerous enchant needs a second click, and only within the window", () => {
    const g = makeGame();
    withBag(g, 4);
    g._onEnchantClick("w");
    expect(g.sent).toEqual([]);
    expect(g.toasts.join(" ")).toContain("BURNS");

    clock += 1000;
    g._onEnchantClick("w");
    expect(g.sent).toEqual([["enchant", "s", "w"]]);
  });

  it("a stale arming does not count: the confirmation expires", () => {
    const g = makeGame();
    withBag(g, 5);
    g._onEnchantClick("w");
    clock += 60_000;
    g._onEnchantClick("w");
    expect(g.sent).toEqual([]);
  });

  it("arming one weapon does not confirm another", () => {
    const g = makeGame();
    withBag(g, 5);
    g.inventory.items.push({ id: "w2", typeId: 1, quantity: 1, enchantLevel: 5 });
    g._onEnchantClick("w");
    g._onEnchantClick("w2");
    expect(g.sent).toEqual([]);
  });

  it("a double-click cannot send two scrolls", () => {
    const g = makeGame();
    withBag(g, 1, 5);
    g._onEnchantClick("w");
    g._onEnchantClick("w");
    expect(g.sent).toHaveLength(1);
  });

  it("nothing is sent for a +15 weapon or without a scroll, and the player is told why", () => {
    const g = makeGame();
    withBag(g, 15);
    g._onEnchantClick("w");
    expect(g.sent).toEqual([]);
    expect(g.toasts.join(" ")).toContain("Maximum");
    const h = makeGame();
    withBag(h, 2, 0);
    h._onEnchantClick("w");
    expect(h.sent).toEqual([]);
    expect(h.toasts.join(" ")).toContain("No enchant scroll");
  });

  it("the result frame updates the bag and clears the selection of a burnt weapon", () => {
    const g = makeGame();
    withBag(g, 4, 2);
    g.inventorySelectedItemId = "w";
    g.blasts = [];
    g._onEnchanted({ outcome: "destroyed", destroyed: true, itemId: "w", scrollId: "s", scrollsLeft: 1, level: 4 });
    expect(g.inventory.items.map((i) => i.id)).toEqual(["s"]);
    expect(g.inventory.items[0].quantity).toBe(1);
    expect(g.inventorySelectedItemId).toBeNull();
    expect(g.toasts.join(" ")).toContain("burned");
  });

  const LCFG = { maxLevel: 15, powerPerLevel: 0.01, costs: [100, 120, 144], costsByTier: { 1: [100, 120, 144], 5: [500, 600, 720] } };

  it("an affordable upgrade is sent; a short wallet and the level cap are refused locally", () => {
    const g = makeGame();
    g.skillLevelingCfg = LCFG;
    g.skillLevels = {};
    g.gold = 1000;
    const skill = SKILLS.find((s) => s.tier === 1);
    g._onSkillUpgradeClick(skill.id);
    expect(g.sent).toEqual([["upgradeSkill", skill.id]]);

    const poor = makeGame();
    poor.skillLevelingCfg = LCFG;
    poor.skillLevels = {};
    poor.gold = 99;
    poor._onSkillUpgradeClick(skill.id);
    expect(poor.sent).toEqual([]);
    expect(poor.toasts.join(" ")).toContain("Not enough gold");

    const maxed = makeGame();
    maxed.skillLevelingCfg = LCFG;
    maxed.skillLevels = { [skill.id]: 15 };
    maxed.gold = 1e9;
    maxed._onSkillUpgradeClick(skill.id);
    expect(maxed.sent).toEqual([]);
    expect(maxed.toasts.join(" ")).toContain("maximum");
  });

  it("an ultimate costs more than the same wallet covers for a starter skill", () => {
    const g = makeGame();
    g.skillLevelingCfg = LCFG;
    g.skillLevels = {};
    g.gold = 300;
    const ultimate = SKILLS.find((s) => s.tier === 5);
    g._onSkillUpgradeClick(ultimate.id);
    expect(g.sent).toEqual([]);
    expect(g.toasts.join(" ")).toContain("500");
  });

  it("the confirmation records the level and the new wallet", () => {
    const g = makeGame();
    g.skillLevels = {};
    g.blasts = [];
    g._onSkillUpgraded({ skillId: "x", level: 3, cost: 144, gold: 700 });
    expect(g.skillLevels).toEqual({ x: 3 });
    expect(g.gold).toBe(700);
  });
});
