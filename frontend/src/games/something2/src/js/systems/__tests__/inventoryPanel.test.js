import { describe, it, expect } from "vitest";
import { layoutInventory, usedSlotsClient, capacityOf, visibleItems, CELLS_PER_PAGE, GRID_COLS, PANEL_W, PANEL_H } from "../inventoryPanel.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../../core/constants.js";

// Minimal inventory in the shape core/inventory.js builds.
function inv({ items = [], equipment = {}, types = [], capacity = null } = {}) {
  return {
    types: new Map(types.map((t) => [t.id, t])),
    items,
    equipment,
    ammoCounts: new Map(),
    capacity,
  };
}

const SWORD = { id: 1, name: "short sword", category: "weapon", slot: "main_hand", damage: 5, cooldown: 1 };
const HELM = { id: 2, name: "iron helm", category: "armor", slot: "head", defense: 3, resistances: {} };
const COIN = { id: 3, name: "gold", category: "currency" };

describe("layoutInventory geometry", () => {
  it("centres the panel on the canvas", () => {
    const l = layoutInventory({ inventory: inv() });
    expect(l.panel).toEqual({
      x: (GAME_WIDTH - PANEL_W) / 2,
      y: (GAME_HEIGHT - PANEL_H) / 2,
      w: PANEL_W,
      h: PANEL_H,
    });
  });

  it("puts the close button inside the title bar, at its right edge", () => {
    const l = layoutInventory({ inventory: inv() });
    expect(l.close.x + l.close.w).toBeLessThanOrEqual(l.panel.x + l.panel.w);
    expect(l.close.y).toBeGreaterThanOrEqual(l.panel.y);
    expect(l.close.y + l.close.h).toBeLessThanOrEqual(l.title.y + l.title.h);
    expect(l.hitAreas).toContainEqual({ ...l.close, kind: "invclose", id: null });
  });

  it("lays out one box per equipment slot, all inside the panel", () => {
    const l = layoutInventory({ inventory: inv() });
    expect(l.slots).toHaveLength(8);
    for (const s of l.slots) {
      expect(s.x).toBeGreaterThanOrEqual(l.panel.x);
      expect(s.y).toBeGreaterThanOrEqual(l.panel.y);
      expect(s.x + s.w).toBeLessThanOrEqual(l.panel.x + l.panel.w);
      expect(s.y + s.h).toBeLessThanOrEqual(l.panel.y + l.panel.h);
      expect(l.hitAreas).toContainEqual({ x: s.x, y: s.y, w: s.w, h: s.h, kind: "slot", id: s.slot });
    }
  });

  it("does not overlap the character preview with any paperdoll box", () => {
    const l = layoutInventory({ inventory: inv() });
    const overlaps = (a, b) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (const s of l.slots) expect(overlaps(l.preview, s)).toBe(false);
  });

  it("names the equipped type and marks a slot disabled when the selection cannot go there", () => {
    const l = layoutInventory({
      inventory: inv({
        types: [SWORD, HELM],
        items: [{ id: "a", typeId: 1, quantity: 1 }, { id: "b", typeId: 2, quantity: 1 }],
        equipment: { head: "b" },
      }),
      selectedItemId: "a",
    });
    const head = l.slots.find((s) => s.slot === "head");
    const mainHand = l.slots.find((s) => s.slot === "main_hand");
    expect(head.equippedName).toBe("iron helm");
    expect(head.disabled).toBe(true);   // a sword cannot go on the head
    expect(mainHand.disabled).toBe(false);
  });

  it("shows the drop control only while an item is selected", () => {
    const items = [{ id: "a", typeId: 1, quantity: 1 }];
    const withSel = layoutInventory({ inventory: inv({ types: [SWORD], items }), selectedItemId: "a" });
    const noSel = layoutInventory({ inventory: inv({ types: [SWORD], items }) });
    expect(withSel.footer.drop).not.toBeNull();
    expect(withSel.hitAreas).toContainEqual({ ...withSel.footer.drop, kind: "drop", id: "a" });
    expect(noSel.footer.drop).toBeNull();
    expect(noSel.hitAreas.some((a) => a.kind === "drop")).toBe(false);
  });

  it("always offers the auto-loot toggle and reports gold", () => {
    const l = layoutInventory({ inventory: inv(), gold: 2439242, autoLoot: true });
    expect(l.footer.gold).toBe(2439242);
    expect(l.footer.autoLootOn).toBe(true);
    expect(l.hitAreas).toContainEqual({ ...l.footer.autoLoot, kind: "autoloot", id: null });
  });
});

describe("capacity accounting", () => {
  it("counts stacks, not quantities, and ignores currency", () => {
    const i = inv({
      types: [SWORD, COIN],
      items: [
        { id: "a", typeId: 1, quantity: 1 },
        { id: "b", typeId: 1, quantity: 40 },
        { id: "c", typeId: 3, quantity: 999 },
      ],
    });
    expect(usedSlotsClient(i)).toBe(2);
  });

  it("counts an item whose type this client does not know", () => {
    expect(usedSlotsClient(inv({ items: [{ id: "a", typeId: 77, quantity: 1 }] }))).toBe(1);
  });

  it("falls back to the page size when the server sent no capacity", () => {
    expect(capacityOf(inv())).toBe(48);
    expect(capacityOf(inv({ capacity: 96 }))).toBe(96);
  });
});

// --- Task 3: tabs, grid and paging -----------------------------------------
const ARROW = { id: 4, name: "arrow", category: "ammo" };
const STONE = { id: 5, name: "flame stone", category: "stone" };
const WEIRD = { id: 6, name: "mystery", category: "relic" };

