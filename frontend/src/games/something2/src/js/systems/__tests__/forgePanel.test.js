import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  forgeWeapons, forgeForecast, forgeAnimation, layoutForgePanel, drawForgePanel,
  FORGE_ANIM_MS, ROWS_PER_PAGE, BUY_QUANTITIES,
} from "../forgePanel.js";
import { createInventory } from "../../core/inventory.js";
import { Game } from "../../core/Game.js";

const CFG = {
  maxLevel: 15, safeMaxLevel: 3, damagePerLevel: 0.08, glowMinLevel: 4, glowFireLevel: 10,
  scrollItemName: "enchant_scroll", scrollPrice: 400, maxScrollPurchase: 20,
  chances: { 1: 100, 2: 100, 3: 100, 4: 60, 5: 50, 6: 40, 7: 30, 8: 20, 9: 15, 10: 10, 11: 7, 12: 5, 13: 3, 14: 2, 15: 1 },
};
const SWORD = { id: 1, name: "sword", category: "weapon", damage: 10, cooldown: 1, kind: "melee" };
const AXE = { id: 4, name: "axe", category: "weapon", damage: 20, cooldown: 1.5, kind: "melee" };
const SCROLL = { id: 2, name: "enchant_scroll", category: "consumable" };
const VEST = { id: 3, name: "vest", category: "armor" };

function bag(items, equipment = {}) {
  const inv = createInventory();
  for (const t of [SWORD, AXE, SCROLL, VEST]) inv.types.set(t.id, t);
  inv.items = items;
  inv.equipment = equipment;
  return inv;
}
const W = (id, typeId, level = 0) => ({ id, typeId, quantity: 1, enchantLevel: level });

describe("forgeWeapons", () => {
  it("lists only weapons, the one in hand first, then the highest enchant", () => {
    const inv = bag([W("a", 1, 3), W("b", 4, 9), W("c", 1, 0), { id: "v", typeId: 3, quantity: 1 }, { id: "s", typeId: 2, quantity: 2 }], { main_hand: "c" });
    expect(forgeWeapons(inv).map((r) => r.item.id)).toEqual(["c", "b", "a"]);
    expect(forgeWeapons(inv)[0].equipped).toBe(true);
  });

  it("copes with nothing to list", () => {
    expect(forgeWeapons(null)).toEqual([]);
    expect(forgeWeapons(bag([]))).toEqual([]);
  });
});

describe("forgeForecast", () => {
  const row = (level) => ({ item: W("w", 1, level), type: SWORD, level });

  it("a safe level shows a sure chance and a harmless failure", () => {
    const f = forgeForecast(row(2), CFG);
    expect(f).toMatchObject({ level: 2, nextLevel: 3, chancePct: 100, danger: false, maxed: false, name: "+2 sword" });
    expect(f.failure).toMatch(/only the scroll/);
  });

  it("a danger level shows the chance and says a miss burns the weapon", () => {
    const f = forgeForecast(row(3), CFG);
    expect(f).toMatchObject({ nextLevel: 4, chancePct: 60, danger: true });
    expect(f.failure).toMatch(/burns/);
  });

  it("shows the damage now and after, and the gain between them", () => {
    const f = forgeForecast(row(4), CFG);
    expect(f.damageNow).toBe(13.2);
    expect(f.damageAfter).toBe(14);
    expect(f.damageGain).toBe(0.8);
    expect(f.bonusNowPct).toBe(32);
    expect(f.bonusAfterPct).toBe(40);
  });

  it("walks the whole odds table", () => {
    for (let lvl = 3; lvl < 15; lvl += 1) expect(forgeForecast(row(lvl), CFG).chancePct).toBe(CFG.chances[lvl + 1]);
  });

  it("a +15 weapon is maxed and offers no next level", () => {
    const f = forgeForecast(row(15), CFG);
    expect(f.maxed).toBe(true);
    expect(f.chancePct).toBe(0);
    expect(f.danger).toBe(false);
    expect(f.nextLevel).toBe(15);
  });

  it("is null without a weapon or a config", () => {
    expect(forgeForecast(null, CFG)).toBeNull();
    expect(forgeForecast(row(1), null)).toBeNull();
  });
});

