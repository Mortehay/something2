// SOMET-500 (merchant buyback shelf) + SOMET-502 (account chest panel).
//
// Both tickets are the same defect in two places: the item was already correct
// in the database and correct the instant it reached the inventory, and the
// place it was sitting said nothing about it. They are now grid windows drawn
// by drawItemWindow through the inventory's own drawItemCell, so these tests
// assert two things that have to hold together:
//
//   1. the window READS a grade off a listing row, and
//   2. it resolves it through the SAME module the inventory grid does.
//
// (2) is asserted by drawing ONE object into the grid, the chest and the
// buyback shelf and comparing the colours to each other rather than to a
// literal. The literals are pinned once, in the unit tests below. (The affix
// caption the old list rows carried now lives in the tooltip, which the
// inventory shares; see storageWindowsDraw.test.js.)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { layoutInventory, drawInventory, CELL } from "../inventoryPanel.js";
import { layoutChestWindow, layoutMerchantWindow, drawItemWindow } from "../storageWindows.js";
import { rarityBorderColor, affixModifier, clipToWidth } from "../itemDisplay.js";
import { RARITY_COLORS } from "../../core/rarityColors.js";

const AFFIXES = [
  {
    affixTypeId: 1, key: "of_might", label: "of Might",
    value: 3.13, effect: { type: "stat", stat: "strength" },
  },
  {
    affixTypeId: 9, key: "flaming", label: "Flaming",
    value: 11.5, effect: { type: "damage", element: "fire" },
  },
];
const ROLLED = { rarity: "yellow", itemLevel: 30, affixes: AFFIXES };

const TYPE_ID = 4;
const TYPES = new Map([[TYPE_ID, { id: TYPE_ID, name: "Iron Helm", category: "armor", defense: 3 }]]);

const NEUTRAL_CATALOG = "#3a3a4e";
const NEUTRAL_BUYBACK = "#caa24a";
const NEUTRAL_CELL = "#2a2a3a";

// Records the strokeStyle IN FORCE at each strokeRect.
function stubCtx() {
  const strokes = [];
  let stroke = null;
  return {
    strokes,
    save() {}, restore() {}, fillRect() {}, fillText() {}, drawImage() {},
    strokeRect(x, y, w, h) { strokes.push({ x, y, w, h, style: stroke }); },
    measureText(t) { return { width: String(t).length * 7 }; },
    set fillStyle(_v) {}, set strokeStyle(v) { stroke = v; }, set font(_v) {},
    set lineWidth(_v) {}, set textBaseline(_v) {}, set textAlign(_v) {}, set globalAlpha(_v) {},
  };
}

// The border colours painted on one cell, last one wins (what the eye sees).
function borderOf(ctx, cell) {
  const hits = ctx.strokes.filter((s) => s.x === cell.x && s.y === cell.y && s.w === CELL && s.h === CELL);
  expect(hits.length).toBeGreaterThan(0);
  return hits[hits.length - 1].style;
}
function drawBuyback(items, view = { tab: "buyback", page: 0 }, catalog = []) {
  const layout = layoutMerchantWindow({ shop: { catalog, buyback: items, lockedCatalog: [], reputation: null }, view, gold: 0, types: TYPES });
  const ctx = stubCtx();
  drawItemWindow(ctx, layout, {}, null);
  return { ctx, cell: layout.cells[0] };
}
function drawChest(items) {
  const layout = layoutChestWindow({ bank: { villageId: 1, items, capacity: 40 }, types: TYPES });
  const ctx = stubCtx();
  drawItemWindow(ctx, layout, {}, null);
  return { ctx, cell: layout.cells[0] };
}

// ------------------------------------------------------------- unit: colour

