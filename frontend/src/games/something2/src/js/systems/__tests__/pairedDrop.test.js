import { describe, it, expect } from "vitest";
import { layoutInventory } from "../inventoryPanel.js";
import { layoutChestWindow, layoutMerchantWindow } from "../storageWindows.js";
import {
  resolvePairedDrop, HINT_STORE, HINT_TAKE, HINT_SELL, HINT_BUY, REFUSE_WORN, HINT_OFFER, HINT_UNOFFER,
} from "../pairedDrop.js";
import { layoutTradeWindow } from "../tradeWindow.js";

const SWORD = { id: 1, name: "short sword", category: "weapon", slot: "main_hand", damage: 5, cooldown: 1 };
const HELM = { id: 2, name: "iron helm", category: "armor", slot: "head", defense: 3, resistances: {} };
const types = new Map([[1, SWORD], [2, HELM]]);

function inv({ items = [], equipment = {}, capacity = 48 } = {}) {
  return { types, items, equipment, ammoCounts: new Map(), capacity };
}
const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

const inventory = inv({ items: [{ id: "w", typeId: 1, quantity: 1 }, { id: "h", typeId: 2, quantity: 1 }] });
const worn = inv({ items: [{ id: "h", typeId: 2, quantity: 1 }], equipment: { head: "h" } });
const full = inv({ items: [{ id: "w", typeId: 1, quantity: 1 }, { id: "h", typeId: 2, quantity: 1 }], capacity: 2 });

const P = { originX: 437, paired: true };
const invLayout = layoutInventory({ inventory, ...P });
const wornLayout = layoutInventory({ inventory: worn, ...P });
const charLayout = layoutInventory({ inventory, tab: "character", ...P });
const chest = layoutChestWindow({ bank: { items: [], capacity: 40 }, types });
const chestFull = layoutChestWindow({
  bank: { items: Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, typeId: 1, slot: i })), capacity: 40 }, types,
});
const merchant = layoutMerchantWindow({ shop: { catalog: [], buyback: [] }, view: {}, gold: 0, types });

const slot = (name, l = invLayout) => l.slots.find((s) => s.slot === name);
const awayFromSlots = () => {
  const c = invLayout.cells[0];
  return centre(c);
};
const item = (id) => ({ itemId: id, from: { kind: "item", id } });
const run = (o) => resolvePairedDrop({ inventory, sellQuotes: undefined, gold: 0, invLayout, ...o });

