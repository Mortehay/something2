import { describe, it, expect } from "vitest";
import { layoutInventory } from "../inventoryPanel.js";
import { layoutChestWindow, layoutMerchantWindow } from "../storageWindows.js";
import {
  resolvePairedDrop, HINT_STORE, HINT_TAKE, HINT_SELL, HINT_BUY, REFUSE_WORN,
} from "../pairedDrop.js";

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
