import { describe, it, expect } from "vitest";
import { layoutInventory, resolveDrop } from "../inventoryPanel.js";

const SWORD = { id: 1, name: "short sword", category: "weapon", slot: "main_hand", damage: 5, cooldown: 1 };
const HELM = { id: 2, name: "iron helm", category: "armor", slot: "head", defense: 3, resistances: {} };

function inv({ items = [], equipment = {}, types = [SWORD, HELM] } = {}) {
  return { types: new Map(types.map((t) => [t.id, t])), items, equipment, ammoCounts: new Map(), capacity: 48 };
}

// Points come from a REAL layout, not hand-built rects: a test that invents
// its own geometry stops testing the thing the mouse will actually hit.
function centre(rect) { return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }; }

describe("resolveDrop", () => {
  const i = inv({ items: [{ id: "w", typeId: 1, quantity: 1 }, { id: "h", typeId: 2, quantity: 1 }] });
  const layout = layoutInventory({ inventory: i });
  const mainHand = layout.slots.find((s) => s.slot === "main_hand");
  const head = layout.slots.find((s) => s.slot === "head");

  it("equips a cell dropped on a legal slot", () => {
    const r = resolveDrop(layout, { itemId: "w", from: { kind: "item", id: "w" } }, centre(mainHand), i);
    expect(r).toEqual({ action: "equip", itemId: "w", slot: "main_hand" });
  });

  it("refuses a cell dropped on an illegal slot", () => {
    const r = resolveDrop(layout, { itemId: "w", from: { kind: "item", id: "w" } }, centre(head), i);
    expect(r).toEqual({ action: "none" });
  });

  it("unequips a slot dragged into the grid", () => {
    const equipped = inv({ items: [{ id: "h", typeId: 2, quantity: 1 }], equipment: { head: "h" } });
    const l = layoutInventory({ inventory: equipped });
    const r = resolveDrop(l, { itemId: "h", from: { kind: "slot", id: "head" } }, centre(l.cells[10]), equipped);
    expect(r).toEqual({ action: "unequip", slot: "head" });
  });

  it("refuses dragging an empty slot", () => {
    const r = resolveDrop(layout, { itemId: null, from: { kind: "slot", id: "feet" } }, centre(layout.cells[0]), i);
    expect(r).toEqual({ action: "none" });
  });

  it("drops an item dragged outside the panel", () => {
    const r = resolveDrop(layout, { itemId: "w", from: { kind: "item", id: "w" } }, { x: 5, y: 5 }, i);
    expect(r).toEqual({ action: "drop", itemId: "w" });
  });

  it("refuses a cell dropped on another cell — there is no persisted order to change", () => {
    const r = resolveDrop(layout, { itemId: "w", from: { kind: "item", id: "w" } }, centre(layout.cells[5]), i);
    expect(r).toEqual({ action: "none" });
  });

  it("refuses a drop onto the panel's own chrome", () => {
    const r = resolveDrop(layout, { itemId: "w", from: { kind: "item", id: "w" } }, centre(layout.close), i);
    expect(r).toEqual({ action: "none" });
  });

  it("refuses when there is no drag", () => {
    expect(resolveDrop(layout, null, { x: 5, y: 5 }, i)).toEqual({ action: "none" });
  });

  it("refuses a point that is not a pair of numbers", () => {
    const drag = { itemId: "w", from: { kind: "item", id: "w" } };
    expect(resolveDrop(layout, drag, {}, i)).toEqual({ action: "none" });
    expect(resolveDrop(layout, drag, null, i)).toEqual({ action: "none" });
  });
});
