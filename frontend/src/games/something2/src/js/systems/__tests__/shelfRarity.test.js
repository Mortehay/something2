// SOMET-500 (merchant buyback shelf) + SOMET-502 (account chest panel).
//
// Both tickets are the same defect in two places: the item was already correct
// in the database and correct the instant it reached the inventory, and the
// SHELF it was sitting on said nothing about it. So these tests assert two
// things that have to hold together, because either alone is worthless:
//
//   1. the panel READS a grade and an affix list off a listing row, and
//   2. it resolves them through the SAME module the inventory grid does.
//
// (2) is asserted by rendering ONE object into all five lists and comparing the
// colours to each other rather than to a literal, so no future edit can make a
// shelf disagree with the grid while both stay individually "green". The
// literals are pinned once, in the unit tests at the top, against
// core/rarityColors.js.
//
// Frontend tests run in a NODE environment here, so nothing mounts: the panels
// are driven through the real renderShop / renderBank / drawInventory with a
// recording 2D-context stub that keeps the strokeStyle in force at each
// strokeRect. That pairing is the whole point -- a stub that swallowed
// strokeStyle (as the pre-existing shopPanel/bankPanel stubs do, correctly, for
// what they assert) would pass with the rarity colour deleted.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RenderSystem } from "../RenderSystem.js";
import { layoutInventory, drawInventory, CELL } from "../inventoryPanel.js";
import {
  rarityBorderColor, affixLine, affixModifier, clipToWidth, rowTextOffsets,
} from "../itemDisplay.js";
import { RARITY_COLORS } from "../../core/rarityColors.js";

// ---------------------------------------------------------------- fixtures

// Two affixes in the exact wire shape the server sends: loadInventory's
// jsonb_build_object, services/heldInstance.js's copy of it, and
// accountChest.js#loadAffixes all emit these five keys.
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

// The one rolled identity every list below is handed. Written once so "the same
// instance" in the cross-panel test is a fact about the fixture rather than a
// claim in a comment.
const ROLLED = { rarity: "yellow", itemLevel: 30, affixes: AFFIXES };

const TYPE_ID = 4;
const TYPES = new Map([[TYPE_ID, { id: TYPE_ID, name: "Iron Helm", category: "armor", defense: 3 }]]);

const NEUTRAL_CATALOG = "#3a3a4e";
const NEUTRAL_BUYBACK = "#caa24a";
const NEUTRAL_CHEST = "#caa24a";
const NEUTRAL_CARRY = "#3a3a4e";
const NEUTRAL_CELL = "#2a2a3a";

const SHOP_COL_W = 340;
// panelW 760 - 16 left pad - (16 + colW + 24) gutter - 16 right pad.
const SHOP_SELL_COL_W = 364;
const BANK_PANEL_W = 560;
const BANK_COL_W = BANK_PANEL_W - 32;
const ROW_H = 40;

// ------------------------------------------------------------- context stub

// Records the strokeStyle/fillStyle/font IN FORCE at the moment of each call,
// which is what the pre-existing panel stubs deliberately drop.
function stubCtx() {
  const style = { fill: null, stroke: null, font: null };
  const strokes = [];
  const texts = [];
  return {
    strokes,
    texts,
    save() {}, restore() {},
    translate() {}, scale() {},
    fillRect() {},
    strokeRect(x, y, w, h) { strokes.push({ x, y, w, h, style: style.stroke }); },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
    arc() {},
    drawImage() {},
    createRadialGradient() { return { addColorStop() {} }; },
    measureText(t) { return { width: String(t).length * 7 }; },
    fillText(text, x, y) { texts.push({ text, x, y, style: style.fill, font: style.font }); },
    set fillStyle(v) { style.fill = v; },
    set strokeStyle(v) { style.stroke = v; },
    set font(v) { style.font = v; },
    set lineWidth(_v) {},
    set textBaseline(_v) {},
    set textAlign(_v) {},
  };
}

function renderer(ctx) {
  return new RenderSystem({ getContext: () => ctx }, null);
}

function drawShop(shop, inventory = { items: [], types: TYPES, equipment: {} }, view = { tab: "catalog", page: 0 }) {
  const ctx = stubCtx();
  renderer(ctx).renderShop(ctx, shop, inventory, TYPES, 500, [], view);
  return ctx;
}