function bigInv(count) {
  const items = [];
  for (let i = 0; i < count; i += 1) items.push({ id: `i${i}`, typeId: 1, quantity: 1 });
  return inv({ types: [SWORD], items });
}

describe("tabs", () => {
  it("offers exactly the four tabs, All first and active by default", () => {
    const l = layoutInventory({ inventory: inv() });
    expect(l.tabs.map((t) => t.key)).toEqual(["all", "equip", "supply", "stones"]);
    expect(l.tabs[0].active).toBe(true);
    for (const t of l.tabs) expect(l.hitAreas).toContainEqual({ x: t.x, y: t.y, w: t.w, h: t.h, kind: "invtab", id: t.key });
  });

  it("filters by category and never shows currency", () => {
    const i = inv({
      types: [SWORD, HELM, ARROW, STONE, COIN],
      items: [
        { id: "w", typeId: 1, quantity: 1 },
        { id: "h", typeId: 2, quantity: 1 },
        { id: "a", typeId: 4, quantity: 30 },
        { id: "s", typeId: 5, quantity: 1 },
        { id: "g", typeId: 3, quantity: 900 },
      ],
    });
    expect(visibleItems(i, "all").map((x) => x.id)).toEqual(["w", "h", "a", "s"]);
    expect(visibleItems(i, "equip").map((x) => x.id)).toEqual(["w", "h"]);
    expect(visibleItems(i, "supply").map((x) => x.id)).toEqual(["a"]);
    expect(visibleItems(i, "stones").map((x) => x.id)).toEqual(["s"]);
  });

  it("shows an item whose category matches no tab under All", () => {
    const i = inv({ types: [WEIRD], items: [{ id: "x", typeId: 6, quantity: 1 }] });
    expect(visibleItems(i, "all").map((x) => x.id)).toEqual(["x"]);
    expect(visibleItems(i, "equip")).toEqual([]);
  });

  it("marks the requested tab active", () => {
    const l = layoutInventory({ inventory: inv(), tab: "stones" });
    expect(l.tabs.find((t) => t.key === "stones").active).toBe(true);
    expect(l.tabs.find((t) => t.key === "all").active).toBe(false);
  });
});

describe("grid", () => {
  it("always lays out a full page of cells in a rectangle", () => {
    const l = layoutInventory({ inventory: inv() });
    expect(l.cells).toHaveLength(CELLS_PER_PAGE);
    const row0 = l.cells.slice(0, GRID_COLS);
    expect(new Set(row0.map((c) => c.y)).size).toBe(1);
    expect(row0[1].x - row0[0].x).toBe(l.cells[0].w + 4);
    for (const c of l.cells) {
      expect(c.x + c.w).toBeLessThanOrEqual(l.panel.x + l.panel.w);
      expect(c.y + c.h).toBeLessThanOrEqual(l.panel.y + l.panel.h);
    }
  });

  it("fills cells in order and leaves the rest empty", () => {
    const l = layoutInventory({
      inventory: inv({ types: [SWORD, HELM], items: [{ id: "w", typeId: 1, quantity: 1 }, { id: "h", typeId: 2, quantity: 3 }] }),
    });
    expect(l.cells[0].item.id).toBe("w");
    expect(l.cells[0].type.name).toBe("short sword");
    expect(l.cells[1].item.quantity).toBe(3);
    expect(l.cells[2].item).toBeNull();
    expect(l.cells[2].type).toBeNull();
  });

  it("registers a hit area for a filled cell and none for an empty one", () => {
    const l = layoutInventory({ inventory: inv({ types: [SWORD], items: [{ id: "w", typeId: 1, quantity: 1 }] }) });
    expect(l.hitAreas).toContainEqual({ x: l.cells[0].x, y: l.cells[0].y, w: l.cells[0].w, h: l.cells[0].h, kind: "item", id: "w" });
    expect(l.hitAreas.filter((a) => a.kind === "item")).toHaveLength(1);
  });

  it("marks the selected cell", () => {
    const l = layoutInventory({
      inventory: inv({ types: [SWORD], items: [{ id: "w", typeId: 1, quantity: 1 }] }),
      selectedItemId: "w",
    });
    expect(l.cells[0].selected).toBe(true);
  });
});

describe("paging", () => {
  it("reports one page and no arrows when everything fits", () => {
    const l = layoutInventory({ inventory: bigInv(CELLS_PER_PAGE) });
    expect(l.pages.count).toBe(1);
    expect(l.pages.prev).toBeNull();
    expect(l.pages.next).toBeNull();
  });

  it("pages the overflow and offers arrows", () => {
    const l = layoutInventory({ inventory: bigInv(CELLS_PER_PAGE + 1) });
    expect(l.pages.count).toBe(2);
    expect(l.pages.next).not.toBeNull();
    expect(l.hitAreas).toContainEqual({ ...l.pages.next, kind: "invpage", id: 1 });
    expect(l.pages.prev).toBeNull(); // on page 0 there is nowhere back to go
  });

  it("shows the tail of the list on the last page", () => {
    const l = layoutInventory({ inventory: bigInv(CELLS_PER_PAGE + 2), page: 1 });
    expect(l.cells[0].item.id).toBe(`i${CELLS_PER_PAGE}`);
    expect(l.cells[1].item.id).toBe(`i${CELLS_PER_PAGE + 1}`);
    expect(l.cells[2].item).toBeNull();
    expect(l.pages.prev).not.toBeNull();
    expect(l.pages.next).toBeNull();
  });

  it("clamps a page that is past the end", () => {
    const l = layoutInventory({ inventory: bigInv(3), page: 7 });
    expect(l.pages.page).toBe(0);
    expect(l.cells[0].item.id).toBe("i0");
  });
});