describe("forgeAnimation", () => {
  const result = { outcome: "success", level: 5, at: 1000 };

  it("plays for FORGE_ANIM_MS and then is gone", () => {
    expect(forgeAnimation(result, 1000)).toMatchObject({ kind: "success", t: 0, level: 5 });
    expect(forgeAnimation(result, 1000 + FORGE_ANIM_MS / 2).t).toBeCloseTo(0.5);
    expect(forgeAnimation(result, 1000 + FORGE_ANIM_MS)).toBeNull();
    expect(forgeAnimation(result, 99999)).toBeNull();
  });

  it("is null before it starts, and for no result", () => {
    expect(forgeAnimation(result, 500)).toBeNull();
    expect(forgeAnimation(null, 1000)).toBeNull();
    expect(forgeAnimation({ outcome: "success", at: NaN }, 1000)).toBeNull();
  });

  it("carries the outcome so each result can look different", () => {
    for (const outcome of ["success", "destroyed", "safe_fail"]) {
      expect(forgeAnimation({ outcome, level: 1, at: 0 }, 100).kind).toBe(outcome);
    }
  });
});

describe("layoutForgePanel", () => {
  const state = (over = {}) => ({
    inventory: bag([W("a", 1, 3), W("b", 4, 0), { id: "s", typeId: 2, quantity: 4 }], { main_hand: "a" }),
    enchantCfg: CFG, gold: 5000, selectedItemId: "a", page: 0, armedItemId: null, ...over,
  });
  const kinds = (l) => l.hitAreas.map((a) => a.kind);

  it("has a row and a hit area for every weapon, and a close button", () => {
    const l = layoutForgePanel(state());
    expect(l.rows.map((r) => r.item.id)).toEqual(["a", "b"]);
    expect(l.rows[0].selected).toBe(true);
    expect(l.hitAreas.filter((a) => a.kind === "forge_weapon").map((a) => a.id)).toEqual(["a", "b"]);
    expect(kinds(l)).toContain("forge_close");
  });

  it("the Enchant button is live for a usable weapon and carries its id", () => {
    const l = layoutForgePanel(state());
    expect(l.enchant.enabled).toBe(true);
    expect(l.hitAreas.find((a) => a.kind === "forge_enchant").id).toBe("a");
    expect(l.enchant.label).toContain("60%");
    expect(l.scrolls).toBe(4);
  });

  it("a dangerous enchant reads 'click again' once armed", () => {
    const l = layoutForgePanel(state({ armedItemId: "a" }));
    expect(l.enchant.armed).toBe(true);
    expect(l.enchant.label).toContain("BURNS");
    expect(layoutForgePanel(state({ armedItemId: "b" })).enchant.armed).toBe(false);
  });

  it("with no scroll the button is disabled, says why, and cannot be clicked", () => {
    const l = layoutForgePanel(state({ inventory: bag([W("a", 1, 3)], { main_hand: "a" }) }));
    expect(l.enchant.enabled).toBe(false);
    expect(l.enchant.label).toBe("No enchant scroll");
    expect(kinds(l)).not.toContain("forge_enchant");
  });

  it("a +15 weapon cannot be enchanted again", () => {
    const l = layoutForgePanel(state({ inventory: bag([W("a", 1, 15), { id: "s", typeId: 2, quantity: 4 }]) }));
    expect(l.enchant.enabled).toBe(false);
    expect(l.forecast.maxed).toBe(true);
    expect(kinds(l)).not.toContain("forge_enchant");
  });

  it("offers a Buy button per quantity, priced from the server's number, with affordability", () => {
    const l = layoutForgePanel(state({ gold: 1000 }));
    expect(l.shop.buttons.map((b) => b.quantity)).toEqual(BUY_QUANTITIES);
    expect(l.shop.buttons.map((b) => b.cost)).toEqual(BUY_QUANTITIES.map((q) => q * 400));
    expect(l.shop.buttons.map((b) => b.canAfford)).toEqual([true, false]);
    expect(l.hitAreas.filter((a) => a.kind === "forge_buy").map((a) => a.quantity)).toEqual(BUY_QUANTITIES);
  });

  it("never offers a purchase bigger than the server allows", () => {
    const l = layoutForgePanel(state({ enchantCfg: { ...CFG, maxScrollPurchase: 3 } }));
    expect(l.shop.buttons.map((b) => b.quantity)).toEqual([1]);
  });

  it("pages a long list, clamps a stale page, and only offers the arrows that go somewhere", () => {
    const many = Array.from({ length: ROWS_PER_PAGE + 3 }, (_, i) => W(`w${i}`, 1, 0));
    const inv = bag(many);
    const first = layoutForgePanel(state({ inventory: inv, selectedItemId: "w0", page: 0 }));
    expect(first.rows).toHaveLength(ROWS_PER_PAGE);
    expect(first.pages).toMatchObject({ count: 2, page: 0, prev: null });
    expect(first.pages.next).toBeTruthy();
    const second = layoutForgePanel(state({ inventory: inv, selectedItemId: "w0", page: 1 }));
    expect(second.rows).toHaveLength(3);
    expect(second.pages.next).toBeNull();
    expect(second.pages.prev).toBeTruthy();
    expect(layoutForgePanel(state({ inventory: inv, page: 99 })).pages.page).toBe(1);
    expect(layoutForgePanel(state({ inventory: inv, page: -4 })).pages.page).toBe(0);
  });

  it("an empty bag still lays out, with nothing to click but the close button", () => {
    const l = layoutForgePanel(state({ inventory: bag([]), selectedItemId: null }));
    expect(l.rows).toEqual([]);
    expect(l.forecast).toBeNull();
    expect(l.enchant.enabled).toBe(false);
    expect(l.enchant.label).toBe("Select a weapon");
    expect(kinds(l).filter((k) => k !== "forge_buy")).toEqual(["forge_close"]);
  });

  it("every hit area is inside the panel", () => {
    const l = layoutForgePanel(state());
    for (const a of l.hitAreas) {
      expect(a.box.x).toBeGreaterThanOrEqual(l.panel.x);
      expect(a.box.y).toBeGreaterThanOrEqual(l.panel.y);
      expect(a.box.x + a.box.w).toBeLessThanOrEqual(l.panel.x + l.panel.w);
      expect(a.box.y + a.box.h).toBeLessThanOrEqual(l.panel.y + l.panel.h);
    }
  });
});

