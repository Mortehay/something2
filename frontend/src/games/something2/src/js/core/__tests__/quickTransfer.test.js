// Ctrl+click moves an item to the other side of an open chest / merchant / trade window, the same way a drag
// would -- through the same resolver, so worn gear, a locked trade and the server's own checks all still apply.
import { describe, it, expect } from "vitest";
import { Game } from "../Game.js";
import { createInventory } from "../inventory.js";

const WEAPON = { id: 1, name: "sword", category: "weapon", damage: 10, cooldown: 1, kind: "melee" };

function makeGame(paired) {
  const g = new Game();
  g.state = "playing";
  g.chunked = true;
  g.player = { x: 100, y: 100, width: 64, height: 64 };
  g.canvas = { width: 1280, height: 720 };
  g.camera = { screenX: 0, screenY: 0 };
  g.inventory = createInventory();
  g.inventory.types.set(WEAPON.id, WEAPON);
  g.inventory.items = [{ id: "bag", typeId: 1, quantity: 1 }, { id: "worn", typeId: 1, quantity: 1 }];
  g.inventory.equipment = { main_hand: "worn" };
  g.gold = 1000;
  g.toasts = [];
  g._showToast = (t) => g.toasts.push(t);
  g.sent = [];
  const rec = (name) => (...args) => { g.sent.push([name, ...args]); return true; };
  g.authorityClient = {
    sendDeposit: rec("deposit"), sendWithdraw: rec("withdraw"), sendBuy: rec("buy"), sendSell: rec("sell"),
    sendTradeItem: rec("tradeItem"), sendEquip: rec("equip"), sendUnequip: rec("unequip"),
  };
  if (paired === "chest") { g.bankOpen = true; g.bank = { items: [] }; }
  if (paired === "merchant") { g.shopOpen = true; g.shop = { sellQuotes: { bag: 25 }, reputation: {} }; }
  if (paired === "trade") { g.tradeOpen = true; g.trade = { phase: "open", mine: { gold: 0 } }; }
  const kind = paired === "merchant" ? "merchant" : paired;
  g.renderSystem = {
    _winLayout: {
      panel: { x: 100, y: 100, w: 300, h: 300 }, kind, occupancy: { full: false }, myLocked: false, settling: false, offeredIds: [],
    },
    _invLayout: {
      panel: { x: 500, y: 100, w: 300, h: 300 },
      slots: [{ x: 510, y: 110, w: 40, h: 40, slot: "main_hand" }],
      cells: [{ x: 520, y: 200, w: 40, h: 40 }, { x: 570, y: 200, w: 40, h: 40 }],
    },
    _invHitAreas: [
      { kind: "item", id: "bag", x: 520, y: 200, w: 40, h: 40 },
      { kind: "slot", id: "main_hand", x: 510, y: 110, w: 40, h: 40 },
    ],
    _winHitAreas: [
      { kind: "chestitem", id: "c1", typeId: 1, x: 120, y: 200, w: 40, h: 40 },
      { kind: "stockitem", id: "s1", typeId: 1, price: 50, x: 170, y: 200, w: 40, h: 40 },
      { kind: "tradeitem", id: "t1", typeId: 1, x: 220, y: 200, w: 40, h: 40 },
    ],
  };
  return g;
}

describe("Ctrl+click between the bag and a chest", () => {
  it("stores a bag item in the chest", () => {
    const g = makeGame("chest");
    g._handlePairedPress(540, 220, true);
    expect(g.sent).toEqual([["deposit", "bag"]]);
    expect(g.inventoryDrag).toBeNull();
  });

  it("takes a chest item into the bag", () => {
    const g = makeGame("chest");
    g._handlePairedPress(140, 220, true);
    expect(g.sent).toEqual([["withdraw", "c1"]]);
    expect(g.inventoryDrag).toBeNull();
  });

  it("without Ctrl nothing is sent: a plain press only starts a drag, as before", () => {
    const g = makeGame("chest");
    g._handlePairedPress(540, 220, false);
    expect(g.sent).toEqual([]);
    expect(g.inventoryDrag).toMatchObject({ from: { kind: "item", id: "bag" }, armed: false });
    g._handlePairedPress(140, 220, false);
    expect(g.sent).toEqual([]);
    expect(g.inventoryDrag).toMatchObject({ from: { kind: "chestitem", id: "c1" } });
  });

  it("refuses a worn item the way a drag does, and sends nothing", () => {
    const g = makeGame("chest");
    g._handlePairedPress(520, 120, true);                  // the equipment slot, not a bag cell
    expect(g.sent).toEqual([]);
    expect(g.inventoryDrag).toMatchObject({ from: { kind: "slot", id: "main_hand" } });
  });
});

describe("Ctrl+click between the bag and a merchant", () => {
  it("sells a bag item", () => {
    const g = makeGame("merchant");
    g._handlePairedPress(540, 220, true);
    expect(g.sent).toEqual([["sell", "bag"]]);
  });

  it("buys a ware", () => {
    const g = makeGame("merchant");
    g._handlePairedPress(190, 220, true);
    expect(g.sent).toEqual([["buy", "s1"]]);
  });
});

describe("Ctrl+click in a trade", () => {
  it("offers a bag item", () => {
    const g = makeGame("trade");
    g._handlePairedPress(540, 220, true);
    expect(g.sent).toEqual([["tradeItem", "bag", true]]);
  });

  it("takes an offered item back", () => {
    const g = makeGame("trade");
    g._handlePairedPress(240, 220, true);
    expect(g.sent).toEqual([["tradeItem", "t1", false]]);
  });

  it("does nothing once my side is locked", () => {
    const g = makeGame("trade");
    g.renderSystem._winLayout.myLocked = true;
    g._handlePairedPress(540, 220, true);
    g._handlePairedPress(240, 220, true);
    expect(g.sent).toEqual([]);
  });
});

describe("Ctrl+click with no window to send to", () => {
  it("in the bare inventory it is an ordinary press", () => {
    const g = makeGame(null);
    g.inventoryOpen = true;
    g._handleInventoryPress(540, 220, true);
    expect(g.sent).toEqual([]);
    expect(g.inventoryDrag).toMatchObject({ from: { kind: "item", id: "bag" } });
  });

  it("a window that is open but has not received its contents yet ignores it", () => {
    const g = makeGame("chest");
    g.bank = null;                                         // opened, frame not here yet
    g._handlePairedPress(540, 220, true);
    expect(g.sent).toEqual([]);
  });

  it("without layouts (nothing drawn yet) it does not throw and sends nothing", () => {
    const g = makeGame("chest");
    g.renderSystem._winLayout = null;
    expect(g._quickTransfer({ itemId: "bag", from: { kind: "item", id: "bag" } })).toBe(false);
    expect(g.sent).toEqual([]);
  });
});