function drawBank(bank, inventory = { items: [], types: TYPES, equipment: {} }, view = { tab: "chest", page: 0 }) {
  const ctx = stubCtx();
  renderer(ctx).renderBank(ctx, bank, inventory, TYPES, [], view);
  return ctx;
}

// The ONE list row a panel drew: a full-column-width rect of row height.
function onlyRow(ctx, colW) {
  const rows = ctx.strokes.filter((r) => r.w === colW && r.h === ROW_H);
  expect(rows).toHaveLength(1);
  return rows[0];
}

// The text lines that belong to a row, keyed by their offset from its top edge.
// Pinned to the row's text column (x + 8) so the Buy/Take/Store button's own
// label, which sits inside the same rect, is not mistaken for a fourth line.
function rowTexts(ctx, row) {
  return ctx.texts
    .filter((t) => t.y >= row.y && t.y < row.y + ROW_H && t.x === row.x + 8)
    .map((t) => ({ text: t.text, dy: t.y - row.y, style: t.style, font: t.font }));
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

describe("itemDisplay.affixLine", () => {
  it("captions each rolled affix with its label, sign, value and unit", () => {
    expect(affixLine([AFFIXES[0]])).toBe("of Might  +3.13 STR");
    expect(affixLine([AFFIXES[1]])).toBe("Flaming  +11.5% fire damage");
    expect(affixLine(AFFIXES)).toBe("of Might  +3.13 STR  ·  Flaming  +11.5% fire damage");
  });

  it("is empty for an unaffixed item and for a row that carries no list at all", () => {
    expect(affixLine([])).toBe("");
    expect(affixLine(undefined)).toBe("");
    expect(affixLine(null)).toBe("");
  });

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

  it("keeps an unknown effect type's label and number rather than dropping it", () => {
    // A kind added server-side must degrade to "label +N", never to silence.
    expect(affixLine([{ label: "Novel", value: 2, effect: { type: "unheard_of" } }]))
      .toBe("Novel  +2");
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

describe("itemDisplay.rowTextOffsets", () => {
  it("keeps the historical two-line geometry for a row with no affixes", () => {
    expect(rowTextOffsets(false)).toEqual({ name: 6, sub: 22, affix: null });
  });

  it("opens a third line only when there is something to put on it", () => {
    expect(rowTextOffsets(true)).toEqual({ name: 3, sub: 16, affix: 28 });
  });
});

// ------------------------------------------------------- SOMET-500: the shop

describe("SOMET-500: the merchant buyback shelf", () => {
  const buybackRow = { id: "s1", itemTypeId: TYPE_ID, price: 60, quantity: 1, sellerUserId: 9, ...ROLLED };
  const shop = { villageId: 1, catalog: [], buyback: [buybackRow] };

  it("borders a held instance's row in its rarity colour BEFORE it is bought", () => {
    const ctx = drawShop(shop, undefined, { tab: "buyback", page: 0 });
    expect(onlyRow(ctx, SHOP_COL_W).style).toBe(RARITY_COLORS.yellow);
  });

  it("shows the rolled affixes on the shelf, with their values", () => {
    const oneAffix = { ...buybackRow, affixes: [AFFIXES[0]] };
    const ctx = drawShop({ villageId: 1, catalog: [], buyback: [oneAffix] }, undefined, { tab: "buyback", page: 0 });
    const lines = rowTexts(ctx, onlyRow(ctx, SHOP_COL_W));
    // Name, price and the affix caption, in the three-line geometry.
    expect(lines.map((l) => [l.dy, l.text])).toEqual([
      [3, "Iron Helm"],
      [16, "60 g"],
      [28, "of Might  +3.13 STR"],
    ]);
    expect(lines[2].style).toBe(RARITY_COLORS.yellow);
  });

  it("leaves the generated base catalogue exactly as it rendered before", () => {
    // No instance, therefore no rarity key and no affixes: the pre-500 border
    // and the pre-500 two-line geometry, asserted by value rather than by
    // "did not throw".
    const catalogRow = { id: "c1", itemTypeId: TYPE_ID, price: 40, quantity: 1, sellerUserId: null };
    const ctx = drawShop({ villageId: 1, catalog: [catalogRow], buyback: [] });
    const row = onlyRow(ctx, SHOP_COL_W);
    expect(row.style).toBe(NEUTRAL_CATALOG);
    expect(rowTexts(ctx, row).map((l) => [l.dy, l.text])).toEqual([
      [6, "Iron Helm"],
      [22, "40 g"],
    ]);
  });

  it("leaves a pre-SOMET-484 buyback row, which holds no instance, amber", () => {
    const legacy = { id: "s0", itemTypeId: TYPE_ID, price: 20, quantity: 1, sellerUserId: 9 };
    const ctx = drawShop({ villageId: 1, catalog: [], buyback: [legacy] }, undefined, { tab: "buyback", page: 0 });
    expect(onlyRow(ctx, SHOP_COL_W).style).toBe(NEUTRAL_BUYBACK);
  });
});

// ------------------------------------------------------- SOMET-502: the bank

describe("SOMET-502: the account chest panel", () => {
  const storedRow = { id: "a1", slot: 1, typeId: TYPE_ID, quantity: 1, soulbound: false, ...ROLLED };
  const bank = { villageId: 1, items: [storedRow], capacity: 40 };

  it("borders a stored instance's row in its rarity colour", () => {
    const ctx = drawBank(bank);
    expect(onlyRow(ctx, BANK_COL_W).style).toBe(RARITY_COLORS.yellow);
  });

  it("shows the stored item's affixes and their values", () => {
    const ctx = drawBank(bank);
    const lines = rowTexts(ctx, onlyRow(ctx, BANK_COL_W));
    expect(lines.map((l) => [l.dy, l.text])).toEqual([
      [3, "Iron Helm"],
      [28, "of Might  +3.13 STR  ·  Flaming  +11.5% fire damage"],
    ]);
    expect(lines[1].style).toBe(RARITY_COLORS.yellow);
  });

  it("keeps the bound / stack subline on the middle line when there are affixes", () => {
    const bound = { ...storedRow, quantity: 1, soulbound: true };
    const ctx = drawBank({ ...bank, items: [bound] });
    const lines = rowTexts(ctx, onlyRow(ctx, BANK_COL_W));
    expect(lines.map((l) => [l.dy, l.text])).toEqual([
      [3, "Iron Helm"],
      [16, "bound"],
      [28, "of Might  +3.13 STR  ·  Flaming  +11.5% fire damage"],
    ]);
  });

  it("leaves a legacy chest row that holds no instance exactly as it rendered before", () => {
    const legacy = { id: "a0", slot: 2, typeId: TYPE_ID, quantity: 3, soulbound: false };
    const ctx = drawBank({ ...bank, items: [legacy] });
    const row = onlyRow(ctx, BANK_COL_W);
    expect(row.style).toBe(NEUTRAL_CHEST);
    expect(rowTexts(ctx, row).map((l) => [l.dy, l.text])).toEqual([
      [6, "Iron Helm"],
      [22, "x3"],
    ]);
  });

  it("keeps the Carry tab's own slate neutral for an item with no grade", () => {
    // The two tabs have different neutrals, so a shared helper with a baked-in
    // fallback would repaint one of them. This is the tab that would show it.
    const plain = { id: "p1", typeId: TYPE_ID, quantity: 1, rarity: "white", affixes: [] };
    const ctx = drawBank(
      { villageId: 1, items: [], capacity: 40 },
      { items: [plain], types: TYPES, equipment: {} },
      { tab: "carry", page: 0 },
    );
    expect(onlyRow(ctx, BANK_COL_W).style).toBe(NEUTRAL_CARRY);
  });
});

// --------------------------------------------------- the anti-drift criterion

describe("SOMET-500/502: one instance, one colour, on every screen that lists it", () => {
  // ONE object. Each list gets the shape ITS table produces, but the grade and
  // the affixes come from the same source, so a divergence between two panels
  // is a bug in the panels and cannot be a bug in the fixture.
  const item = { id: "i1", typeId: TYPE_ID, quantity: 1, soulbound: false, ...ROLLED };
  const inventory = { items: [item], types: TYPES, equipment: {}, capacity: 48 };

  function gridCellBorder() {
    const ctx = stubCtx();
    const layout = layoutInventory({ inventory, gold: 0, tab: "all", page: 0 });
    drawInventory(ctx, layout, {});
    const cell = layout.cells[0];
    const stroke = ctx.strokes.find((s) => s.w === CELL && s.h === CELL && s.x === cell.x && s.y === cell.y);
    expect(stroke).toBeTruthy();
    return stroke.style;
  }

  it("paints the grid cell, both bank tabs and both shop columns the same colour", () => {
    const grid = gridCellBorder();

    const chest = onlyRow(
      drawBank({ villageId: 1, items: [{ ...item, slot: 1 }], capacity: 40 }),
      BANK_COL_W,
    ).style;
    const carry = onlyRow(
      drawBank({ villageId: 1, items: [], capacity: 40 }, inventory, { tab: "carry", page: 0 }),
      BANK_COL_W,
    ).style;
    const shelf = onlyRow(
      drawShop(
        { villageId: 1, catalog: [], buyback: [{ ...item, itemTypeId: item.typeId, price: 60, sellerUserId: 9 }] },
        undefined,
        { tab: "buyback", page: 0 },
      ),
      SHOP_COL_W,
    ).style;
    // The shop's right-hand "Your items" column: a different width, so it is
    // found by its own geometry rather than by onlyRow.
    const sellCtx = drawShop({ villageId: 1, catalog: [], buyback: [] }, inventory);
    const sell = sellCtx.strokes.filter((r) => r.w === SHOP_SELL_COL_W && r.h === ROW_H);
    expect(sell).toHaveLength(1);

    expect([chest, carry, shelf, sell[0].style]).toEqual([grid, grid, grid, grid]);
    expect(grid).toBe(RARITY_COLORS.yellow);
  });

  it("captions the shelf and the chest with the identical affix text", () => {
    const shelfCtx = drawShop(
      { villageId: 1, catalog: [], buyback: [{ ...item, itemTypeId: item.typeId, price: 60, sellerUserId: 9 }] },
      undefined,
      { tab: "buyback", page: 0 },
    );
    const chestCtx = drawBank({ villageId: 1, items: [{ ...item, slot: 1 }], capacity: 40 });
    const shelfLine = rowTexts(shelfCtx, onlyRow(shelfCtx, SHOP_COL_W)).find((l) => l.dy === 28).text;
    const chestLine = rowTexts(chestCtx, onlyRow(chestCtx, BANK_COL_W)).find((l) => l.dy === 28).text;
    // The shop column is narrower, so its caption is CLIPPED rather than
    // different -- the chest's line must start with what the shelf shows.
    expect(chestLine).toBe("of Might  +3.13 STR  ·  Flaming  +11.5% fire damage");
    expect(shelfLine.endsWith("…")).toBe(true);
    expect(chestLine.startsWith(shelfLine.slice(0, -1))).toBe(true);
  });
});

// ------------------------------------------------------------- the dead-code
// gate. Everything above would still pass if renderShop/renderBank had their
// own private copy of the palette; these assert that the shared module is
// actually the thing they call, which is what stops copy number three and four
// growing back.

describe("the panels resolve rarity through the shared module, not their own copy", () => {
  const RENDER_SRC = readFileSync(new URL("../RenderSystem.js", import.meta.url), "utf8");
  const PANEL_SRC = readFileSync(new URL("../inventoryPanel.js", import.meta.url), "utf8");

  function methodBody(name) {
    const start = RENDER_SRC.indexOf(`\n  ${name}(ctx`);
    expect(start).toBeGreaterThan(-1);
    const rest = RENDER_SRC.slice(start + 1);
    const end = rest.indexOf("\n  }\n");
    expect(end).toBeGreaterThan(-1);
    return rest.slice(0, end);
  }

  it("imports the helper into RenderSystem and the inventory panel", () => {
    expect(RENDER_SRC).toMatch(/rarityBorderColor[\s\S]{0,200}from "\.\/itemDisplay\.js"/);
    expect(PANEL_SRC).toMatch(/rarityBorderColor[\s\S]{0,200}from "\.\/itemDisplay\.js"/);
  });

  it("calls it from renderShop and renderBank, alongside the affix caption", () => {
    for (const name of ["renderShop", "renderBank"]) {
      const body = methodBody(name);
      expect(body).toContain("rarityBorderColor(");
      expect(body).toContain("affixLine(");
    }
  });

  it("spells no rarity hex of its own", () => {
    // core/rarityColors.js is the only file allowed to author these. `blue` is
    // excluded deliberately and NOT by oversight: #4a9eff is also this UI's
    // ordinary accent (every active tab border, every enabled button), so it
    // appears in both files for reasons that have nothing to do with rarity and
    // asserting on it would fail for a correct implementation.
    for (const grade of ["yellow", "foxy", "white"]) {
      expect(RENDER_SRC).not.toContain(RARITY_COLORS[grade]);
      expect(PANEL_SRC).not.toContain(RARITY_COLORS[grade]);
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
