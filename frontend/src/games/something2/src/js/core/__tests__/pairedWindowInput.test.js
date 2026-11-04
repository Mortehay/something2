// The mouse on the Account Chest / merchant windows beside the inventory.
// Everything goes through the real _mouseDownHandler, _mouseMoveHandler and
// _mouseUpHandler, against hit areas a real RenderSystem frame published from
// Game's own render params. Mistakes here cost players items or gold, so the
// send spies are asserted exactly, including "nothing at all".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const authority = vi.hoisted(() => ({ opts: null }));
vi.mock("../../net/WorldAuthorityClient.js", () => ({
  WorldAuthorityClient: class {
    constructor(opts) { authority.opts = opts; }
    connect() {}
    disconnect() {}
  },
}));
vi.mock("../../net/auth.js", async (original) => ({
  ...(await original()),
  getStoredToken: () => "token",
  parseJwt: () => ({ user_id: 1 }),
}));

import { Game } from "../Game.js";
import { RenderSystem } from "../../systems/RenderSystem.js";
import { REFUSE_WORN } from "../../systems/pairedDrop.js";
import { lockedToastText } from "../../systems/shopReputation.js";
import { layoutInventory } from "../../systems/inventoryPanel.js";
import { INVENTORY_X } from "../../systems/storageWindows.js";

const NativeMap = globalThis.Map;
const SWORD = { id: 1, name: "Sword", category: "weapon", slot: "main_hand", damage: 5, cooldown: 1 };
const HELM = { id: 2, name: "Helm", category: "armor", slot: "head", defense: 3 };

const SEND = [
  "sendDeposit", "sendWithdraw", "sendBuy", "sendSell", "sendEquip", "sendUnequip", "sendDrop",
  "sendAttack", "sendInteract", "sendOpenBank", "sendOpenChest", "sendPickup",
];

function stubCtx() {
  const noop = () => {};
  return new Proxy({ measureText: (s) => ({ width: String(s).length * 6 }), createRadialGradient: () => ({ addColorStop: noop }), createLinearGradient: () => ({ addColorStop: noop }) }, {
    get: (o, k) => (k in o ? o[k] : noop),
    set: (o, k, v) => { o[k] = v; return true; },
  });
}

function frame(g) { g.render(); return g.renderSystem; }

// A real RenderSystem drawing a real Game.render()'s panel params; only the
// world underneath the windows is stubbed out.
function realRenderSystem() {
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = stubCtx();
  rs.canvas = { width: 1280, height: 720 };
  rs.imageManager = { get: () => null };
  rs.renderHud = () => {};
  rs.renderChunked = (params) => RenderSystem.prototype.renderChunked.call(rs, {
    inventory: params.inventory, inventoryOpen: params.inventoryOpen, inventoryView: params.inventoryView,
    selectedItemId: params.selectedItemId, gold: params.gold,
    shop: params.shop, shopOpen: params.shopOpen, shopView: params.shopView,
    bank: params.bank, bankOpen: params.bankOpen,
    player: { x: 0, y: 0, width: 32, height: 32, hp: 10, maxHp: 10, facing: "down", effects: null },
    camera: { apply() {}, reset() {}, screenX: 0, screenY: 0, width: 1280, height: 720, x: 0, y: 0 },
    chunkedMap: { mapTiles: [], chunks: new NativeMap(), chunkSize: 16, tileSize: 32, loadedKeys: () => [] },
    remotePlayers: new NativeMap(),
    localUserId: 1,
  });
  return rs;
}

const stock = (id, over = {}) => ({ id, itemTypeId: 1, price: 40, quantity: 1, sellerUserId: null, ...over });
const SHOP_MSG = {
  villageId: 1,
  catalog: [stock(5, { price: 95 }), stock(6, { itemTypeId: 2, price: 30 })],
  buyback: [stock(77, { itemTypeId: 2, price: 12 }), stock(78, { price: 15 })],
  lockedCatalog: [stock(50, { price: 500, minReputation: 100, requiredTier: "Honored" })],
  reputation: { points: 40 },
  sellQuotes: { 101: 12 },
};
const BANK_MSG = {
  villageId: 1,
  capacity: 40,
  items: [{ id: 21, slot: 0, typeId: 2, quantity: 1 }, { id: 22, slot: 3, typeId: 1, quantity: 1 }],
};

