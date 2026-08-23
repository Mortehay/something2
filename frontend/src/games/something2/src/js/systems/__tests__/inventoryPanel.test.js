import { describe, it, expect } from "vitest";
import { layoutInventory, usedSlotsClient, capacityOf, PANEL_W, PANEL_H } from "../inventoryPanel.js";
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