describe("itemDisplay.rarityBorderColor", () => {
  it("returns the palette colour for every GLOWING grade", () => {
    expect(rarityBorderColor("blue", NEUTRAL_CELL)).toBe(RARITY_COLORS.blue);
    expect(rarityBorderColor("yellow", NEUTRAL_CELL)).toBe(RARITY_COLORS.yellow);
    expect(rarityBorderColor("foxy", NEUTRAL_CELL)).toBe(RARITY_COLORS.foxy);
  });

  it("hands back the caller's own neutral for white, absent and unknown grades", () => {
    // White has a palette entry and still must not tint a border: a colour
    // every row carries is not a signal. Absent is the legacy listing row.
    for (const grade of ["white", null, undefined, "", "puce", 7]) {
      expect(rarityBorderColor(grade, NEUTRAL_CATALOG)).toBe(NEUTRAL_CATALOG);
      expect(rarityBorderColor(grade, NEUTRAL_BUYBACK)).toBe(NEUTRAL_BUYBACK);
    }
  });
});

// -------------------------------------------------------------- unit: text

describe("itemDisplay.affixModifier", () => {
  it("maps each effect type onto the detail field its kind is read from", () => {
    expect(affixModifier(AFFIXES[0])).toEqual({
      label: "of Might", value: 3.13, kind: "stat", detail: "strength",
    });
    expect(affixModifier({ label: "of the Bear", value: 45, effect: { type: "resource", pool: "hp" } }))
      .toEqual({ label: "of the Bear", value: 45, kind: "resource", detail: "hp" });
    expect(affixModifier({ label: "Warded", value: 0.25, effect: { type: "resist", element: "arcane" } }))
      .toEqual({ label: "Warded", value: 0.25, kind: "resist", detail: "arcane" });
    expect(affixModifier({ label: "Cursed", value: 1, effect: { type: "status", status: "chill" } }))
      .toEqual({ label: "Cursed", value: 1, kind: "status", detail: "chill" });
  });

});

describe("itemDisplay.clipToWidth", () => {
  it("returns the text untouched when it fits the budget", () => {
    // 10px monospace advances 6px, so 60px holds ten characters exactly.
    expect(clipToWidth("0123456789", 60, 10)).toBe("0123456789");
  });

  it("clips to the budget and marks the cut, ellipsis INCLUDED in the budget", () => {
    // 54px holds nine characters, and the ellipsis is one of them -- a clip
    // that appended the marker on top of a full budget would overrun the
    // control it is being kept clear of.
    expect(clipToWidth("0123456789", 54, 10)).toBe("01234567…");
    expect(clipToWidth("0123456789", 30, 10)).toBe("0123…");
  });

  it("draws nothing rather than something wrong for a budget that fits no text", () => {
    expect(clipToWidth("abc", 0, 10)).toBe("");
    expect(clipToWidth("abc", 60, 0)).toBe("");
  });
});

// ------------------------------------------------------- SOMET-500: the shop

describe("SOMET-500: the merchant buyback shelf", () => {
  const buybackRow = { id: "s1", itemTypeId: TYPE_ID, price: 60, quantity: 1, sellerUserId: 9, ...ROLLED };

  it("borders a held instance's cell in its rarity colour BEFORE it is bought", () => {
    const { ctx, cell } = drawBuyback([buybackRow]);
    expect(borderOf(ctx, cell)).toBe(RARITY_COLORS.yellow);
  });

  it("leaves the generated base catalogue exactly as it rendered before", () => {
    const catalogRow = { id: "c1", itemTypeId: TYPE_ID, price: 40, quantity: 1, sellerUserId: null };
    const { ctx, cell } = drawBuyback([], { tab: "catalog", page: 0 }, [catalogRow]);
    expect(borderOf(ctx, cell)).toBe(NEUTRAL_CELL);
    expect(ctx.strokes.some((s) => s.style === NEUTRAL_BUYBACK)).toBe(false);
  });

  it("leaves a pre-SOMET-484 buyback row, which holds no instance, amber", () => {
    const legacy = { id: "s0", itemTypeId: TYPE_ID, price: 20, quantity: 1, sellerUserId: 9 };
    const { ctx, cell } = drawBuyback([legacy]);
    expect(borderOf(ctx, cell)).toBe(NEUTRAL_BUYBACK);
  });
});

// ------------------------------------------------------- SOMET-502: the bank

