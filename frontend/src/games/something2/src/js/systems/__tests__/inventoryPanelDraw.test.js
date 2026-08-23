import { describe, it, expect } from "vitest";
import { layoutInventory, drawInventory } from "../inventoryPanel.js";
import { RenderSystem } from "../RenderSystem.js";
import { Game } from "../../core/Game.js";

// Recording 2D context: drawInventory only ever writes to a context, so the
// geometry (fillRect) and the labels (fillText) are what the tests assert
// against — the same convention shopPanel.test.js uses.
function stubCtx() {
  const fillRects = [], texts = [], images = [];
  return {
    fillRects, texts, images,
    save() {}, restore() {},
    fillRect(x, y, w, h) { fillRects.push({ x, y, w, h }); },
    strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    fillText(text, x, y) { texts.push({ text, x, y }); },
    drawImage(img, x, y, w, h) { images.push({ x, y, w, h }); },
    measureText(t) { return { width: String(t).length * 6 }; },
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set font(_v) {},
    set lineWidth(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {},
    set globalAlpha(_v) {},
  };
}

function inv({ items = [], equipment = {}, types = [], capacity = null } = {}) {
  return { types: new Map(types.map((t) => [t.id, t])), items, equipment, ammoCounts: new Map(), capacity };
}
const SWORD = { id: 1, name: "short sword", category: "weapon", slot: "main_hand", damage: 5, cooldown: 1 };

describe("drawInventory", () => {
  it("writes the used/capacity counter into the title bar", () => {
    const i = inv({ types: [SWORD], items: [{ id: "w", typeId: 1, quantity: 1 }], capacity: 48 });
    const ctx = stubCtx();
    const layout = layoutInventory({ inventory: i });
    drawInventory(ctx, layout, { inventory: i });
    expect(ctx.texts.some((t) => t.text.includes("(1/48)"))).toBe(true);
  });

  it("badges a stack and not a single item", () => {
    const i = inv({ types: [SWORD], items: [{ id: "a", typeId: 1, quantity: 12 }, { id: "b", typeId: 1, quantity: 1 }] });
    const ctx = stubCtx();
    drawInventory(ctx, layoutInventory({ inventory: i }), { inventory: i });
    expect(ctx.texts.some((t) => t.text === "12")).toBe(true);
    expect(ctx.texts.some((t) => t.text === "1")).toBe(false);
  });

  it("draws a tooltip for a hovered cell and none when the cursor is elsewhere", () => {
    const i = inv({ types: [SWORD], items: [{ id: "w", typeId: 1, quantity: 1 }] });
    const layout = layoutInventory({ inventory: i });
    const cell = layout.cells[0];

    const hot = stubCtx();
    drawInventory(hot, layout, { inventory: i, hoverX: cell.x + 2, hoverY: cell.y + 2 });
    expect(hot.texts.some((t) => t.text === "short sword")).toBe(true);
    expect(hot.texts.some((t) => t.text.includes("dmg 5"))).toBe(true);

    const cold = stubCtx();
    drawInventory(cold, layout, { inventory: i, hoverX: layout.panel.x + 1, hoverY: layout.panel.y + 1 });
    expect(cold.texts.some((t) => t.text.includes("dmg 5"))).toBe(false);
  });

  it("keeps the tooltip inside the canvas for a cell at the right edge", () => {
    const items = [];
    for (let n = 0; n < 8; n += 1) items.push({ id: `i${n}`, typeId: 1, quantity: 1 });
    const i = inv({ types: [SWORD], items });
    const layout = layoutInventory({ inventory: i });
    const last = layout.cells[7];
    const ctx = stubCtx();
    drawInventory(ctx, layout, { inventory: i, hoverX: last.x + 2, hoverY: last.y + 2 });
    const tip = ctx.fillRects[ctx.fillRects.length - 1];
    expect(tip.x + tip.w).toBeLessThanOrEqual(1280);
  });
});

describe("RenderSystem delegation", () => {
  it("records the layout's hit areas so clicks still route", () => {
    const rs = Object.create(RenderSystem.prototype);
    rs.imageManager = { get: () => null };
    const i = inv({ types: [SWORD], items: [{ id: "w", typeId: 1, quantity: 1 }] });
    const hits = [];
    rs.renderInventory(stubCtx(), i, hits, null, false, { tab: "all", page: 0, gold: 0 });
    expect(hits.some((a) => a.kind === "item" && a.id === "w")).toBe(true);
    expect(hits.some((a) => a.kind === "slot" && a.id === "main_hand")).toBe(true);
    expect(hits.some((a) => a.kind === "invclose")).toBe(true);
  });
});

describe("Game click routing for the new controls", () => {
  function makeGame() {
    globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
    const g = new Game();
    g.state = "playing";
    g.chunked = true;
    g.inventoryOpen = true;
    g.renderSystem = { _invHitAreas: [] };
    return g;
  }

  it("switches tab and resets the page", () => {
    const g = makeGame();
    g.inventoryPage = 3;
    g.renderSystem._invHitAreas = [{ x: 0, y: 0, w: 10, h: 10, kind: "invtab", id: "stones" }];
    g._handleInventoryClick(1, 1);
    expect(g.inventoryTab).toBe("stones");
    expect(g.inventoryPage).toBe(0);
  });

  it("turns the page", () => {
    const g = makeGame();
    g.renderSystem._invHitAreas = [{ x: 0, y: 0, w: 10, h: 10, kind: "invpage", id: 2 }];
    g._handleInventoryClick(1, 1);
    expect(g.inventoryPage).toBe(2);
  });

  it("closes the panel from the title bar X", () => {
    const g = makeGame();
    g.inventorySelectedItemId = "w";
    g.renderSystem._invHitAreas = [{ x: 0, y: 0, w: 10, h: 10, kind: "invclose", id: null }];
    g._handleInventoryClick(1, 1);
    expect(g.inventoryOpen).toBe(false);
    expect(g.inventorySelectedItemId).toBeNull();
  });
});