function setupState(g) {
  g.canvas = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    getContext: () => stubCtx(),
    width: 1280,
    height: 720,
  };
  g.ctx = stubCtx();
  g.state = "playing";
  g.chunked = true;
  g.gold = 500;
  g.player = { x: 0, y: 0, width: 64, height: 64 };
  g.groundItems = { all: () => [] };
  g.creatures = { all: () => [] };
  g.projectiles = { all: () => [] };
  g.inventory = {
    types: new NativeMap([[1, SWORD], [2, HELM]]),
    items: [{ id: 101, typeId: 1, quantity: 1 }, { id: 102, typeId: 2, quantity: 1 }, { id: 103, typeId: 1, quantity: 1 }],
    equipment: { main_hand: 103 },
    ammoCounts: new NativeMap(),
    capacity: 48,
  };
  g.authorityClient = Object.fromEntries(SEND.map((name) => [name, vi.fn()]));
  g.renderSystem = realRenderSystem();
  g.setupInput();
  g.showToast = vi.fn();
  g._showToast = vi.fn();
}

function makeGame(kind = null) {
  const g = new Game();
  setupState(g);
  if (kind === "chest") g.openBank(BANK_MSG);
  if (kind === "merchant") g.openShop(SHOP_MSG);
  frame(g);
  return g;
}

const centre = (r) => ({ clientX: r.x + r.w / 2, clientY: r.y + r.h / 2, button: 0 });
const point = (x, y, button = 0) => ({ clientX: x, clientY: y, button });

function press(g, r) { g._mouseDownHandler(centre(r)); frame(g); }
function moveTo(g, r) { g._mouseMoveHandler(centre(r)); frame(g); }
function release(g, r) { g._mouseUpHandler(centre(r)); frame(g); }
function click(g, r) { press(g, r); release(g, r); }
function drag(g, from, to) { press(g, from); moveTo(g, to); release(g, to); }

const win = (g) => g.renderSystem._winLayout;
const inv = (g) => g.renderSystem._invLayout;
const invCell = (g, id) => inv(g).cells.find((c) => c.item && c.item.id === id);
const invSlot = (g, slot) => inv(g).slots.find((s) => s.slot === slot);
const emptyInvCell = (g) => inv(g).cells.find((c) => !c.item);
const winCell = (g, id) => win(g).cells.find((c) => c.item && c.item.id === id);
const area = (g, kind, id) => g.renderSystem._winHitAreas.find((a) => a.kind === kind && (id === undefined || a.id === id));
const invArea = (g, kind, id) => g.renderSystem._invHitAreas.find((a) => a.kind === kind && (id === undefined || a.id === id));
const OUTSIDE = { x: 4, y: 4, w: 2, h: 2 };

function sent(g) {
  return SEND.flatMap((name) => g.authorityClient[name].mock.calls.map((args) => [name, ...args]));
}

