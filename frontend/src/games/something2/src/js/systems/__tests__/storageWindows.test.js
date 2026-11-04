import { describe, it, expect } from "vitest";
import {
  layoutChestWindow, layoutMerchantWindow, WINDOW_X, WINDOW_Y, WINDOW_W, WINDOW_CELLS,
} from "../storageWindows.js";
import { PANEL_H } from "../inventoryPanel.js";

const types = new Map([[1, { id: 1, name: "Sword" }], [2, { id: 2, name: "Potion" }]]);
const chestRows = (n) => Array.from({ length: n }, (_, i) => ({
  id: 100 + i, slot: i, typeId: i % 2 ? 1 : 2, quantity: 1, soulbound: false,
}));
const mrow = (id, extra = {}) => ({ id, itemTypeId: 1, price: 10 + id, quantity: 1, sellerUserId: null, ...extra });
const inside = (r) => r.x >= WINDOW_X && r.y >= WINDOW_Y && r.x + r.w <= WINDOW_X + WINDOW_W && r.y + r.h <= WINDOW_Y + PANEL_H;

describe("layoutChestWindow", () => {
  it("all 40 stored items have a cell and a hit area with no paging", () => {
    const rows = chestRows(40);
    const l = layoutChestWindow({ bank: { villageId: 1, items: rows, capacity: 40 }, types });
    expect(l.kind).toBe("chest");
    expect(l.cells).toHaveLength(WINDOW_CELLS);
    expect(l.cells.every((c) => c.item)).toBe(true);
    const ids = l.hitAreas.filter((h) => h.kind === "chestitem").map((h) => h.id).sort();
    expect(ids).toEqual(rows.map((r) => r.id).sort());
    expect(l.hitAreas.some((h) => h.kind === "winclose")).toBe(true);
  });
  it("every rect stays inside the window", () => {
    const l = layoutChestWindow({ bank: { items: chestRows(40), capacity: 40 }, types });
    for (const r of [l.close, ...l.cells, ...l.hitAreas]) expect(inside(r)).toBe(true);
  });
  it("an item of unknown type still has a cell and a hit area", () => {
    const l = layoutChestWindow({ bank: { items: [{ id: 7, slot: 3, typeId: 999, quantity: 2, soulbound: true }], capacity: 40 }, types });
    expect(l.cells[3].item.typeId).toBe(999);
    expect(l.cells[3].type).toBeNull();
    expect(l.cells[3].item.soulbound).toBe(true);
    expect(l.hitAreas.find((h) => h.kind === "chestitem")).toMatchObject({ id: 7, typeId: 999 });
  });
  it("occupancy reports full at capacity", () => {
    expect(layoutChestWindow({ bank: { items: chestRows(40), capacity: 40 }, types }).occupancy).toEqual({ used: 40, capacity: 40, full: true });
    expect(layoutChestWindow({ bank: { items: chestRows(39), capacity: 40 }, types }).occupancy.full).toBe(false);
  });
});

describe("layoutMerchantWindow", () => {
  const shopOf = (n, locked = []) => ({
    catalog: Array.from({ length: n }, (_, i) => mrow(i + 1)),
    buyback: [], lockedCatalog: locked, reputation: null, sellQuotes: {},
  });
  it("catalog rows then locked rows, with no header cell", () => {
    const l = layoutMerchantWindow({ shop: shopOf(2, [mrow(50, { minReputation: 5 })]), view: { tab: "catalog", page: 0 }, gold: 5, types });
    const filled = l.cells.filter((c) => c.item);
    expect(filled.map((c) => c.item.id)).toEqual([1, 2, 50]);
    expect(filled.map((c) => !!c.locked)).toEqual([false, false, true]);
    expect(l.tabs[0]).toMatchObject({ id: "catalog", count: 2 });
    expect(l.banner).toBeNull();
    expect(l.gold).toBe(5);
  });
  it("a stale page clamps to a real page", () => {
    const l = layoutMerchantWindow({ shop: shopOf(5), view: { tab: "catalog", page: 9 }, gold: 0, types });
    expect(l.pages.index).toBe(0);
    expect(l.cells.filter((c) => c.item)).toHaveLength(5);
    const neg = layoutMerchantWindow({ shop: shopOf(61), view: { tab: "catalog", page: -3 }, gold: 0, types });
    expect(neg.pages.index).toBe(0);
  });
  it("61 rows are all reachable by paging, with no repeats or gaps", () => {
    const shop = shopOf(61);
    const seen = [];
    let page = 0;
    for (let guard = 0; guard < 5; guard += 1) {
      const l = layoutMerchantWindow({ shop, view: { tab: "catalog", page }, gold: 0, types });
      expect(l.pages.count).toBe(2);
      seen.push(...l.hitAreas.filter((h) => h.kind === "stockitem").map((h) => h.id));
      const nxt = l.hitAreas.find((h) => h.kind === "shoppage" && h.id === l.pages.index + 1);
      if (!nxt) break;
      page = nxt.id;
    }
    expect(seen).toEqual(Array.from({ length: 61 }, (_, i) => i + 1));
  });
  it("merchant rows normalise itemTypeId to typeId", () => {
    const shop = shopOf(0);
    shop.catalog = [mrow(1, { itemTypeId: 2, rarity: "rare", affixes: [{ a: 1 }], enchantLevel: 3 })];
    const l = layoutMerchantWindow({ shop, view: { tab: "catalog", page: 0 }, gold: 0, types });
    expect(l.cells[0].item).toMatchObject({ typeId: 2, rarity: "rare", quantity: 1, enchantLevel: 3, affixes: [{ a: 1 }] });
    expect(l.cells[0].type).toBe(types.get(2));
    expect(l.hitAreas.find((h) => h.kind === "stockitem")).toMatchObject({ id: 1, typeId: 2, price: 11 });
  });
  it("the buyback tab's cells use the row's id and stored price", () => {
    const shop = { ...shopOf(3), buyback: [mrow(77, { price: 123, listPrice: 500 })] };
    const l = layoutMerchantWindow({ shop, view: { tab: "buyback", page: 0 }, gold: 0, types });
    expect(l.tabs.find((t) => t.id === "buyback")).toMatchObject({ count: 1, active: true });
    expect(l.cells.filter((c) => c.item)).toHaveLength(1);
    expect(l.cells[0].price).toBe(123);
    expect(l.hitAreas.find((h) => h.kind === "stockitem")).toMatchObject({ id: 77, price: 123 });
  });
  it("a locked cell's hit kind is lockedware and is never stockitem", () => {
    const lockedRow = mrow(50, { minReputation: 5 });
    const l = layoutMerchantWindow({ shop: shopOf(1, [lockedRow]), view: { tab: "catalog", page: 0 }, gold: 0, types });
    const c = l.cells[1];
    const hit = l.hitAreas.filter((h) => h.x === c.x && h.y === c.y);
    expect(hit).toHaveLength(1);
    expect(hit[0].kind).toBe("lockedware");
    expect(hit[0].row).toMatchObject(lockedRow);
    expect(l.hitAreas.some((h) => h.kind === "stockitem" && h.id === 50)).toBe(false);
  });
  it("keeps every rect inside the window, with a banner", () => {
    const shop = { ...shopOf(61), reputation: { tier: "Friend", villageKey: "oak", points: 3 } };
    const l = layoutMerchantWindow({ shop, view: { tab: "catalog", page: 0 }, gold: 0, types });
    expect(l.banner).toContain("Friend");
    for (const r of [l.close, ...l.cells, ...l.hitAreas]) expect(inside(r)).toBe(true);
  });
});
