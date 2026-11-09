import { describe, it, expect } from "vitest";
import {
  isLootMap, isStone, stoneKind, stoneFitsHost, socketedStoneOf, hostOfStone, hasStone, canSocket,
  defaultHostFor, itemActionFor, stoneIdForUnsocket, itemHintLines, resolveStoneDrop, describeWhere,
  UNSOCKET_CONFIRM_LABEL, DOUBLE_CLICK_MS, CONFIRM_WINDOW_MS,
} from "../itemActions.js";
import { layoutInventory, resolveDrop } from "../inventoryPanel.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

// a (640, 640) step is about 905 px along the diagonal
const TILES = Math.round(Math.hypot(640, 640) / MAP_TILE_SIZE);

const SWORD = { id: 1, name: "short sword", category: "weapon", slot: "main_hand", kind: "melee", damage: 5, cooldown: 1 };
const SWORD2 = { id: 2, name: "long sword", category: "weapon", slot: "main_hand", kind: "melee", damage: 6, cooldown: 1 };
const HELM = { id: 3, name: "iron helm", category: "armor", slot: "head", defense: 3, resistances: {} };
const MAP = { id: 4, name: "loot_map", category: "consumable" };
const POTION = { id: 5, name: "potion", category: "consumable" };
const SPELL = { id: 6, name: "storm staff stone", category: "stone", element: "lightning", stone_mode: "replace" };
const BUFF = { id: 7, name: "ruby", category: "stone", element: null, stat_bonus_stat: "strength" };
const AUGMENT = { id: 8, name: "fire rune", category: "stone", element: "fire", stone_mode: "augment" };
const TYPES = [SWORD, SWORD2, HELM, MAP, POTION, SPELL, BUFF, AUGMENT];

function inv({ items = [], equipment = {} } = {}) {
  return { types: new Map(TYPES.map((t) => [t.id, t])), items, equipment, ammoCounts: new Map(), capacity: 48 };
}
const item = (id, typeId, over = {}) => ({ id, typeId, quantity: 1, ...over });
const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

describe("classification (mirrors backend/src/services/stones.js)", () => {
  it("knows loot maps and stones", () => {
    expect(isLootMap(MAP)).toBe(true);
    expect(isLootMap(POTION)).toBe(false);
    expect(isLootMap(null)).toBe(false);
    expect(isStone(SPELL)).toBe(true);
    expect(isStone(SWORD)).toBe(false);
  });
  it("classifies a stone as augment, spell or buff, augment first", () => {
    expect(stoneKind(AUGMENT)).toBe("augment");
    expect(stoneKind(SPELL)).toBe("spell");
    expect(stoneKind(BUFF)).toBe("buff");
  });
  it("spell and augment stones fit weapons only; a buff stone fits weapons and armour", () => {
    expect(stoneFitsHost(SPELL, SWORD)).toBe(true);
    expect(stoneFitsHost(SPELL, HELM)).toBe(false);
    expect(stoneFitsHost(AUGMENT, HELM)).toBe(false);
    expect(stoneFitsHost(BUFF, HELM)).toBe(true);
    expect(stoneFitsHost(BUFF, SWORD)).toBe(true);
    expect(stoneFitsHost(BUFF, POTION)).toBe(false);
    expect(stoneFitsHost(SWORD, SWORD)).toBe(false);
  });
});

describe("canSocket", () => {
  const i = inv({ items: [item("s", 6), item("w", 1), item("h", 3), item("w2", 2, { socketedStoneItemId: "s9", socketedStoneTypeId: 6 }), item("s9", 6)] });
  const S = i.items.find((x) => x.id === "s");
  it("accepts a fitting stone and a free host", () => {
    expect(canSocket(i, S, i.items.find((x) => x.id === "w"))).toEqual({ ok: true });
  });
  it("says why not, in words fit for a toast", () => {
    expect(canSocket(i, S, i.items.find((x) => x.id === "h")).reason).toMatch(/does not fit/);
    expect(canSocket(i, S, i.items.find((x) => x.id === "w2")).reason).toMatch(/take it out first/);
    expect(canSocket(i, S, S).reason).toMatch(/itself/);
    expect(canSocket(i, S, null).reason).toMatch(/weapon/);
    expect(canSocket(i, i.items.find((x) => x.id === "w"), S).reason).toMatch(/not a magic stone/);
  });
  it("refuses a stone that is already socketed", () => {
    expect(canSocket(i, i.items.find((x) => x.id === "s9"), i.items.find((x) => x.id === "w")).reason).toMatch(/already socketed/);
  });
  it("tells a stone dropped on another stone to use a weapon", () => {
    const other = item("s2", 7);
    const j = inv({ items: [item("s", 6), other] });
    expect(canSocket(j, j.items[0], other).reason).toMatch(/weapon/);
  });
});

describe("what is socketed where", () => {
  const i = inv({ items: [item("w", 1, { socketedStoneItemId: "s", socketedStoneTypeId: 6 }), item("s", 6), item("free", 7)] });
  it("finds the stone of a host and the host of a stone", () => {
    expect(socketedStoneOf(i, i.items[0]).id).toBe("s");
    expect(socketedStoneOf(i, i.items[2])).toBeNull();
    expect(hostOfStone(i, i.items[1]).id).toBe("w");
    expect(hostOfStone(i, i.items[2])).toBeNull();
    expect(hasStone(i.items[0])).toBe(true);
    expect(hasStone(i.items[2])).toBe(false);
  });
});

