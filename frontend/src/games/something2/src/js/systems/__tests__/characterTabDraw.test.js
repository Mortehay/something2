// drawCharacterTab only ever writes to a context, so a recording stub is the
// whole test surface -- the same convention the other draw tests here use.
import { describe, it, expect } from "vitest";
import { layoutInventory, drawInventory, CELL } from "../inventoryPanel.js";
import { layoutCharacterTab, drawCharacterTab } from "../characterTab.js";

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

function inv() {
  return { types: new Map(), items: [], equipment: {}, ammoCounts: new Map(), capacity: 48 };
}

const PANE = { x: 300, y: 200, w: 528, h: 340 };

const CHARACTER = {
  className: "Warrior",
  mainStat: "strength",
  level: 7,
  experience: 102,
  xpFloor: 63,
  xpToNext: 78,
  passivePoints: 3,
  sources: {
    strength:     { base: 5, tree: 33, gear: 4 },
    dexterity:    { base: 5, tree: 6,  gear: 0 },
    constitution: { base: 8, tree: 4,  gear: 2 },
    intelligence: { base: 5, tree: 0,  gear: 0 },
    wisdom:       { base: 6, tree: 2,  gear: 0 },
    charisma:     { base: 5, tree: 0,  gear: 0 },
  },
  modifiers: [
    { label: "Kindling", value: 12, source: "tree", kind: "damage", detail: "fire" },
    { label: "of the Bear", value: 4, source: "gear", kind: "stat", detail: "strength" },
  ],
  stats: {
    maxHp: 140, maxMana: 100, maxStamina: 108, meleeMult: 1.15, spellMult: 1,
    cooldownMult: 0.8696, manaRegen: 10, priceMult: 0.55,
  },
};

const FRESH = {
  className: "Mage", mainStat: "intelligence", level: 1, experience: 0,
  xpFloor: 0, xpToNext: 18, passivePoints: 0,
  sources: {
    strength: { base: 5, tree: 0, gear: 0 }, dexterity: { base: 5, tree: 0, gear: 0 },
    constitution: { base: 5, tree: 0, gear: 0 }, intelligence: { base: 5, tree: 0, gear: 0 },
    wisdom: { base: 5, tree: 0, gear: 0 }, charisma: { base: 5, tree: 0, gear: 0 },
  },
  modifiers: [],
  stats: {
    maxHp: 100, maxMana: 100, maxStamina: 100, meleeMult: 1, spellMult: 1,
    cooldownMult: 1, manaRegen: 10, priceMult: 0.5,
  },
};

describe("drawCharacterTab", () => {
  it("writes the header, every itemised stat, the derived block and the modifier list", () => {
    const ctx = stubCtx();
    drawCharacterTab(ctx, layoutCharacterTab({ ...PANE, character: CHARACTER }));
    const said = ctx.texts.map((t) => t.text);
    expect(said).toContain("Warrior — Level 7");
    expect(said).toContain("STR 42 = 5 base + 33 tree + 4 gear");
    expect(said).toContain("CHA 5 = 5 base");
    expect(said).toContain("Max HP        140");
    expect(said).toContain("Max stamina   108");
    expect(said).toContain("Sell price    x0.55");
    expect(said).toContain("Strong: STR 42    Weak: INT 5");
    expect(said).toContain("Passive points: 3");
    expect(said).toContain("39 / 78 XP");
    expect(said).toContain("Modifiers");
    expect(said).toContain("Kindling  +12% fire damage");
    expect(said).toContain("of the Bear  +4 STR");
    // The source tags, which are the point of the list.
    expect(said).toContain("tree");
    expect(said).toContain("gear");
  });

  it("puts each source tag on its own modifier's row, in the right-hand column", () => {
    const pane = layoutCharacterTab({ ...PANE, character: CHARACTER });
    const ctx = stubCtx();
    drawCharacterTab(ctx, pane);
    const tag = (word) => ctx.texts.find((t) => t.text === word);
    expect(tag("tree").y).toBe(pane.modifiers.rows[0].y);
    expect(tag("gear").y).toBe(pane.modifiers.rows[1].y);
    for (const word of ["tree", "gear"]) {
      expect(tag(word).x).toBeGreaterThan(pane.modifiers.rows[0].x);
      expect(tag(word).x).toBeLessThan(pane.x + pane.w);
    }
  });

  it("draws the XP fill proportional to progress, inside the track", () => {
    const pane = layoutCharacterTab({ ...PANE, character: CHARACTER });
    const ctx = stubCtx();
    drawCharacterTab(ctx, pane);
    const fill = ctx.fillRects.find((r) => r.y === pane.xp.track.y && r.w === pane.xp.fillW);
    expect(fill).toBeDefined();                 // 50% of a 300px track
    expect(pane.xp.fillW).toBe(150);
    expect(fill.x + fill.w).toBeLessThanOrEqual(pane.xp.track.x + pane.xp.track.w);
  });

  it("paints no fill at all at 0%, rather than a one-pixel sliver", () => {
    const pane = layoutCharacterTab({ ...PANE, character: FRESH });
    const ctx = stubCtx();
    drawCharacterTab(ctx, pane);
    expect(pane.xp.fillW).toBe(0);
    expect(ctx.fillRects.filter((r) => r.y === pane.xp.track.y)).toHaveLength(1); // the track only
  });

  it("renders a fresh level-1 character with no passives and no affixes", () => {
    const ctx = stubCtx();
    drawCharacterTab(ctx, layoutCharacterTab({ ...PANE, character: FRESH }));
    const said = ctx.texts.map((t) => t.text);
    expect(said).toContain("Mage — Level 1");
    expect(said).toContain("INT 5 = 5 base");
    expect(said).toContain("Strong: INT 5    Weak: —");
    expect(said).toContain("No modifiers yet — allocate passives or equip gear.");
    expect(said).toContain("0 / 18 XP");
    // No source tag is drawn when there is no modifier to tag.
    expect(said).not.toContain("tree");
    expect(said).not.toContain("gear");
  });

  it("draws the pager only when the list actually overflows", () => {
    const many = [];
    for (let i = 0; i < 12; i += 1) {
      many.push({ label: `Mod ${i}`, value: i, source: "tree", kind: "stat", detail: "strength" });
    }
    const pane = layoutCharacterTab({ ...PANE, character: { ...CHARACTER, modifiers: many } });
    const ctx = stubCtx();
    drawCharacterTab(ctx, pane);
    const said = ctx.texts.map((t) => t.text);
    expect(said).toContain(">");
    expect(said).not.toContain("<");
    expect(said).toContain(`page 1/${pane.modifiers.pageCount}`);

    const flat = stubCtx();
    drawCharacterTab(flat, layoutCharacterTab({ ...PANE, character: CHARACTER }));
    const flatSaid = flat.texts.map((t) => t.text);
    expect(flatSaid).not.toContain(">");
    expect(flatSaid.some((t) => /^page /.test(t))).toBe(false);
  });

  it("says it is loading when no character view has arrived", () => {
    const ctx = stubCtx();
    drawCharacterTab(ctx, layoutCharacterTab({ ...PANE, character: null }));
    expect(ctx.texts.map((t) => t.text)).toEqual(["Loading character…"]);
  });
});