describe("paired window input", () => {
  let originalWindow;
  beforeEach(() => {
    originalWindow = globalThis.window;
    globalThis.window = {
      addEventListener: vi.fn(), removeEventListener: vi.fn(), innerWidth: 1280, innerHeight: 720,
      location: { protocol: "http:", host: "localhost", hostname: "localhost" },
    };
    authority.opts = null;
    vi.spyOn(console, "log").mockImplementation(() => {}); // Game's constructor logs
  });
  afterEach(() => { globalThis.window = originalWindow; vi.restoreAllMocks(); });

  describe("chest", () => {
    it("dragging an inventory item onto the chest sends sendDeposit(id)", () => {
      const g = makeGame("chest");
      drag(g, invCell(g, 101), win(g).panel);
      expect(sent(g)).toEqual([["sendDeposit", 101]]);
    });

    it("every rendered chest item takes by its own chest row id", () => {
      const g = makeGame("chest");
      drag(g, winCell(g, 21), inv(g).panel);
      drag(g, winCell(g, 22), emptyInvCell(g));
      expect(sent(g)).toEqual([["sendWithdraw", 21], ["sendWithdraw", 22]]);
    });

    it("a chest item dropped on an equipment slot sends nothing: no direct equip from the windows", () => {
      const g = makeGame("chest");
      drag(g, winCell(g, 22), invSlot(g, "main_hand"));
      expect(sent(g)).toEqual([]);
    });
  });

  describe("merchant", () => {
    it("dragging an inventory item onto the merchant sends sendSell(item id)", () => {
      const g = makeGame("merchant");
      drag(g, invCell(g, 101), win(g).panel);
      drag(g, invCell(g, 102), winCell(g, 6));
      expect(sent(g)).toEqual([["sendSell", 101], ["sendSell", 102]]);
    });

    it("a sale with no quote is still sent, and the server decides", () => {
      const g = makeGame("merchant");
      expect(g.shop.sellQuotes[102]).toBeUndefined();
      drag(g, invCell(g, 102), win(g).panel);
      expect(sent(g)).toEqual([["sendSell", 102]]);
    });

    it("every catalog ware buys by its own stock id", () => {
      const g = makeGame("merchant");
      drag(g, winCell(g, 5), inv(g).panel);
      drag(g, winCell(g, 6), emptyInvCell(g));
      expect(sent(g)).toEqual([["sendBuy", 5], ["sendBuy", 6]]);
    });

    it("every buy-back row buys by its own stock id", () => {
      const g = makeGame("merchant");
      click(g, area(g, "shoptab", "buyback"));
      expect(sent(g)).toEqual([]);
      drag(g, winCell(g, 77), inv(g).panel);
      drag(g, winCell(g, 78), inv(g).panel);
      expect(sent(g)).toEqual([["sendBuy", 77], ["sendBuy", 78]]);
    });

    it("a buy the player cannot afford is still sent: the server refuses in its own words", () => {
      const g = makeGame("merchant");
      g.gold = 1;
      drag(g, winCell(g, 5), inv(g).panel);
      expect(sent(g)).toEqual([["sendBuy", 5]]);
    });

    it("a press on a locked ware shows lockedToastText and starts no drag", () => {
      const g = makeGame("merchant");
      const cell = winCell(g, 50);
      expect(cell.locked).toBe(true);
      press(g, cell);
      expect(g._showToast).toHaveBeenCalledWith(lockedToastText(cell.item, g.shop.reputation));
      expect(g.inventoryDrag).toBeNull();
      moveTo(g, inv(g).panel);
      release(g, inv(g).panel);
      expect(sent(g)).toEqual([]);
    });

    it("tabs and pages change the view and send nothing", () => {
      const g = makeGame();
      g.openShop({ ...SHOP_MSG, catalog: Array.from({ length: 45 }, (_, i) => stock(1000 + i)), lockedCatalog: [] });
      frame(g);
      click(g, area(g, "shoppage", 1));
      expect(g.shopView).toEqual({ tab: "catalog", page: 1 });
      expect(winCell(g, 1040)).toBeTruthy();
      click(g, area(g, "shoppage", 0));
      expect(g.shopView.page).toBe(0);
      click(g, area(g, "shoptab", "buyback"));
      expect(g.shopView).toEqual({ tab: "buyback", page: 0 });
      click(g, area(g, "shoptab", "catalog"));
      expect(g.shopView).toEqual({ tab: "catalog", page: 0 });
      expect(sent(g)).toEqual([]);
    });
  });

  describe("inventory side, while paired", () => {
    it("inventory tabs and pages work and send nothing", () => {
      for (const kind of ["chest", "merchant"]) {
        const g = makeGame(kind);
        g.inventory.items = Array.from({ length: 60 }, (_, i) => ({ id: 2000 + i, typeId: 1, quantity: 1 }));
        frame(g);
        click(g, invArea(g, "invpage", 1));
        expect(g.inventoryPage).toBe(1);
        click(g, invArea(g, "invtab", "equip"));
        expect(g.inventoryTab).toBe("equip");
        expect(g.inventoryPage).toBe(0);
        expect(sent(g)).toEqual([]);
      }
    });

    it("slot and grid gestures still equip and unequip", () => {
      for (const kind of ["chest", "merchant"]) {
        const g = makeGame(kind);
        drag(g, invCell(g, 101), invSlot(g, "main_hand"));
        drag(g, invSlot(g, "main_hand"), emptyInvCell(g));
        expect(sent(g)).toEqual([["sendEquip", 101, "main_hand"], ["sendUnequip", "main_hand"]]);
      }
    });

    it("the click gestures still select, equip the selection and unequip", () => {
      const g = makeGame("chest");
      click(g, invCell(g, 101));
      expect(g.inventorySelectedItemId).toBe(101);
      click(g, invSlot(g, "main_hand"));
      expect(g.inventorySelectedItemId).toBeNull();
      click(g, invSlot(g, "main_hand"));
      expect(sent(g)).toEqual([["sendEquip", 101, "main_hand"], ["sendUnequip", "main_hand"]]);
    });

    it("a worn item's drop shows the unequip toast and sends nothing", () => {
      for (const kind of ["chest", "merchant"]) {
        const g = makeGame(kind);
        drag(g, invCell(g, 103), win(g).panel);
        expect(g._showToast).toHaveBeenCalledWith(REFUSE_WORN);
        expect(sent(g)).toEqual([]);
      }
    });

    it("an equipment slot dragged onto the window shows the unequip toast and sends nothing", () => {
      const g = makeGame("merchant");
      drag(g, invSlot(g, "main_hand"), win(g).panel);
      expect(g._showToast).toHaveBeenCalledWith(REFUSE_WORN);
      expect(sent(g)).toEqual([]);
    });

    it("Drop selected cannot be reached: no button, and nothing where the button would be", () => {
      for (const kind of ["chest", "merchant"]) {
        const g = makeGame(kind);
        click(g, invCell(g, 101));
        expect(g.inventorySelectedItemId).toBe(101);
        expect(invArea(g, "drop")).toBeUndefined();
        const shifted = layoutInventory({ inventory: g.inventory, selectedItemId: 101, originX: INVENTORY_X });
        click(g, shifted.hitAreas.find((a) => a.kind === "drop"));
        expect(sent(g)).toEqual([]);
      }
    });

    it("a selection made while paired does not follow the player into the normal inventory", () => {
      const g = makeGame("chest");
      click(g, invCell(g, 101));
      g._keydownHandler({ key: "Escape", code: "Escape", preventDefault() {} });
      expect(g.bankOpen).toBe(false);
      g.openInventory();
      frame(g);
      expect(invArea(g, "drop")).toBeUndefined();
    });
  });

  describe("gestures that must send nothing", () => {
    for (const kind of ["chest", "merchant"]) {
      const windowItem = kind === "chest" ? 21 : 5;

      it(`${kind}: a press with no travel on a window item sends nothing`, () => {
        const g = makeGame(kind);
        click(g, winCell(g, windowItem));
        expect(g.inventoryDrag).toBeNull();
        expect(sent(g)).toEqual([]);
      });

      it(`${kind}: a press that stays under the threshold, released over the inventory, sends nothing`, () => {
        const g = makeGame(kind);
        const c = winCell(g, windowItem);
        press(g, c);
        g._mouseMoveHandler(point(c.x + c.w / 2 + 2, c.y + c.h / 2 + 1));
        expect(g.inventoryDrag.armed).toBe(false);
        release(g, inv(g).panel);
        expect(sent(g)).toEqual([]);
      });

      it(`${kind}: a window item carried and released on its own window sends nothing`, () => {
        const g = makeGame(kind);
        const c = winCell(g, windowItem);
        press(g, c);
        g._mouseMoveHandler(point(c.x + c.w / 2 + 60, c.y + c.h / 2));
        expect(g.inventoryDrag.armed).toBe(true);
        release(g, win(g).panel);
        expect(g.inventoryDrag).toBeNull();
        expect(sent(g)).toEqual([]);
      });

      it(`${kind}: a drop outside both windows sends nothing, and never sendDrop`, () => {
        const g = makeGame(kind);
        drag(g, winCell(g, windowItem), OUTSIDE);
        drag(g, invCell(g, 101), OUTSIDE);
        drag(g, invSlot(g, "main_hand"), OUTSIDE);
        expect(sent(g)).toEqual([]);
      });

      it(`${kind}: a press on empty window space starts no drag and sends nothing`, () => {
        const g = makeGame(kind);
        const empty = win(g).cells.find((c) => !c.item);
        press(g, empty);
        expect(g.inventoryDrag).toBeNull();
        release(g, inv(g).panel);
        press(g, win(g).title);
        expect(g.inventoryDrag).toBeNull();
        release(g, inv(g).panel);
        expect(sent(g)).toEqual([]);
      });

      it(`${kind}: a click outside both windows neither swings the weapon nor clicks the world`, () => {
        const g = makeGame(kind);
        g.camera = { x: 0, y: 0, width: 1280, height: 720 };
        g.merchants = [{ x: 0, y: 0 }];
        g.banks = [{ x: 0, y: 0 }];
        click(g, OUTSIDE);
        expect(sent(g)).toEqual([]);
        expect(g._attackHeld).toBeFalsy();
        expect(g.inventoryDrag).toBeNull();
      });
    }

    it("an open window whose frame has not arrived still eats the click", () => {
      const g = makeGame();
      g.openShop();
      expect(g.shop).toBeNull();
      expect(g._pairedKind()).toBeNull();
      click(g, OUTSIDE);
      expect(sent(g)).toEqual([]);
      expect(g._attackHeld).toBeFalsy();
    });

    it("a press with the windows shut still attacks", () => {
      const g = makeGame();
      g._mouseDownHandler(point(100, 100));
      expect(sent(g).map((s) => s[0])).toEqual(["sendAttack"]);
      expect(g._attackHeld).toBe(true);
    });
  });

  describe("drag state", () => {
    it("a window drag carries what the overlay reads", () => {
      const g = makeGame("merchant");
      press(g, winCell(g, 5));
      expect(g.inventoryDrag).toMatchObject({
        itemId: null, typeId: 1, price: 95, from: { kind: "stockitem", id: 5 }, armed: false, pairedWith: "merchant",
      });
      moveTo(g, inv(g).panel);
      expect(g.inventoryDrag.armed).toBe(true);
    });

    it("a chest drag carries its type and the chest", () => {
      const g = makeGame("chest");
      press(g, winCell(g, 21));
      expect(g.inventoryDrag).toMatchObject({
        itemId: null, typeId: 2, from: { kind: "chestitem", id: 21 }, armed: false, pairedWith: "chest",
      });
    });

    it("an inventory drag started while paired carries its type and the window", () => {
      const g = makeGame("merchant");
      press(g, invCell(g, 102));
      expect(g.inventoryDrag).toMatchObject({ itemId: 102, typeId: 2, from: { kind: "item", id: 102 }, pairedWith: "merchant" });
      release(g, invCell(g, 102));
      press(g, invSlot(g, "main_hand"));
      expect(g.inventoryDrag).toMatchObject({ itemId: 103, typeId: 1, from: { kind: "slot", id: "main_hand" }, pairedWith: "merchant" });
    });

    it("an unpaired inventory drag has pairedWith null", () => {
      const g = makeGame();
      g.openInventory();
      frame(g);
      press(g, invCell(g, 101));
      expect(g.inventoryDrag.pairedWith).toBeNull();
    });

    it("the drag preview a frame draws is the action the release sends", () => {
      const g = makeGame("merchant");
      const draw = vi.spyOn(g.renderSystem, "renderPairedOverlay");
      press(g, invCell(g, 101));
      moveTo(g, win(g).panel);
      expect(draw).toHaveBeenCalled();
      expect(draw.mock.calls.at(-1)[1].drag).toBe(g.inventoryDrag);
      release(g, win(g).panel);
      expect(sent(g)).toEqual([["sendSell", 101]]);
    });
  });

  describe("close", () => {
    for (const kind of ["chest", "merchant"]) {
      for (const button of ["winclose", "invclose"]) {
        it(`${kind}: ${button} closes both windows`, () => {
          const g = makeGame(kind);
          click(g, button === "winclose" ? area(g, "winclose") : invArea(g, "invclose"));
          expect(g.shopOpen).toBe(false);
          expect(g.bankOpen).toBe(false);
          expect(g.inventoryOpen).toBe(false);
          expect(g.renderSystem._winHitAreas).toEqual([]);
          expect(g.renderSystem._invHitAreas).toEqual([]);
          expect(sent(g)).toEqual([]);
        });
      }
    }

    it("invclose on the normal inventory still closes it", () => {
      const g = makeGame();
      g.openInventory();
      frame(g);
      click(g, invArea(g, "invclose"));
      expect(g.inventoryOpen).toBe(false);
    });
  });

  describe("the window changes under a held button", () => {
    it("closing mid-drag makes the release do nothing", () => {
      for (const [kind, id] of [["chest", 21], ["merchant", 5]]) {
        const g = makeGame(kind);
        const target = inv(g).panel;
        press(g, winCell(g, id));
        moveTo(g, target);
        g._keydownHandler({ key: "Escape", code: "Escape", preventDefault() {} });
        release(g, target);
        expect(g.inventoryDrag).toBeNull();
        expect(sent(g)).toEqual([]);
      }
    });

    it("a drag begun on an inventory item sends nothing if the shop closes and the chest opens before release", () => {
      const g = makeGame("merchant");
      const target = win(g).panel;
      press(g, invCell(g, 101));
      moveTo(g, target);
      g.shopOpen = false;
      g.openBank(BANK_MSG);
      expect(g._pairedKind()).toBe("chest");
      release(g, target);
      expect(g.inventoryDrag).toBeNull();
      expect(sent(g)).toEqual([]);
    });

    it("a chest drag sends nothing if the merchant opened since the press", () => {
      // Flags set directly: openShop's first-open closeAllPanels would end the
      // drag on its own, and this is the guard behind that.
      const g = makeGame("chest");
      const target = inv(g).panel;
      press(g, winCell(g, 21));
      moveTo(g, target);
      g.bankOpen = false;
      g.shop = { ...SHOP_MSG };
      g.shopOpen = true;
      frame(g);
      expect(g.inventoryDrag).not.toBeNull();
      release(g, target);
      expect(sent(g)).toEqual([]);
    });

    it("an inventory drag sends nothing if the chest replaced the merchant by any route", () => {
      const g = makeGame("merchant");
      const target = win(g).panel;
      press(g, invCell(g, 101));
      moveTo(g, target);
      g.shopOpen = false;
      g.bank = { ...BANK_MSG };
      g.bankOpen = true;
      frame(g);
      expect(g.inventoryDrag).not.toBeNull();
      release(g, target);
      expect(sent(g)).toEqual([]);
    });

    it("closing and reopening the same window under a held button ends the drag", () => {
      const g = makeGame("merchant");
      const target = inv(g).panel;
      press(g, winCell(g, 5));
      moveTo(g, target);
      g.shopOpen = false;
      g.openShop(SHOP_MSG);
      frame(g);
      release(g, target);
      expect(sent(g)).toEqual([]);
    });

    it("a chest drag sends nothing if openShop ran since the press", () => {
      const g = makeGame("chest");
      const target = inv(g).panel;
      press(g, winCell(g, 21));
      moveTo(g, target);
      g.bankOpen = false;
      g.openShop(SHOP_MSG);
      release(g, target);
      expect(sent(g)).toEqual([]);
    });

    it("an unarmed inventory press does not click if the other window opened since the press", () => {
      const g = makeGame("merchant");
      const cell = invCell(g, 101);
      press(g, cell);
      g.shopOpen = false;
      g.bank = { ...BANK_MSG };
      g.bankOpen = true;
      frame(g);
      release(g, cell);
      expect(g.inventorySelectedItemId).toBeNull();
    });

    it("a paired drag does nothing if the normal inventory opened since the press", () => {
      const g = makeGame("merchant");
      const target = OUTSIDE;
      press(g, invCell(g, 101));
      moveTo(g, target);
      g.shopOpen = false;
      g.openInventory();
      frame(g);
      release(g, target);
      expect(sent(g)).toEqual([]);
    });

    it("an inventory drag that was unpaired does not resolve against a window that opened since", () => {
      const g = makeGame();
      g.openInventory();
      frame(g);
      press(g, invCell(g, 101));
      moveTo(g, OUTSIDE);
      g.inventoryOpen = false;
      g.openShop(SHOP_MSG);
      frame(g);
      release(g, win(g).panel);
      expect(sent(g)).toEqual([]);
    });

    it("an unpaired drag does not drop anything if the inventory is no longer drawn", () => {
      const g = makeGame();
      g.openInventory();
      frame(g);
      press(g, invCell(g, 101));
      moveTo(g, OUTSIDE);
      g.inventoryOpen = false; // past closeInventory, which would clear the drag itself
      // No frame yet: the last one's layout is still there to resolve against.
      release(g, OUTSIDE);
      expect(sent(g)).toEqual([]);
    });

    it("a release off the canvas ends a paired drag, so no later release can resolve it", () => {
      const g = makeGame("merchant");
      press(g, winCell(g, 5));
      moveTo(g, inv(g).panel);
      // The canvas never hears this one: only the window listener does.
      g._windowMouseUpHandler(point(4000, 4000));
      expect(g.inventoryDrag).toBeNull();
      release(g, inv(g).panel);
      expect(sent(g)).toEqual([]);
    });

    it("a press replaces a drag whose release was lost, so it cannot buy", () => {
      const g = makeGame("merchant");
      press(g, winCell(g, 5));
      moveTo(g, inv(g).panel);
      // The release went missing (alt-tab): the next click lands on the inventory.
      click(g, inv(g).title);
      expect(g.inventoryDrag).toBeNull();
      expect(sent(g)).toEqual([]);
    });
  });

  describe("other mouse buttons while paired", () => {
    it("a right press on a window item starts no drag and sends nothing", () => {
      const g = makeGame("merchant");
      const c = winCell(g, 5);
      g._mouseDownHandler({ ...centre(c), button: 2 });
      g._mouseUpHandler({ ...centre(c), button: 2 });
      expect(g.inventoryDrag).toBeNull();
      expect(sent(g)).toEqual([]);
    });

    it("a right release does not end a left drag", () => {
      const g = makeGame("merchant");
      press(g, winCell(g, 5));
      moveTo(g, inv(g).panel);
      g._mouseUpHandler({ ...centre(inv(g).panel), button: 2 });
      expect(g.inventoryDrag).not.toBeNull();
      expect(sent(g)).toEqual([]);
    });

    it("a hotbar skill bound to a mouse button stays blocked", () => {
      const g = makeGame("chest");
      g.keybinds = { slot1: "mouse2" };
      g._activateHotbarSkill = vi.fn();
      g._mouseDownHandler(point(100, 100, 2));
      expect(g._activateHotbarSkill).not.toHaveBeenCalled();
      expect(sent(g)).toEqual([]);
    });

    it("a mouse-bound interact still closes the shop, and a mouse-bound bank key closes the chest", () => {
      const shop = makeGame("merchant");
      shop.keybinds = { interact: "mouse3" };
      shop._mouseDownHandler(point(100, 100, 1));
      expect(shop.shopOpen).toBe(false);

      const chest = makeGame("chest");
      chest.keybinds = { bank: "mouse3" };
      chest._mouseDownHandler(point(100, 100, 1));
      expect(chest.bankOpen).toBe(false);
    });

    it("a mouse-bound pickup keeps working at the merchant and stays off at the chest", () => {
      const shop = makeGame("merchant");
      shop.keybinds = { pickup: "mouse3" };
      shop._mouseDownHandler(point(100, 100, 1));
      expect(shop.authorityClient.sendPickup).toHaveBeenCalled();

      const chest = makeGame("chest");
      chest.keybinds = { pickup: "mouse3" };
      chest._mouseDownHandler(point(100, 100, 1));
      expect(chest.authorityClient.sendPickup).not.toHaveBeenCalled();
    });
  });

  // The callbacks Game really hands the authority client, not a copy of them.
  describe("server frames", () => {
    async function joinedGame() {
      // The join's own side fetches (audio, art index) have no server here.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const g = new Game();
      setupState(g);
      const client = g.authorityClient;
      g.authorityClient = null;
      g.loadQuests = () => Promise.resolve();
      g._refreshProgressionBundle = () => {};
      g._preloadTileAssets = () => {};
      g.preloadSprites = () => {};
      g.imageManager.loadAll = () => new Promise(() => {}); // the join stops here
      const inventory = g.inventory;
      g.initChunked({ worldId: 1, characterId: 1, chunkSize: 16, tileTypes: {} }).catch(() => {});
      await vi.waitFor(() => expect(authority.opts).toBeTruthy());
      authority.opts.onJoined({ spawn: { x: 0, y: 0 } });
      g.inventory = inventory;
      g.authorityClient = client;
      g.gold = 500;
      g.renderSystem = realRenderSystem();
      return g;
    }
    const rejection = (serverMessage) => ({ isServerRejection: true, serverMessage });

    it("chest frames replace the list while paired, and the second one is the one drawn", async () => {
      const g = await joinedGame();
      authority.opts.onBank(BANK_MSG);
      frame(g);
      expect(winCell(g, 21)).toBeTruthy();
      authority.opts.onBank({ ...BANK_MSG, items: [{ id: 31, slot: 7, typeId: 1, quantity: 1 }] });
      frame(g);
      expect(g.bank.items.map((i) => i.id)).toEqual([31]);
      expect(winCell(g, 21)).toBeUndefined();
      expect(win(g).cells[7].item.id).toBe(31);
      expect(g.inventoryOpen).toBe(false);
      drag(g, winCell(g, 31), inv(g).panel);
      expect(sent(g)).toEqual([["sendWithdraw", 31]]);
    });

    it("shop frames replace the stock while paired, and keep the player's tab", async () => {
      const g = await joinedGame();
      authority.opts.onShop(SHOP_MSG);
      frame(g);
      click(g, area(g, "shoptab", "buyback"));
      authority.opts.onShop({ ...SHOP_MSG, buyback: [stock(88)] });
      frame(g);
      expect(g.shop.buyback.map((r) => r.id)).toEqual([88]);
      expect(g.shopView.tab).toBe("buyback");
      expect(winCell(g, 77)).toBeUndefined();
      expect(winCell(g, 88)).toBeTruthy();
      expect(g.inventoryOpen).toBe(false);
    });

    it("a frame arriving mid-drag does not end the drag", async () => {
      const g = await joinedGame();
      authority.opts.onBank(BANK_MSG);
      frame(g);
      const target = inv(g).panel;
      press(g, winCell(g, 22));
      moveTo(g, target);
      authority.opts.onBank({ ...BANK_MSG });
      frame(g);
      release(g, target);
      expect(sent(g)).toEqual([["sendWithdraw", 22]]);
    });

    it("a refresh frame keeps a selection and a press still in progress", async () => {
      const g = await joinedGame();
      authority.opts.onShop(SHOP_MSG);
      frame(g);
      click(g, invCell(g, 101));
      authority.opts.onShop(SHOP_MSG);
      expect(g.inventorySelectedItemId).toBe(101);
      press(g, invCell(g, 102));
      authority.opts.onShop(SHOP_MSG);
      expect(g.inventoryDrag).not.toBeNull();
    });

    it("two drags of one item send two messages, the server's error reaches a toast, and only frames change the list", async () => {
      const g = await joinedGame();
      authority.opts.onBank(BANK_MSG);
      frame(g);
      const before = g.inventory.items.map((i) => i.id);
      drag(g, invCell(g, 101), win(g).panel);
      expect(g.inventory.items.map((i) => i.id)).toEqual(before);
      expect(invCell(g, 101)).toBeTruthy();
      drag(g, invCell(g, 101), win(g).panel);
      expect(sent(g)).toEqual([["sendDeposit", 101], ["sendDeposit", 101]]);

      authority.opts.onError(rejection("item not found"));
      expect(g._showToast).toHaveBeenCalledWith("item not found");
      expect(g.inventory.items.map((i) => i.id)).toEqual(before);

      authority.opts.onDeposited({ itemId: 101 });
      frame(g);
      expect(invCell(g, 101)).toBeUndefined();
    });

    it("a 'no bank nearby' error frame shows a toast and leaves both lists unchanged", async () => {
      const g = await joinedGame();
      authority.opts.onBank(BANK_MSG);
      frame(g);
      const items = g.inventory.items.map((i) => i.id);
      const stored = g.bank.items.map((i) => i.id);
      drag(g, winCell(g, 21), inv(g).panel);
      authority.opts.onError(rejection("no bank nearby"));
      frame(g);
      expect(g._showToast).toHaveBeenCalledWith("no bank nearby");
      expect(g.inventory.items.map((i) => i.id)).toEqual(items);
      expect(g.bank.items.map((i) => i.id)).toEqual(stored);
      expect(g.bankOpen).toBe(true);
    });
  });
});
