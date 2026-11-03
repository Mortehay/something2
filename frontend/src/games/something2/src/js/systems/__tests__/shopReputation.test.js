import { describe, it, expect } from "vitest";
import { bannerText, lockedRowText, lockedToastText, priceParts, buildShopRows } from "../shopReputation.js";

const rep = { villageKey: "sunspire", points: 35, tier: "Friend", discountPct: 5, sellBonusPct: 5, nextTier: { name: "Honored", at: 100 } };

describe("shopReputation", () => {
  it("bannerText", () => {
    expect(bannerText(rep)).toBe("Sunspire: Friend (35 rep) - 5% off, +5% sell price; next: Honored at 100");
    expect(bannerText({ villageKey: null, points: 0, tier: "Stranger", discountPct: 0, sellBonusPct: 0, nextTier: null })).toBe("Reputation: Stranger (0 rep)");
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

import { RenderSystem } from "../RenderSystem.js";
import { Game } from "../../core/Game.js";

function stubCtx() {
  const texts = [];
  return {
    texts, save() {}, restore() {}, fillRect() {}, strokeRect() {},
    fillText(text) { texts.push(text); }, drawImage() {},
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {}, set font(_v) {},
    set textBaseline(_v) {}, set textAlign(_v) {}, set globalAlpha(_v) {},
  };
}

describe("shop panel with reputation", () => {
  const types = new Map([[1, { name: "Potion" }], [2, { name: "Blade" }]]);
  const shop = {
    villageId: 1,
    catalog: [{ id: 10, itemTypeId: 1, price: 95, listPrice: 100 }],
    buyback: [],
    lockedCatalog: [{ id: 11, itemTypeId: 2, price: 500, minReputation: 100, requiredTier: "Honored" }],
    reputation: { villageKey: "sunspire", points: 35, tier: "Friend", discountPct: 5, sellBonusPct: 5, nextTier: { name: "Honored", at: 100 } },
  };
  function draw() {
    const ctx = stubCtx();
    const hitAreas = [];
    new RenderSystem({ getContext: () => ctx }, null).renderShop(ctx, shop, { items: [], types: new Map() }, types, 10, hitAreas, { tab: "catalog", page: 0 });
    return { ctx, hitAreas };
  }

  it("draws banner, struck list price and locked section", () => {
    const { ctx } = draw();
    expect(ctx.texts).toContain(bannerText(shop.reputation));
    expect(ctx.texts).toContain("100 g");
    expect(ctx.texts).toContain("95 g");
    expect(ctx.texts.some((t) => t.includes("Locked wares"))).toBe(true);
    expect(ctx.texts.some((t) => t.includes("Requires Honored (100)"))).toBe(true);
  });

  it("clicking a locked row toasts and sends nothing", () => {
    const { hitAreas } = draw();
    const area = hitAreas.find((a) => a.kind === "lockedware");
    expect(area).toBeTruthy();
    const sent = [];
    const toasts = [];
    const game = {
      shop, shopOpen: true, shopView: { tab: "catalog", page: 0 },
      renderSystem: { _shopHitAreas: hitAreas },
      authorityClient: { sendBuy: (id) => sent.push(id), sendSell: (id) => sent.push(id) },
      showToast: (m) => toasts.push(m),
    };
    Game.prototype._handleShopClick.call(game, area.x + 5, area.y + 5);
    expect(sent).toEqual([]);
    expect(toasts[0]).toContain("Requires Honored (100)");
  });
});
