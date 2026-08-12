import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { Game } from "../../core/Game.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../../core/constants.js";

// Regression cover for SOMET-156: the shop panel's buyback stock was drawn
// (and hit-tested) BELOW the panel's bottom edge and was therefore unreachable
// at the live stock size — a village carries 24 catalog rows, the old stacked
// layout fit ~10, and the "Buyback" heading landed past py+panelH. Selling
// worked; buying anything back was impossible, which is the whole slice.
//
// These tests drive the real renderShop with a recording 2D-context stub and
// the real Game._handleShopClick, so they assert the two properties that were
// actually violated: every row a player can SEE is clickable, and every list
// is reachable in full.

const PANEL_W = 760;
const PANEL_H = 560;
const PX = (GAME_WIDTH - PANEL_W) / 2;   // 260
const PY = (GAME_HEIGHT - PANEL_H) / 2;  // 80
const LEFT_X = PX + 16;
const COL_W = 340;
const ROW_H = 40;

// Recording 2D context: renderShop only ever writes to a context, so we
// capture the geometry it draws (fillRect) and the labels (fillText) and
// assert against those rather than against pixels.
function stubCtx() {
  const fillRects = [];
  const texts = [];
  return {
    fillRects,
    texts,
    save() {},
    restore() {},
    fillRect(x, y, w, h) { fillRects.push({ x, y, w, h }); },
    strokeRect() {},
    fillText(text, x, y) { texts.push({ text, x, y }); },
    set fillStyle(_v) {},
    set strokeStyle(_v) {},
    set lineWidth(_v) {},
    set font(_v) {},
    set textBaseline(_v) {},
    set textAlign(_v) {},
  };
}

function renderer(ctx) {
  // RenderSystem's constructor only needs getContext(); nothing in renderShop
  // touches the canvas itself.
  return new RenderSystem({ getContext: () => ctx }, null);
}

// The live shape: 24 sellable item types per village (confirmed against the
// merchant_stock rows: 96 rows / 4 villages), plus the buyback rows THIS
// player sold in — since SOMET-280 the server sends no one else's.
const CATALOG = Array.from({ length: 24 }, (_, i) => ({
  id: 100 + i, itemTypeId: 1 + i, price: 10 + i,
}));
const BUYBACK = Array.from({ length: 5 }, (_, i) => ({
  id: 900 + i, itemTypeId: 3 + i, price: 5 + i,
}));

const ITEM_TYPES = new Map(
  Array.from({ length: 40 }, (_, i) => [1 + i, { id: 1 + i, name: `Item ${1 + i}` }]),
);

const SHOP = { villageId: 7, catalog: CATALOG, buyback: BUYBACK };
const INVENTORY = { items: [], types: new Map(), equipment: {} };

function renderShop(view) {
  const ctx = stubCtx();
  const hitAreas = [];
  renderer(ctx).renderShop(ctx, SHOP, INVENTORY, ITEM_TYPES, 500, hitAreas, view);
  return { ctx, hitAreas };
}

function insidePanel(a) {
  return a.x >= PX && a.y >= PY && a.x + a.w <= PX + PANEL_W && a.y + a.h <= PY + PANEL_H;
}

// The row backgrounds renderShop paints in the stock column: full column
// width, one row high, at the column's left edge.
function drawnRowRects(ctx) {
  return ctx.fillRects.filter((r) => r.x === LEFT_X && r.w === COL_W && r.h === ROW_H);
}