describe("resolvePairedDrop", () => {
  it("stores an item dropped on the chest window", () => {
    expect(run({ drag: item("w"), point: centre(chest.cells[0]), winLayout: chest })).toEqual({
      action: "store", id: "w", hint: HINT_STORE, target: "window",
    });
  });
  it("stores without a hint when the chest is full", () => {
    const r = run({ drag: item("w"), point: centre(chestFull.cells[0]), winLayout: chestFull });
    expect(r.action).toBe("store");
    expect(r.hint).toBeUndefined();
    expect(r.target).toBeUndefined();
  });
  it("sells a quoted item with a hint", () => {
    const r = run({ drag: item("w"), point: centre(merchant.cells[0]), winLayout: merchant, sellQuotes: { w: 40 } });
    expect(r).toEqual({ action: "sell", id: "w", hint: "Sell for 40 g", target: "window" });
    expect(HINT_SELL).toBe("Sell for {n} g");
  });
  it("sells without a hint when there is no quote", () => {
    for (const sellQuotes of [undefined, {}, { h: 9 }]) {
      const r = run({ drag: item("w"), point: centre(merchant.cells[0]), winLayout: merchant, sellQuotes });
      expect(r).toEqual({ action: "sell", id: "w" });
    }
  });
  it("refuses a worn item on either window", () => {
    for (const winLayout of [chest, merchant]) {
      const r = run({ drag: item("h"), point: centre(winLayout.cells[0]), winLayout, inventory: worn, invLayout: wornLayout, sellQuotes: { h: 5 } });
      expect(r).toEqual({ action: "refuse", message: REFUSE_WORN });
    }
    expect(REFUSE_WORN).toBe("unequip it first");
  });
  it("refuses an equipment slot dragged onto either window", () => {
    for (const winLayout of [chest, merchant]) {
      const r = run({ drag: { itemId: "h", from: { kind: "slot", id: "head" } }, point: centre(winLayout.cells[0]), winLayout, inventory: worn, invLayout: wornLayout });
      expect(r).toEqual({ action: "refuse", message: REFUSE_WORN });
    }
  });
  it("unequips an occupied slot dropped on an inventory cell; empty slot is none", () => {
    const drag = { itemId: "h", from: { kind: "slot", id: "head" } };
    expect(run({ drag, point: centre(wornLayout.cells[3]), winLayout: chest, inventory: worn, invLayout: wornLayout })).toEqual({ action: "unequip", slot: "head" });
    const empty = { itemId: null, from: { kind: "slot", id: "head" } };
    expect(run({ drag: empty, point: centre(chest.cells[0]), winLayout: chest }).action).toBe("none");
    expect(run({ drag: empty, point: awayFromSlots(), winLayout: chest }).action).toBe("none");
  });
  it("equips an item dropped on a legal slot; illegal slot is none", () => {
    expect(run({ drag: item("w"), point: centre(slot("main_hand")), winLayout: chest })).toEqual({ action: "equip", itemId: "w", slot: "main_hand" });
    expect(run({ drag: item("w"), point: centre(slot("head")), winLayout: chest })).toEqual({ action: "none" });
  });
  it("does nothing for an item on an inventory cell or chrome", () => {
    expect(run({ drag: item("w"), point: awayFromSlots(), winLayout: chest })).toEqual({ action: "none" });
    expect(run({ drag: item("w"), point: { x: invLayout.panel.x + 3, y: invLayout.panel.y + 3 }, winLayout: chest })).toEqual({ action: "none" });
  });
  it("takes a chest item dropped on the inventory", () => {
    const drag = { itemId: null, from: { kind: "chestitem", id: "row9" } };
    expect(run({ drag, point: awayFromSlots(), winLayout: chest })).toEqual({ action: "take", id: "row9", hint: HINT_TAKE, target: "inventory" });
  });
  it("takes with no hint when the inventory is full", () => {
    const drag = { from: { kind: "chestitem", id: "row9" } };
    const l = layoutInventory({ inventory: full, ...P });
    const r = run({ drag, point: centre(l.cells[0]), winLayout: chest, inventory: full, invLayout: l });
    expect(r).toEqual({ action: "take", id: "row9" });
  });
  it("takes over the Character tab and a page-2 grid", () => {
    expect(charLayout.character).not.toBeNull();
    const drag = { from: { kind: "chestitem", id: "row9" } };
    const p = { x: charLayout.panel.x + charLayout.panel.w - 20, y: charLayout.panel.y + charLayout.panel.h - 20 };
    expect(run({ drag, point: p, winLayout: chest, invLayout: charLayout }).action).toBe("take");
    const page2 = layoutInventory({ inventory, page: 1, ...P });
    expect(run({ drag, point: centre(page2.cells[0]), winLayout: chest, invLayout: page2 }).action).toBe("take");
  });
  it("buys a stock item with a hint when affordable", () => {
    const drag = { from: { kind: "stockitem", id: "s1" }, price: 120 };
    expect(run({ drag, point: awayFromSlots(), winLayout: merchant, gold: 500 })).toEqual({ action: "buy", id: "s1", hint: "Buy for 120 g", target: "inventory" });
    expect(HINT_BUY).toBe("Buy for {n} g");
    expect(HINT_TAKE).toBe("Take");
    expect(HINT_STORE).toBe("Store in chest");
  });
  it("buys without a hint when poor or full", () => {
    const drag = { from: { kind: "stockitem", id: "s1" }, price: 120 };
    expect(run({ drag, point: awayFromSlots(), winLayout: merchant, gold: 50 })).toEqual({ action: "buy", id: "s1" });
    const l = layoutInventory({ inventory: full, ...P });
    expect(run({ drag, point: centre(l.cells[0]), winLayout: merchant, gold: 500, inventory: full, invLayout: l })).toEqual({ action: "buy", id: "s1" });
  });
  it("ignores window stock dropped on a slot or its own window", () => {
    for (const [kind, winLayout] of [["chestitem", chest], ["stockitem", merchant]]) {
      const drag = { from: { kind, id: "x" }, price: 1 };
      expect(run({ drag, point: centre(slot("main_hand")), winLayout, gold: 9 })).toEqual({ action: "none" });
      expect(run({ drag, point: centre(winLayout.cells[0]), winLayout, gold: 9 })).toEqual({ action: "none" });
    }
  });
  it("does nothing outside both windows, never a ground drop", () => {
    const far = { x: 5, y: 5 };
    for (const drag of [item("w"), { itemId: "h", from: { kind: "slot", id: "head" } }, { from: { kind: "chestitem", id: "r" } }, { from: { kind: "stockitem", id: "r" }, price: 1 }]) {
      expect(run({ drag, point: far, winLayout: chest, gold: 9 })).toEqual({ action: "none" });
    }
  });
});