// A canvas context that accepts any call and any assignment, so drawing can be exercised
// without a browser. It records the text drawn.
function fakeCtx() {
  const texts = [];
  const target = { texts, canvas: { width: 1280, height: 720 } };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (key === "createLinearGradient" || key === "createRadialGradient") return () => ({ addColorStop() {} });
      if (key === "measureText") return () => ({ width: 40 });
      if (key === "fillText" || key === "strokeText") return (text) => { texts.push(String(text)); };
      return () => {};
    },
    set(t, key, value) { t[key] = value; return true; },
  });
}

describe("drawForgePanel", () => {
  const inv = () => bag([W("a", 1, 3), W("b", 4, 12), { id: "s", typeId: 2, quantity: 4 }], { main_hand: "a" });
  const base = { inventory: inv(), enchantCfg: CFG, gold: 5000, selectedItemId: "a", page: 0, armedItemId: null, result: null };

  it("draws the weapons, the chance, the risk, the scrolls and the price", () => {
    const ctx = fakeCtx();
    drawForgePanel(ctx, layoutForgePanel(base), base, 5000);
    const all = ctx.texts.join("\n");
    expect(all).toContain("Village Blacksmith");
    expect(all).toContain("+3 sword");
    expect(all).toContain("+12 axe");
    expect(all).toContain("60%");
    expect(all).toContain("the weapon burns the weapon".replace("the weapon ", ""));
    expect(all).toContain("Standard: 4");
    expect(all).toContain("Buy 1 · 400g");
    expect(all).toContain("5,000");
    expect(all).toContain("IN HAND");
  });

  it("draws every state without throwing", () => {
    const states = [
      { ...base },
      { ...base, selectedItemId: "b" },
      { ...base, selectedItemId: null },
      { ...base, armedItemId: "a" },
      { ...base, inventory: bag([]), selectedItemId: null },
      { ...base, inventory: bag([W("a", 1, 15), { id: "s", typeId: 2, quantity: 1 }]), selectedItemId: "a" },
      { ...base, gold: 0 },
    ];
    for (const st of states) {
      expect(() => drawForgePanel(fakeCtx(), layoutForgePanel(st), st, 1234)).not.toThrow();
    }
  });

  it("plays each result animation at several moments without throwing", () => {
    for (const outcome of ["success", "destroyed", "safe_fail"]) {
      for (const level of [1, 5, 10, 15]) {
        for (const dt of [0, 400, 900, 1700]) {
          const st = { ...base, result: { outcome, level, at: 10_000 } };
          expect(() => drawForgePanel(fakeCtx(), layoutForgePanel(st), st, 10_000 + dt)).not.toThrow();
        }
      }
    }
  });

  it("names the outcome while it plays and shows the idle caption after", () => {
    const st = (outcome) => ({ ...base, result: { outcome, level: 4, at: 100 } });
    const text = (s, now) => { const c = fakeCtx(); drawForgePanel(c, layoutForgePanel(s), s, now); return c.texts.join("\n"); };
    expect(text(st("success"), 500)).toContain("+4!");
    expect(text(st("destroyed"), 500)).toContain("BURNED");
    expect(text(st("safe_fail"), 500)).toContain("fizzled");
    expect(text(st("destroyed"), 100 + FORGE_ANIM_MS + 50)).not.toContain("BURNED");
    expect(text(st("destroyed"), 100 + FORGE_ANIM_MS + 50)).toContain("The anvil is ready.");
  });
});