describe("defaultHostFor", () => {
  it("prefers the weapon in the main hand, then the off hand", () => {
    const i = inv({
      items: [item("s", 6), item("mh", 1), item("oh", 2)],
      equipment: { main_hand: "mh", off_hand: "oh" },
    });
    expect(defaultHostFor(i, i.items[0]).id).toBe("mh");
  });
  it("skips a hand that already holds a stone", () => {
    const i = inv({
      items: [item("s", 6), item("mh", 1, { socketedStoneItemId: "x", socketedStoneTypeId: 6 }), item("oh", 2)],
      equipment: { main_hand: "mh", off_hand: "oh" },
    });
    expect(defaultHostFor(i, i.items[0]).id).toBe("oh");
  });
  it("is null with nothing wielded", () => {
    const i = inv({ items: [item("s", 6)] });
    expect(defaultHostFor(i, i.items[0])).toBeNull();
  });
});

describe("itemActionFor: the one contextual button", () => {
  const i = inv({
    items: [item("map", 4), item("pot", 5), item("s", 6), item("w", 1), item("hold", 2, { socketedStoneItemId: "in", socketedStoneTypeId: 6 }), item("in", 6)],
  });
  it("Use for a loot map", () => {
    expect(itemActionFor(i, "map")).toEqual({ act: "use", label: "Use", itemId: "map" });
  });
  it("nothing for an ordinary consumable or a plain weapon", () => {
    expect(itemActionFor(i, "pot")).toBeNull();
    expect(itemActionFor(i, "w")).toBeNull();
    expect(itemActionFor(i, null)).toBeNull();
    expect(itemActionFor(i, "ghost")).toBeNull();
  });
  it("Socket for a free stone", () => {
    expect(itemActionFor(i, "s")).toEqual({ act: "socket", label: "Socket", itemId: "s" });
  });
  it("Take out for a socketed stone and for the item holding it, armed on the second click", () => {
    expect(itemActionFor(i, "in")).toEqual({ act: "unsocket", label: "Take out", itemId: "in", armed: false });
    expect(itemActionFor(i, "hold")).toEqual({ act: "unsocket", label: "Take out", itemId: "hold", armed: false });
    const armed = itemActionFor(i, "hold", "hold");
    expect(armed.armed).toBe(true);
    expect(armed.label).toBe(UNSOCKET_CONFIRM_LABEL);
    expect(itemActionFor(i, "hold", "someone-else").armed).toBe(false);
  });
  it("the id sent to the server is always the stone's", () => {
    expect(stoneIdForUnsocket(i, i.items.find((x) => x.id === "hold"))).toBe("in");
    expect(stoneIdForUnsocket(i, i.items.find((x) => x.id === "in"))).toBe("in");
    expect(stoneIdForUnsocket(i, i.items.find((x) => x.id === "s"))).toBeNull();
    expect(stoneIdForUnsocket(i, i.items.find((x) => x.id === "w"))).toBeNull();
    expect(stoneIdForUnsocket(i, null)).toBeNull();
  });
  it("the windows are short enough to be a gesture and long enough to be a choice", () => {
    expect(DOUBLE_CLICK_MS).toBeGreaterThan(200);
    expect(DOUBLE_CLICK_MS).toBeLessThan(600);
    expect(CONFIRM_WINDOW_MS).toBeGreaterThanOrEqual(2000);
  });
});

describe("tooltip hints", () => {
  const i = inv({
    items: [item("hold", 1, { socketedStoneItemId: "in", socketedStoneTypeId: 6 }), item("in", 6), item("free", 7), item("map", 4)],
  });
  const text = (it, t) => itemHintLines(i, it, t).map((l) => l.text);
  it("a host says which stone it holds", () => {
    expect(itemHintLines(i, i.items[0], SWORD)[0]).toMatchObject({ text: "Socketed: {name}", params: { name: "storm staff stone" } });
  });
  it("a socketed stone says where, a free stone says how", () => {
    expect(itemHintLines(i, i.items[1], SPELL)[0]).toMatchObject({ text: "Socketed into: {name}", params: { name: "short sword" } });
    expect(text(i.items[2], BUFF)).toEqual(["Drag onto a weapon to socket it"]);
  });
  it("a loot map says how to use it", () => {
    expect(text(i.items[3], MAP)[0]).toMatch(/Double-click/);
  });
  it("an ordinary item adds nothing", () => {
    expect(itemHintLines(i, item("p", 5), POTION)).toEqual([]);
    expect(itemHintLines(i, null, null)).toEqual([]);
  });
});

