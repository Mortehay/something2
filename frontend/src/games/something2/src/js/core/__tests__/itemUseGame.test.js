import { describe, it, expect, vi } from "vitest";
import { Game } from "../Game.js";

// The Game side of using items and magic stones: what it sends, what it does with the server's
// answers, and the confirming step before a stone comes out. A bare Game stands in (no canvas, no
// socket); the rules themselves are tested in systems/__tests__/itemActions.test.js.
const SWORD = { id: 1, name: "short sword", category: "weapon", slot: "main_hand", kind: "melee" };
const MAP = { id: 4, name: "loot_map", category: "consumable" };
const SPELL = { id: 6, name: "storm staff stone", category: "stone", element: "lightning", stone_mode: "replace" };

function game(items, equipment = {}) {
  const g = Object.create(Game.prototype);
  g.inventory = {
    types: new Map([SWORD, MAP, SPELL].map((t) => [t.id, t])),
    items, equipment, ammoCounts: new Map(),
  };
  g.sent = [];
  g.authorityClient = {
    sendUse: (id) => g.sent.push(["use", id]),
    sendSocket: (s, h) => g.sent.push(["socket", s, h]),
    sendUnsocket: (s) => g.sent.push(["unsocket", s]),
  };
  g.toasts = [];
  g.showToast = (t) => g.toasts.push(t);
  g.tradeOpen = false;
  g.inventorySelectedItemId = null;
  g.player = { x: 1000, y: 1000 };
  return g;
}
const item = (id, typeId, over = {}) => ({ id, typeId, quantity: 1, ...over });

describe("use", () => {
  it("sends the loot map to the server", () => {
    const g = game([item("m", 4)]);
    g._runItemAction("use", "m");
    expect(g.sent).toEqual([["use", "m"]]);
  });
  it("does nothing during a trade, or for an item that is not there", () => {
    const g = game([item("m", 4)]);
    g.tradeOpen = true;
    g._runItemAction("use", "m");
    g.tradeOpen = false;
    g._runItemAction("use", "ghost");
    expect(g.sent).toEqual([]);
  });
  it("the reply removes the map and says which way the chest is", () => {
    const g = game([item("m", 4)]);
    g.inventorySelectedItemId = "m";
    g._onItemUsed({ itemId: "m", x: 1000 + 640, y: 1000 + 640 });
    expect(g.inventory.items).toEqual([]);
    expect(g.inventorySelectedItemId).toBeNull();
    expect(g.toasts[0]).toMatch(/guarded chest/i);
    expect(g.toasts[0]).toMatch(/\d+/);
  });
  it("a chest on top of you, or with no coordinates, still gets a message", () => {
    const g = game([item("m", 4)]);
    g._onItemUsed({ itemId: "m" });
    g._onItemUsed({ itemId: "m", x: 1001, y: 1001 });
    expect(g.toasts.length).toBe(2);
  });
});

describe("socket", () => {
  it("sockets a free stone into the weapon in hand", () => {
    const g = game([item("s", 6), item("w", 1)], { main_hand: "w" });
    g._runItemAction("socket", "s");
    expect(g.sent).toEqual([["socket", "s", "w"]]);
  });
  it("says why when there is nowhere to put it", () => {
    const g = game([item("s", 6)]);
    g._runItemAction("socket", "s");
    expect(g.sent).toEqual([]);
    expect(g.toasts.length).toBe(1);
  });
  it("says why when the weapon in hand already holds a stone", () => {
    const g = game([item("s", 6), item("w", 1, { socketedStoneItemId: "x", socketedStoneTypeId: 6 })], { main_hand: "w" });
    g._runItemAction("socket", "s");
    expect(g.sent).toEqual([]);
    expect(g.toasts[0]).toBeTruthy();
  });
  it("the reply records the stone in the weapon so the tooltip and the button follow", () => {
    const g = game([item("s", 6), item("w", 1)]);
    g._onSocketed({ stoneId: "s", hostId: "w" });
    const w = g.inventory.items.find((i) => i.id === "w");
    expect(w.socketedStoneItemId).toBe("s");
    expect(w.socketedStoneTypeId).toBe(6);
    expect(g.toasts.length).toBe(1);
  });
});