// ------------------------------------------------------------------ the Game wiring

const realWindow = globalThis.window;
const realPerf = globalThis.performance;
let clock = 0;

function makeGame() {
  const g = new Game();
  g.state = "playing";
  g.chunked = true;
  g.player = { x: 1000, y: 1000, width: 64, height: 64 };
  g.canvas = { width: 1280, height: 720 };
  g.camera = { screenX: 0, screenY: 0 };
  g.inventory = bag([W("a", 1, 2), W("b", 4, 0), { id: "s", typeId: 2, quantity: 3 }], { main_hand: "b" });
  g.enchantCfg = CFG;
  g.gold = 5000;
  g.blacksmiths = [{ x: 1032, y: 1032 }];
  g.toasts = [];
  g.showToast = (t) => g.toasts.push(t);
  g.blasts = [];
  g.sent = [];
  g.authorityClient = {
    sendEnchant: (s, i) => g.sent.push(["enchant", s, i]),
    sendBuyScrolls: (q, kind) => g.sent.push(["buyScrolls", q, kind]),
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

describe("the smith's menu in the game", () => {
  it("opens on the weapon in hand", () => {
    const g = makeGame();
    g.openForge();
    expect(g.forgeOpen).toBe(true);
    expect(g.forgeSelectedId).toBe("b");
  });

  it("refuses to open while another window is open (windows do not stack)", () => {
    const g = makeGame();
    g.gemShopOpen = true;
    g.openForge();
    expect(g.forgeOpen).toBe(false);
    const h = makeGame();
    h.openForge();
    expect(h._otherPanelOpen()).toBe(true);
    h.openInventory();
    expect(h.inventoryOpen).toBe(false);
    h.closeAllPanels();
    expect(h.forgeOpen).toBe(false);
  });

  it("keeps the selection you made when it is reopened", () => {
    const g = makeGame();
    g.openForge();
    g._onForgeHit({ kind: "forge_weapon", id: "a" });
    g.forgeOpen = false;
    g.openForge();
    expect(g.forgeSelectedId).toBe("a");
  });

  it("the close button and the page arrows work", () => {
    const g = makeGame();
    g.openForge();
    g._onForgeHit({ kind: "forge_page", delta: 1 });
    expect(g.forgePage).toBe(1);
    g._onForgeHit({ kind: "forge_page", delta: -5 });
    expect(g.forgePage).toBe(0);
    g._onForgeHit({ kind: "forge_close" });
    expect(g.forgeOpen).toBe(false);
  });

  it("Enchant sends the scroll and the weapon; a dangerous one needs the second click", () => {
    const g = makeGame();
    g.openForge();
    g._onForgeHit({ kind: "forge_weapon", id: "a" });         // +2 -> +3 is safe
    g._onForgeHit({ kind: "forge_enchant", id: "a" });
    expect(g.sent).toEqual([["enchant", "s", "a"]]);

    const h = makeGame();
    h.inventory.items.find((i) => i.id === "a").enchantLevel = 3;   // +3 -> +4 can burn it
    h.openForge();
    h._onForgeHit({ kind: "forge_weapon", id: "a" });
    h._onForgeHit({ kind: "forge_enchant", id: "a" });
    expect(h.sent).toEqual([]);
    expect(h._forgeState().armedItemId).toBe("a");
    clock += 1000;
    h._onForgeHit({ kind: "forge_enchant", id: "a" });
    expect(h.sent).toEqual([["enchant", "s", "a"]]);
  });

  it("choosing another weapon disarms the confirmation", () => {
    const g = makeGame();
    g.inventory.items.find((i) => i.id === "a").enchantLevel = 5;
    g.openForge();
    g._onForgeHit({ kind: "forge_weapon", id: "a" });
    g._onForgeHit({ kind: "forge_enchant", id: "a" });
    expect(g._forgeState().armedItemId).toBe("a");
    g._onForgeHit({ kind: "forge_weapon", id: "b" });
    expect(g._forgeState().armedItemId).toBeNull();
  });

  it("Buy sends the quantity, is refused when the purse is short, and a double-click buys once", () => {
    const g = makeGame();
    g._onForgeHit({ kind: "forge_buy", quantity: 5 });
    expect(g.sent).toEqual([["buyScrolls", 5, "standard"]]);
    g._onForgeHit({ kind: "forge_buy", quantity: 5 });
    expect(g.sent).toHaveLength(1);

    const poor = makeGame();
    poor.gold = 399;
    poor._onForgeHit({ kind: "forge_buy", quantity: 1 });
    expect(poor.sent).toEqual([]);
    expect(poor.toasts.join(" ")).toContain("Not enough gold");
  });

  it("the server's scroll sale replaces the stack, sets the wallet, and says what happened", () => {
    const g = makeGame();
    g._onScrollsBought({ item: { id: "s", typeId: 2, quantity: 8 }, added: 5, price: 2000, gold: 3000 });
    expect(g.inventory.items.find((i) => i.id === "s").quantity).toBe(8);
    expect(g.gold).toBe(3000);
    expect(g.toasts.join(" ")).toContain("+5 enchant scrolls");

    const fresh = makeGame();
    fresh.inventory.items = fresh.inventory.items.filter((i) => i.id !== "s");
    fresh._onScrollsBought({ item: { id: "n", typeId: 2, quantity: 1 }, added: 1, price: 400, gold: 4600 });
    expect(fresh.inventory.items.find((i) => i.id === "n").quantity).toBe(1);
    expect(fresh.toasts.join(" ")).toContain("+1 enchant scroll ");
  });

  it("a result starts the animation, and a burnt weapon leaves the list", () => {
    const g = makeGame();
    g.inventory.items.find((i) => i.id === "a").enchantLevel = 4;
    g.openForge();
    g._onForgeHit({ kind: "forge_weapon", id: "a" });
    g._onEnchanted({ outcome: "destroyed", destroyed: true, itemId: "a", scrollId: "s", scrollsLeft: 2, level: 4 });
    expect(g.forgeResult).toMatchObject({ outcome: "destroyed", level: 4, at: clock });
    expect(forgeWeapons(g.inventory).map((r) => r.item.id)).toEqual(["b"]);
    expect(g.forgeSelectedId).toBe("b");
    expect(g._forgeState().result.outcome).toBe("destroyed");
  });

  it("a success keeps the weapon selected and records the new level", () => {
    const g = makeGame();
    g.openForge();
    g._onForgeHit({ kind: "forge_weapon", id: "a" });
    g._onEnchanted({ outcome: "success", destroyed: false, itemId: "a", scrollId: "s", scrollsLeft: 2, level: 3 });
    expect(g.forgeSelectedId).toBe("a");
    expect(g.inventory.items.find((i) => i.id === "a").enchantLevel).toBe(3);
    expect(g.forgeResult.outcome).toBe("success");
  });

  it("walking away from the smith closes the menu", () => {
    const g = makeGame();
    g.openForge();
    g.remotePlayers = new Map();
    g._onWorldState({ tick: 1, players: [] });
    expect(g.forgeOpen).toBe(true);            // still next to him
    g.player.x = 5000;
    g._onWorldState({ tick: 2, players: [] });
    expect(g.forgeOpen).toBe(false);
  });

  it("the inventory no longer sends enchant requests from a click", () => {
    const g = makeGame();
    g.inventoryOpen = true;
    g.renderSystem = { _invHitAreas: [{ x: 0, y: 0, w: 100, h: 100, kind: "enchant", id: "a" }] };
    g._handleInventoryClick(10, 10);
    expect(g.sent).toEqual([]);
  });
});

describe("the blacksmith in the world", () => {
  it("draws a labelled marker, and the Enchant prompt only when you are close", async () => {
    const { RenderSystem } = await import("../RenderSystem.js");
    const draw = (player) => {
      const ctx = fakeCtx();
      const rs = Object.create(RenderSystem.prototype);
      rs.ctx = ctx;
      rs._drawPointArtAt = () => false;          // no art bound: the placeholder anvil
      rs.drawBlacksmith({ x: 1000, y: 1000, art: null }, player);
      return ctx.texts.join("\n");
    };
    expect(draw(null)).toContain("Blacksmith");
    expect(draw({ x: 1000, y: 1000, width: 64, height: 64 })).toContain("[e] Enchant");
    expect(draw({ x: 9000, y: 9000, width: 64, height: 64 })).not.toContain("[e] Enchant");
  });
});

describe("the smith sells two scrolls", () => {
  const CFG2 = { ...CFG, scrollPrice: 2000, blessedScrollItemName: "enchant_scroll_blessed", blessedScrollPrice: 6000 };
  const BLESSED = { id: 5, name: "enchant_scroll_blessed", category: "consumable" };
  const st = (over = {}) => {
    const inv = createInventory();
    for (const t of [SWORD, AXE, SCROLL, VEST, BLESSED]) inv.types.set(t.id, t);
    inv.items = [W("a", 1, 5), { id: "s", typeId: 2, quantity: 4 }, { id: "b", typeId: 5, quantity: 7 }];
    inv.equipment = { main_hand: "a" };
    return { inventory: inv, enchantCfg: CFG2, gold: 100000, selectedItemId: "a", page: 0, armedItemId: null, result: null, ...over };
  };

  it("has a row per scroll, each priced from its own number", () => {
    const l = layoutForgePanel(st());
    expect(l.shop.rows.map((r) => [r.kind, r.price, r.count])).toEqual([["standard", 2000, 4], ["blessed", 6000, 7]]);
    const costs = l.shop.buttons.map((b) => [b.kind, b.quantity, b.cost]);
    expect(costs).toEqual([
      ["standard", 1, 2000], ["standard", 5, 10000], ["blessed", 1, 6000], ["blessed", 5, 30000],
    ]);
  });

  it("each buy hit area names the scroll it buys", () => {
    const l = layoutForgePanel(st());
    const areas = l.hitAreas.filter((a) => a.kind === "forge_buy");
    expect(areas.map((a) => [a.scroll, a.quantity])).toEqual([["standard", 1], ["standard", 5], ["blessed", 1], ["blessed", 5]]);
  });

  it("the Enchant button sits below both rows and nothing overlaps or leaves the panel", () => {
    const l = layoutForgePanel(st());
    const lastBuy = Math.max(...l.shop.buttons.map((b) => b.box.y + b.box.h));
    expect(l.enchant.box.y).toBeGreaterThanOrEqual(lastBuy);
    expect(l.enchant.box.y + l.enchant.box.h).toBeLessThanOrEqual(l.panel.y + l.panel.h);
    for (const a of l.hitAreas) {
      expect(a.box.x + a.box.w).toBeLessThanOrEqual(l.panel.x + l.panel.w);
      expect(a.box.y + a.box.h).toBeLessThanOrEqual(l.panel.y + l.panel.h);
    }
  });

  it("without the blessed scroll in the config the panel is as before: one row", () => {
    const l = layoutForgePanel(st({ enchantCfg: CFG }));
    expect(l.shop.rows.map((r) => r.kind)).toEqual(["standard"]);
  });

  it("offers the blessed toggle only in the danger zone and only when one is owned", () => {
    const danger = layoutForgePanel(st());                         // +5 -> +6
    expect(danger.blessedToggle).toMatchObject({ on: false, count: 7 });
    expect(danger.hitAreas.some((a) => a.kind === "forge_blessed")).toBe(true);

    const safeInv = st();
    safeInv.inventory.items[0] = W("a", 1, 1);                     // +1 -> +2: safe
    expect(layoutForgePanel(safeInv).blessedToggle).toBeNull();

    const none = st();
    none.inventory.items = none.inventory.items.filter((i) => i.id !== "b");
    expect(layoutForgePanel(none).blessedToggle).toBeNull();
  });

  it("the toggle switches the plan to the blessed scroll and the forecast to 'drops back'", () => {
    const off = layoutForgePanel(st());
    expect(off.plan.scrollId).toBe("s");
    expect(off.forecast.failure).toBe("burns the weapon");

    const on = layoutForgePanel(st({ blessed: true }));
    expect(on.plan).toMatchObject({ scrollId: "b", blessed: true });
    expect(on.forecast.failure).toBe("drops back to +3");
    expect(on.blessedToggle.on).toBe(true);
  });

  it("draws both rows, the toggle and their prices", () => {
    const ctx = fakeCtx();
    const s = st({ blessed: true });
    drawForgePanel(ctx, layoutForgePanel(s), s, 5000);
    const all = ctx.texts.join("\n");
    expect(all).toContain("Standard: 4");
    expect(all).toContain("Blessed: 7");
    expect(all).toContain("Blessed scroll: ON (7)");
    expect(all).toContain("Buy 1 · 6,000g");
    expect(all).toContain("Buy 5 · 30,000g");
  });

  it("plays the blessed-miss animation without throwing", () => {
    const ctx = fakeCtx();
    const s = st({ result: { outcome: "reset", level: 3, at: 1000 } });
    drawForgePanel(ctx, layoutForgePanel(s), s, 1500);
    expect(ctx.texts.join("\n")).toContain("back to +3");
  });

  it("the game sends the kind it was asked for, and prices the refusal from that kind", () => {
    const g = makeGame();
    g.enchantCfg = CFG2;
    g.gold = 100000;
    g._onForgeHit({ kind: "forge_buy", quantity: 5, scroll: "blessed" });
    expect(g.sent).toEqual([["buyScrolls", 5, "blessed"]]);
    const poor = makeGame();
    poor.enchantCfg = CFG2;
    poor.gold = 1000;
    poor._onForgeHit({ kind: "forge_buy", quantity: 5, scroll: "blessed" });
    expect(poor.sent).toEqual([]);
    expect(poor.toasts.join(" ")).toMatch(/5 blessed scrolls cost 30,000g/);
  });

  it("the toggle flips in the game and disarms a pending confirmation", () => {
    const g = makeGame();
    g.enchantCfg = CFG2;
    g._enchantArmed = { itemId: "a", until: performance.now() + 5000 };
    g._onForgeHit({ kind: "forge_blessed" });
    expect(g.forgeBlessed).toBe(true);
    expect(g._enchantArmed).toBeNull();
    expect(g._forgeState().blessed).toBe(true);
    g._onForgeHit({ kind: "forge_blessed" });
    expect(g.forgeBlessed).toBe(false);
  });
});

describe("the weapon the skill tooltips read", () => {
  it("carries the enchant level's damage, so a +6 staff shows more than a +0 one", () => {
    const STAFF = { id: 7, name: "staff", category: "weapon", damage: 6.6, cooldown: 1, kind: "ranged" };
    const g = makeGame();
    g.inventory.types.set(STAFF.id, STAFF);
    g.inventory.items = [W("plain", 7, 0), W("forged", 7, 6)];

    g.inventory.equipment = { main_hand: "plain" };
    expect(g._resolveEquippedWeapon().damage).toBe(6.6);

    g.inventory.equipment = { main_hand: "forged" };
    const w = g._resolveEquippedWeapon();
    expect(w.damage).toBeCloseTo(6.6 * (1 + CFG.damagePerLevel * 6), 2);
    expect(w.damage).toBeGreaterThan(6.6);
    expect(w.enchantLevel).toBe(6);
    expect(w.name).toBe("staff");
    expect(STAFF.damage).toBe(6.6);              // the shared catalog row is never mutated
  });
});