describe("dragging a stone through the real layout", () => {
  const i = inv({
    items: [item("s", 6), item("w", 1), item("w2", 2), item("h", 3), item("map", 4)],
    equipment: { main_hand: "w" },
  });
  const layout = layoutInventory({ inventory: i });
  const drag = { itemId: "s", from: { kind: "item", id: "s" } };
  const cellOf = (id) => layout.cells.find((c) => c.item && c.item.id === id);
  const slot = layout.slots.find((s) => s.slot === "main_hand");

  it("on the equipped weapon's slot: socket", () => {
    const r = resolveStoneDrop(layout, drag, centre(slot), i);
    expect(r).toEqual({ action: "socket", stoneId: "s", hostId: "w" });
    expect(resolveDrop(layout, drag, centre(slot), i)).toEqual({ action: "socket", stoneId: "s", hostId: "w" });
  });
  it("on a weapon in the bag: socket", () => {
    expect(resolveDrop(layout, drag, centre(cellOf("w2")), i)).toEqual({ action: "socket", stoneId: "s", hostId: "w2" });
  });
  it("on a helm: refused, with the reason", () => {
    expect(resolveDrop(layout, drag, centre(cellOf("h")), i)).toEqual({ action: "none", reason: "That stone does not fit this item" });
  });
  it("on itself: nothing, quietly", () => {
    expect(resolveDrop(layout, drag, centre(cellOf("s")), i)).toEqual({ action: "none" });
  });
  it("on an empty cell or an empty slot it is not a socketing gesture: the old rules apply", () => {
    const empty = layout.cells.find((c) => !c.item);
    expect(resolveStoneDrop(layout, drag, centre(empty), i)).toBeNull();
    expect(resolveDrop(layout, drag, centre(empty), i)).toEqual({ action: "none" });
    const head = layout.slots.find((s) => s.slot === "head");
    expect(resolveDrop(layout, drag, centre(head), i)).toEqual({ action: "none" });
  });
  it("outside the panel a stone is still dropped on the ground", () => {
    expect(resolveDrop(layout, drag, { x: 1, y: 1 }, i)).toEqual({ action: "drop", itemId: "s" });
  });
  it("a weapon dragged onto a stone does not socket anything (only stones are dragged to socket)", () => {
    const w = { itemId: "w2", from: { kind: "item", id: "w2" } };
    expect(resolveStoneDrop(layout, w, centre(cellOf("s")), i)).toBeNull();
  });
});

describe("the footer button in the layout", () => {
  const i = inv({ items: [item("map", 4), item("w", 1)] });
  it("is drawn beside Drop for a loot map and is a hit area", () => {
    const l = layoutInventory({ inventory: i, selectedItemId: "map" });
    expect(l.footer.action).toMatchObject({ act: "use", label: "Use", itemId: "map" });
    expect(l.footer.action.y).toBe(l.footer.drop.y);
    expect(l.footer.action.x).toBeGreaterThanOrEqual(l.footer.drop.x + l.footer.drop.w);
    expect(l.footer.action.x + l.footer.action.w).toBeLessThanOrEqual(l.panel.x + l.panel.w);
    expect(l.hitAreas).toContainEqual(expect.objectContaining({ kind: "itemaction", id: "map", act: "use" }));
  });
  it("is absent for an item with no action, with nothing selected, and beside a chest window", () => {
    expect(layoutInventory({ inventory: i, selectedItemId: "w" }).footer.action).toBeNull();
    expect(layoutInventory({ inventory: i }).footer.action).toBeNull();
    expect(layoutInventory({ inventory: i, selectedItemId: "map", paired: true }).footer.action).toBeNull();
  });
  it("shows the confirming label while a take-out is armed", () => {
    const j = inv({ items: [item("h", 1, { socketedStoneItemId: "s", socketedStoneTypeId: 6 }), item("s", 6)] });
    expect(layoutInventory({ inventory: j, selectedItemId: "h" }).footer.action.label).toBe("Take out");
    expect(layoutInventory({ inventory: j, selectedItemId: "h", unsocketArmedId: "h" }).footer.action.label).toBe(UNSOCKET_CONFIRM_LABEL);
  });
});

describe("describeWhere", () => {
  const origin = { x: 1000, y: 1000 };
  it("counts tiles and names the screen's compass direction", () => {
    // +x and +y both go down the screen (the iso diamond's south); +x alone goes down-right.
    expect(describeWhere(origin, { x: 1000 + 640, y: 1000 + 640 })).toEqual({ tiles: TILES, direction: "south" });
    expect(describeWhere(origin, { x: 1000 - 640, y: 1000 - 640 })).toEqual({ tiles: TILES, direction: "north" });
    expect(describeWhere(origin, { x: 1000 + 640, y: 1000 - 640 }).direction).toBe("east");
    expect(describeWhere(origin, { x: 1000 - 640, y: 1000 + 640 }).direction).toBe("west");
    expect(describeWhere(origin, { x: 1000 + 640, y: 1000 }).direction).toBe("south-east");
    expect(describeWhere(origin, { x: 1000, y: 1000 - 640 }).direction).toBe("north-east");
  });
  it("says nothing about a chest on top of you", () => {
    expect(describeWhere(origin, origin)).toEqual({ tiles: 0, direction: null });
    expect(describeWhere(origin, { x: 1010, y: 1010 })).toEqual({ tiles: 0, direction: null });
  });
});
