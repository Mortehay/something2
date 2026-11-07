import { describe, it, expect } from "vitest";
import { bannerText, lockedRowText, lockedToastText, priceParts, buildShopRows } from "../shopReputation.js";

const rep = { points: 35, tier: "Friend", discountPct: 5, sellBonusPct: 5, nextTier: { name: "Honored", at: 100 } };

describe("shopReputation", () => {
  it("bannerText", () => {
    expect(bannerText(rep)).toBe("Reputation: Friend (35 rep) - 5% off, sells for +5% of item value; next: Honored at 100");
    expect(bannerText({ points: 0, tier: "Stranger", discountPct: 0, sellBonusPct: 0, nextTier: null })).toBe("Reputation: Stranger (0 rep)");
    expect(bannerText(null)).toBe("");
  });
  it("lockedRowText / toast", () => {
    const row = { minReputation: 100, requiredTier: "Honored" };
    expect(lockedRowText(row)).toBe("Requires Honored (100)");
    expect(lockedToastText(row, rep)).toBe("Requires Honored (100) - you have 35, need 65 more");
  });
  it("priceParts", () => {
    expect(priceParts({ price: 95, listPrice: 100 })).toEqual({ price: 95, listPrice: 100 });
    expect(priceParts({ price: 100 })).toEqual({ price: 100, listPrice: null });
    expect(priceParts({ price: 100, listPrice: 100 }).listPrice).toBe(null);
  });
  it("buildShopRows", () => {
    expect(buildShopRows([{ id: 1 }], [])).toEqual([{ id: 1 }]);
    const r = buildShopRows([{ id: 1 }], [{ id: 2, minReputation: 5 }]);
    expect(r).toHaveLength(3);
    expect(r[1].header).toBe("Locked wares");
    expect(r[2]).toMatchObject({ id: 2, locked: true });
  });
});

import { layoutMerchantWindow, drawItemWindow } from "../storageWindows.js";

function stubCtx() {
  const texts = [];
  return {
    texts, save() {}, restore() {}, fillRect() {}, strokeRect() {},
    fillText(text) { texts.push(text); }, drawImage() {},
    measureText(t) { return { width: String(t).length * 6 }; },
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {}, set font(_v) {},
    set textBaseline(_v) {}, set textAlign(_v) {}, set globalAlpha(_v) {},
  };
}

describe("merchant window with reputation", () => {
  const types = new Map([[1, { name: "Potion" }], [2, { name: "Blade" }]]);
  const shop = {
    villageId: 1,
    catalog: [{ id: 10, itemTypeId: 1, price: 95, listPrice: 100 }],
    buyback: [],
    lockedCatalog: [{ id: 11, itemTypeId: 2, price: 500, minReputation: 100, requiredTier: "Honored" }],
    reputation: { points: 35, tier: "Friend", discountPct: 5, sellBonusPct: 5, nextTier: { name: "Honored", at: 100 } },
  };
  const layout = layoutMerchantWindow({ shop, view: { tab: "catalog", page: 0 }, gold: 10, types });

  it("draws the banner and each ware's own price, with no list price (the plan drops it)", () => {
    const ctx = stubCtx();
    drawItemWindow(ctx, layout, {}, null);
    expect(layout.bannerLines.join(" ")).toBe(bannerText(shop.reputation));
    for (const line of layout.bannerLines) expect(ctx.texts).toContain(line);
    expect(ctx.texts).toContain("95");
    expect(ctx.texts).toContain("500");
    expect(ctx.texts).not.toContain("100");
  });

  it("a locked ware gets a locked cell and a locked hit area, never a buy area", () => {
    const area = layout.hitAreas.find((a) => a.kind === "lockedware");
    expect(area).toBeTruthy();
    expect(lockedRowText(area.row)).toContain("Requires Honored (100)");
    expect(layout.hitAreas.filter((a) => a.kind === "stockitem").map((a) => a.id)).toEqual([10]);
    expect(layout.cells[1].locked).toBe(true);
  });
});