describe("drawInventory dispatch", () => {
  it("paints the character pane, and no item grid, on the Character tab", () => {
    const i = inv();
    i.types = new Map([[1, { id: 1, name: "short sword", category: "weapon", slot: "main_hand" }]]);
    i.items = [{ id: "w", typeId: 1, quantity: 1 }];
    const state = { inventory: i, tab: "character", character: CHARACTER };
    const ctx = stubCtx();
    drawInventory(ctx, layoutInventory(state), state);
    const said = ctx.texts.map((t) => t.text);
    expect(said).toContain("Warrior — Level 7");
    expect(said).not.toContain("SH");   // the sword cell's initials
  });

  it("paints not one empty grid cell over the pane", () => {
    // The `not.toContain("SH")` case above only proves no item LABEL is drawn.
    // An empty cell has no label, so a grid loop left running would paint 48
    // opaque 44x44 rects straight over the character pane and every text
    // assertion would still pass. This measures the rects.
    const state = { inventory: inv(), tab: "character", character: CHARACTER };
    const ctx = stubCtx();
    const layout = layoutInventory(state);
    drawInventory(ctx, layout, state);
    const cellRects = ctx.fillRects.filter((r) => r.w === CELL && r.h === CELL);
    expect(cellRects).toHaveLength(0);

    // Control: the same panel on the All tab DOES paint them, so the zero
    // above is about the branch and not about a stub that records nothing.
    const gridState = { inventory: inv(), tab: "all", character: CHARACTER };
    const gridCtx = stubCtx();
    drawInventory(gridCtx, layoutInventory(gridState), gridState);
    expect(gridCtx.fillRects.filter((r) => r.w === CELL && r.h === CELL))
      .toHaveLength(layout.cells.length);
  });

  it("still paints the item grid on every other tab", () => {
    const i = inv();
    i.types = new Map([[1, { id: 1, name: "short sword", category: "weapon", slot: "main_hand" }]]);
    i.items = [{ id: "w", typeId: 1, quantity: 1 }];
    const state = { inventory: i, tab: "all", character: CHARACTER };
    const ctx = stubCtx();
    drawInventory(ctx, layoutInventory(state), state);
    const said = ctx.texts.map((t) => t.text);
    expect(said).toContain("SH");
    expect(said).not.toContain("Warrior — Level 7");
  });

  it("keeps the paperdoll, the tabs and the gold footer on the Character tab", () => {
    const state = { inventory: inv(), tab: "character", character: CHARACTER, gold: 42 };
    const ctx = stubCtx();
    drawInventory(ctx, layoutInventory(state), state);
    const said = ctx.texts.map((t) => t.text);
    expect(said).toContain("Character");     // the tab label itself
    expect(said).toContain("main_hand");     // a paperdoll box
    expect(said).toContain("Gold: 42");
  });
});