describe("renderShop buyback reachability (SOMET-156)", () => {
  it("draws a buy control for every buyback row, inside the panel", () => {
    const { ctx, hitAreas } = renderShop({ tab: "buyback", page: 0 });

    const buys = hitAreas.filter((a) => a.kind === "buy");
    // Every buyback stock id must be clickable, and nothing else.
    expect(buys.map((a) => a.id)).toEqual(BUYBACK.map((r) => r.id));
    for (const a of buys) expect(insidePanel(a)).toBe(true);
    // ...and each one must actually have a row drawn under it.
    expect(drawnRowRects(ctx)).toHaveLength(BUYBACK.length);
  });

  it("keeps every drawn stock row clickable on both tabs", () => {
    for (const tab of ["catalog", "buyback"]) {
      const { ctx, hitAreas } = renderShop({ tab, page: 0 });
      const rows = drawnRowRects(ctx);
      const buys = hitAreas.filter((a) => a.kind === "buy");
      expect(rows.length).toBeGreaterThan(0);
      expect(buys).toHaveLength(rows.length);
      // Each buy rect must sit inside the row it belongs to — a hit area that
      // has drifted off its row looks like it works and does not.
      rows.forEach((row, i) => {
        const b = buys[i];
        expect(b.y).toBeGreaterThanOrEqual(row.y);
        expect(b.y + b.h).toBeLessThanOrEqual(row.y + row.h);
        expect(b.x).toBeGreaterThanOrEqual(row.x);
        expect(b.x + b.w).toBeLessThanOrEqual(row.x + row.w);
      });
      // Every drawn row is fully on-panel (the old layout drew rows and a
      // section heading past py+panelH).
      for (const row of rows) expect(insidePanel({ ...row })).toBe(true);
      for (const t of ctx.texts) expect(t.y).toBeLessThan(PY + PANEL_H);
    }
  });

  it("makes all 24 catalog rows reachable by paging, with no repeats or gaps", () => {
    const seen = [];
    let page = 0;
    for (let guard = 0; guard < 20; guard += 1) {
      const { hitAreas } = renderShop({ tab: "catalog", page });
      const buys = hitAreas.filter((a) => a.kind === "buy");
      expect(buys.length).toBeGreaterThan(0);
      for (const a of buys) {
        expect(insidePanel(a)).toBe(true);
        seen.push(a.id);
      }
      const next = hitAreas.find((a) => a.kind === "shoppage" && a.id > page);
      if (!next) break;
      page = next.id;
    }
    expect(seen).toEqual(CATALOG.map((r) => r.id));
  });

  it("offers a tab control for each list, so buyback is reachable at all", () => {
    const { hitAreas } = renderShop({ tab: "catalog", page: 0 });
    const tabs = hitAreas.filter((a) => a.kind === "shoptab");
    expect(tabs.map((a) => a.id).sort()).toEqual(["buyback", "catalog"]);
    for (const a of tabs) expect(insidePanel(a)).toBe(true);
  });

  it("keeps every hit area of any kind inside the panel", () => {
    for (const view of [{ tab: "catalog", page: 0 }, { tab: "catalog", page: 2 }, { tab: "buyback", page: 0 }]) {
      const { hitAreas } = renderShop(view);
      for (const a of hitAreas) expect(insidePanel(a)).toBe(true);
    }
  });

  it("clamps a stale page instead of rendering an empty list", () => {
    // Buying the last buyback row while on the last page can leave `page`
    // past the end; the panel must still show real, clickable stock.
    const { hitAreas } = renderShop({ tab: "buyback", page: 99 });
    const buys = hitAreas.filter((a) => a.kind === "buy");
    expect(buys.map((a) => a.id)).toEqual(BUYBACK.map((r) => r.id));
  });

  it("still shows the empty-stock message on-panel when a list is empty", () => {
    const ctx = stubCtx();
    const hitAreas = [];
    renderer(ctx).renderShop(
      ctx, { villageId: 7, catalog: CATALOG, buyback: [] }, INVENTORY, ITEM_TYPES, 500, hitAreas,
      { tab: "buyback", page: 0 },
    );
    const msg = ctx.texts.find((t) => t.text === "No buyback stock.");
    expect(msg).toBeTruthy();
    expect(msg.y).toBeLessThan(PY + PANEL_H);
    expect(hitAreas.filter((a) => a.kind === "buy")).toHaveLength(0);
  });
});

describe("Game._handleShopClick against the rendered shop layout", () => {
  function fakeGame(view) {
    const sent = [];
    const { hitAreas } = renderShop(view);
    return {
      sent,
      hitAreas,
      shopOpen: true,
      shopView: { ...view },
      renderSystem: { _shopHitAreas: hitAreas },
      authorityClient: {
        sendBuy: (id) => sent.push(["buy", id]),
        sendSell: (id) => sent.push(["sell", id]),
      },
    };
  }

  const click = (game, area) =>
    Game.prototype._handleShopClick.call(game, area.x + area.w / 2, area.y + area.h / 2);

  it("buys the buyback row the player clicked", () => {
    const game = fakeGame({ tab: "buyback", page: 0 });
    const buys = game.hitAreas.filter((a) => a.kind === "buy");
    click(game, buys[2]);
    expect(game.sent).toEqual([["buy", BUYBACK[2].id]]);
  });

  it("maps every rendered buy control to its own stock id", () => {
    for (const view of [{ tab: "catalog", page: 0 }, { tab: "catalog", page: 2 }, { tab: "buyback", page: 0 }]) {
      const game = fakeGame(view);
      const buys = game.hitAreas.filter((a) => a.kind === "buy");
      for (const a of buys) click(game, a);
      expect(game.sent).toEqual(buys.map((a) => ["buy", a.id]));
    }
  });

  it("switches tab and page from the rendered controls without touching the server", () => {
    const game = fakeGame({ tab: "catalog", page: 0 });
    const buybackTab = game.hitAreas.find((a) => a.kind === "shoptab" && a.id === "buyback");
    click(game, buybackTab);
    expect(game.shopView).toEqual({ tab: "buyback", page: 0 });

    const paged = fakeGame({ tab: "catalog", page: 0 });
    const next = paged.hitAreas.find((a) => a.kind === "shoppage");
    click(paged, next);
    expect(paged.shopView).toEqual({ tab: "catalog", page: next.id });
    expect(paged.sent).toEqual([]);
    expect(game.sent).toEqual([]);
  });
});