describe("resolvePairedDrop on the trade window", () => {
  const side = (items = [], over = {}) => ({ items, gold: 0, locked: false, confirmed: false, ...over });
  const offered = (id) => ({ id, typeId: 1, quantity: 1, type: SWORD });
  const tradeOf = (mine, theirs = side()) => layoutTradeWindow({
    trade: { partnerName: "Bob", phase: "open", mine, theirs }, types, goldField: null, nowMs: 0,
  });
  const open = tradeOf(side());
  const lockedWin = tradeOf(side([offered("w")], { locked: true }));
  const withW = tradeOf(side([offered("w")]));

  it("offers an inventory item dropped on the window, with a hint", () => {
    expect(run({ drag: item("w"), point: centre(open.myCells[0]), winLayout: open })).toEqual({
      action: "offer", id: "w", hint: HINT_OFFER, target: "window",
    });
    expect(HINT_OFFER).toBe("Offer in trade");
  });
  it("refuses a worn item", () => {
    const r = run({ drag: { itemId: "h", from: { kind: "item", id: "h" } }, point: centre(open.myCells[0]), winLayout: open, inventory: worn });
    expect(r).toEqual({ action: "refuse", message: REFUSE_WORN });
  });
  it("does not offer an item twice", () => {
    expect(run({ drag: item("w"), point: centre(withW.myCells[1]), winLayout: withW })).toEqual({ action: "none" });
  });
  it("sends no hint at the 16-item limit, so the server's refusal is the answer", () => {
    const sixteen = tradeOf(side(Array.from({ length: 16 }, (_, i) => offered(`o${i}`))));
    expect(run({ drag: item("w"), point: centre(sixteen.myCells[0]), winLayout: sixteen })).toEqual({ action: "offer", id: "w" });
  });
  it("takes an offered item back when it is dropped on the inventory", () => {
    const drag = { from: { kind: "tradeitem", id: "w" } };
    expect(run({ drag, point: awayFromSlots(), winLayout: withW })).toEqual({
      action: "unoffer", id: "w", hint: HINT_UNOFFER, target: "inventory",
    });
    expect(HINT_UNOFFER).toBe("Take back");
  });
  it("does nothing for a tradeitem dropped on an equipment slot or its own window", () => {
    const drag = { from: { kind: "tradeitem", id: "w" } };
    expect(run({ drag, point: centre(slot("main_hand")), winLayout: withW })).toEqual({ action: "none" });
    expect(run({ drag, point: centre(withW.myCells[3]), winLayout: withW })).toEqual({ action: "none" });
  });
  it("does nothing at all while my side is locked", () => {
    expect(run({ drag: item("w"), point: centre(lockedWin.myCells[0]), winLayout: lockedWin })).toEqual({ action: "none" });
    expect(run({ drag: { from: { kind: "tradeitem", id: "w" } }, point: awayFromSlots(), winLayout: lockedWin })).toEqual({ action: "none" });
  });
  it("does nothing while settling", () => {
    const settling = layoutTradeWindow({
      trade: { partnerName: "Bob", phase: "settling", mine: side([offered("w")], { locked: true }), theirs: side([], { locked: true }) },
      types, goldField: null, nowMs: 0,
    });
    expect(run({ drag: item("h"), point: centre(settling.myCells[0]), winLayout: settling })).toEqual({ action: "none" });
  });
  it("never equips or unequips during a trade: the server refuses every inventory change", () => {
    expect(run({ drag: { itemId: "h", from: { kind: "item", id: "h" } }, point: centre(slot("head")), winLayout: open })).toEqual({ action: "none" });
    expect(run({ drag: { itemId: "h", from: { kind: "slot", id: "head" } }, point: centre(invLayout.cells[0]), winLayout: open, inventory: worn, invLayout: wornLayout })).toEqual({ action: "none" });
  });
  it("still refuses a worn item dragged onto the trade window", () => {
    expect(run({ drag: { itemId: "h", from: { kind: "slot", id: "head" } }, point: centre(open.myCells[0]), winLayout: open, inventory: worn, invLayout: wornLayout }))
      .toEqual({ action: "refuse", message: REFUSE_WORN });
  });
});