describe("taking a stone out needs a second click", () => {
  const socketed = () => game(
    [item("w", 1, { socketedStoneItemId: "s", socketedStoneTypeId: 6 }), item("s", 6)],
  );
  it("the first click only arms, and says what is at stake", () => {
    const g = socketed();
    vi.spyOn(performance, "now").mockReturnValue(1000);
    g._runItemAction("unsocket", "w");
    expect(g.sent).toEqual([]);
    expect(g._unsocketArmedId()).toBe("w");
    expect(g.toasts[0]).toMatch(/10%/);
  });
  it("the second click within the window sends the STONE's id", () => {
    const g = socketed();
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    g._runItemAction("unsocket", "w");
    now.mockReturnValue(2500);
    g._runItemAction("unsocket", "w");
    expect(g.sent).toEqual([["unsocket", "s"]]);
    expect(g._unsocketArmedId()).toBeNull();
  });
  it("works the same from the stone itself", () => {
    const g = socketed();
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    g._runItemAction("unsocket", "s");
    now.mockReturnValue(1500);
    g._runItemAction("unsocket", "s");
    expect(g.sent).toEqual([["unsocket", "s"]]);
  });
  it("a second click too late arms again instead of sending", () => {
    const g = socketed();
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    g._runItemAction("unsocket", "w");
    now.mockReturnValue(60_000);
    expect(g._unsocketArmedId()).toBeNull();
    g._runItemAction("unsocket", "w");
    expect(g.sent).toEqual([]);
    expect(g._unsocketArmedId()).toBe("w");
  });
  it("clicking a different item between the two re-arms for the new one", () => {
    const g = game([
      item("w", 1, { socketedStoneItemId: "s", socketedStoneTypeId: 6 }), item("s", 6),
      item("w2", 1, { socketedStoneItemId: "s2", socketedStoneTypeId: 6 }), item("s2", 6),
    ]);
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    g._runItemAction("unsocket", "w");
    now.mockReturnValue(1200);
    g._runItemAction("unsocket", "w2");
    expect(g.sent).toEqual([]);
    expect(g._unsocketArmedId()).toBe("w2");
  });
  it("the reply clears the stone from the weapon, and a shattered stone leaves the bag", () => {
    const g = socketed();
    g._onUnsocketed({ stoneId: "s", destroyed: false });
    expect(g.inventory.items.find((i) => i.id === "w").socketedStoneItemId).toBeUndefined();
    expect(g.inventory.items.find((i) => i.id === "s")).toBeTruthy();

    const h = socketed();
    h.inventorySelectedItemId = "s";
    h._onUnsocketed({ stoneId: "s", destroyed: true });
    expect(h.inventory.items.find((i) => i.id === "s")).toBeUndefined();
    expect(h.inventory.items.find((i) => i.id === "w").socketedStoneTypeId).toBeUndefined();
    expect(h.inventorySelectedItemId).toBeNull();
    expect(h.toasts[0]).toMatch(/shatter/i);
  });
});

describe("clicking in the panel", () => {
  const panel = (g, hits) => { g.renderSystem = { _invHitAreas: hits }; };
  const cell = { x: 0, y: 0, w: 10, h: 10, kind: "item", id: "m" };

  it("a single click selects, a click on the same item again deselects (unchanged)", () => {
    const g = game([item("m", 4)]);
    panel(g, [cell]);
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    g._handleInventoryClick(5, 5);
    expect(g.inventorySelectedItemId).toBe("m");
    expect(g.sent).toEqual([]);
    now.mockReturnValue(5000); // well after the double-click window
    g._handleInventoryClick(5, 5);
    expect(g.inventorySelectedItemId).toBeNull();
  });
  it("a double-click on a loot map uses it", () => {
    const g = game([item("m", 4)]);
    panel(g, [cell]);
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    g._handleInventoryClick(5, 5);
    now.mockReturnValue(1200);
    g._handleInventoryClick(5, 5);
    expect(g.sent).toEqual([["use", "m"]]);
  });
  it("a double-click on a free stone sockets it into the weapon in hand", () => {
    const g = game([item("s", 6), item("w", 1)], { main_hand: "w" });
    panel(g, [{ ...cell, id: "s" }]);
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    g._handleInventoryClick(5, 5);
    now.mockReturnValue(1100);
    g._handleInventoryClick(5, 5);
    expect(g.sent).toEqual([["socket", "s", "w"]]);
  });
  it("a double-click on a plain weapon does nothing but toggle the selection", () => {
    const g = game([item("w", 1)]);
    panel(g, [{ ...cell, id: "w" }]);
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    g._handleInventoryClick(5, 5);
    now.mockReturnValue(1100);
    g._handleInventoryClick(5, 5);
    expect(g.sent).toEqual([]);
  });
  it("a double-click never takes a stone out (that has its own confirming step)", () => {
    const g = game([item("w", 1, { socketedStoneItemId: "s", socketedStoneTypeId: 6 }), item("s", 6)]);
    panel(g, [{ ...cell, id: "w" }]);
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    g._handleInventoryClick(5, 5);
    now.mockReturnValue(1100);
    g._handleInventoryClick(5, 5);
    expect(g.sent).toEqual([]);
  });
  it("the footer button runs the selected item's action", () => {
    const g = game([item("m", 4)]);
    panel(g, [{ x: 0, y: 0, w: 10, h: 10, kind: "itemaction", id: "m", act: "use" }]);
    g._handleInventoryClick(5, 5);
    expect(g.sent).toEqual([["use", "m"]]);
  });
});