describe("SOMET-502: the account chest window", () => {
  const storedRow = { id: "a1", slot: 1, typeId: TYPE_ID, quantity: 1, soulbound: false, ...ROLLED };

  it("borders a stored instance's cell in its rarity colour", () => {
    const layout = layoutChestWindow({ bank: { items: [storedRow], capacity: 40 }, types: TYPES });
    const ctx = stubCtx();
    drawItemWindow(ctx, layout, {}, null);
    expect(borderOf(ctx, layout.cells[1])).toBe(RARITY_COLORS.yellow);
  });

  it("leaves a legacy chest row that holds no instance neutral", () => {
    const legacy = { id: "a0", slot: 0, typeId: TYPE_ID, quantity: 3, soulbound: false };
    const { ctx, cell } = drawChest([legacy]);
    expect(borderOf(ctx, cell)).toBe(NEUTRAL_CELL);
  });
});

// --------------------------------------------------- the anti-drift criterion

describe("SOMET-500/502: one instance, one colour, on every screen that lists it", () => {
  const item = { id: "i1", typeId: TYPE_ID, quantity: 1, soulbound: false, ...ROLLED };
  const inventory = { items: [item], types: TYPES, equipment: {}, capacity: 48 };

  it("paints the grid cell, the chest and the buyback shelf the same colour", () => {
    const gctx = stubCtx();
    const layout = layoutInventory({ inventory, gold: 0, tab: "all", page: 0 });
    drawInventory(gctx, layout, {});
    const grid = borderOf(gctx, layout.cells[0]);

    const chest = drawChest([{ ...item, slot: 0 }]);
    const shelf = drawBuyback([{ ...item, itemTypeId: item.typeId, price: 60, sellerUserId: 9 }]);
    expect([borderOf(chest.ctx, chest.cell), borderOf(shelf.ctx, shelf.cell)]).toEqual([grid, grid]);
    expect(grid).toBe(RARITY_COLORS.yellow);
  });
});

// The dead-code gate: everything above would still pass if the windows had
// their own private copy of the palette; this asserts the shared module is the
// thing they go through, which is what stops copy number three growing back.
describe("the windows resolve rarity through the shared module, not their own copy", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const RENDER_SRC = read("../RenderSystem.js");
  const PANEL_SRC = read("../inventoryPanel.js");
  const WINDOW_SRC = read("../storageWindows.js");

  it("imports the helper into the inventory panel, and draws window cells through its drawItemCell", () => {
    expect(PANEL_SRC).toMatch(/rarityBorderColor[\s\S]{0,200}from "\.\/itemDisplay\.js"/);
    expect(WINDOW_SRC).toMatch(/drawItemCell[\s\S]{0,300}from "\.\/inventoryPanel\.js"/);
    expect(WINDOW_SRC).toContain("drawItemCell(ctx");
  });

  it("spells no rarity hex of its own", () => {
    // `blue` is excluded deliberately: #4a9eff is also this UI's ordinary accent.
    for (const grade of ["yellow", "foxy", "white"]) {
      for (const src of [RENDER_SRC, PANEL_SRC, WINDOW_SRC]) expect(src).not.toContain(RARITY_COLORS[grade]);
    }
  });
});

// The grid must keep the behaviour SOMET-490 gave it after being moved onto the
// shared helper -- the refactor is only safe if this still holds.
describe("the inventory grid is unchanged by the extraction", () => {
  it("still lets selection win over the grade, and still leaves a plain item neutral", () => {
    const yellow = { id: "y", typeId: TYPE_ID, quantity: 1, rarity: "yellow", affixes: [] };
    const plain = { id: "w", typeId: TYPE_ID, quantity: 1, rarity: "white", affixes: [] };
    const inventory = { items: [yellow, plain], types: TYPES, equipment: {}, capacity: 48 };

    const ctx = stubCtx();
    const layout = layoutInventory({ inventory, gold: 0, tab: "all", page: 0, selectedItemId: "y" });
    drawInventory(ctx, layout, {});
    const at = (cell) => ctx.strokes.find((s) => s.x === cell.x && s.y === cell.y && s.w === CELL).style;

    expect(at(layout.cells[0])).toBe("#4a9eff");   // selected beats yellow
    expect(at(layout.cells[1])).toBe(NEUTRAL_CELL); // white keeps the neutral
    expect(at(layout.cells[2])).toBe(NEUTRAL_CELL); // and so does an empty cell
  });
});
