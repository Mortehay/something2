// The player-to-player trade window, driven through the real mouse and keyboard
// handlers against hit areas a real RenderSystem frame published.
// Everything goes through the real _mouseDownHandler, _mouseMoveHandler and
// _mouseUpHandler, against hit areas a real RenderSystem frame published from
// Game's own render params. Mistakes here cost players items or gold, so the
// send spies are asserted exactly, including "nothing at all".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

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

const NativeMap = globalThis.Map;
const SWORD = { id: 1, name: "Sword", category: "weapon", slot: "main_hand", damage: 5, cooldown: 1 };
const HELM = { id: 2, name: "Helm", category: "armor", slot: "head", defense: 3 };

const SEND = [
  "sendDeposit", "sendWithdraw", "sendBuy", "sendSell", "sendEquip", "sendUnequip", "sendDrop",
  "sendAttack", "sendInteract", "sendOpenBank", "sendOpenChest", "sendPickup", "sendCastSkill",
  "sendTradeInvite", "sendTradeRespond", "sendTradeItem", "sendTradeGold", "sendTradeLock",
  "sendTradeConfirm", "sendTradeAbort", "sendTeleportCast",
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
    bank: params.bank, bankOpen: params.bankOpen, pairedKind: params.pairedKind, tradeView: params.tradeView,
    player: { x: 0, y: 0, width: 32, height: 32, hp: 10, maxHp: 10, facing: "down", effects: null },
    camera: { apply() {}, reset() {}, screenX: 0, screenY: 0, width: 1280, height: 720, x: 0, y: 0 },
    chunkedMap: { mapTiles: [], chunks: new NativeMap(), chunkSize: 16, tileSize: 32, loadedKeys: () => [] },
    remotePlayers: new NativeMap(),
    localUserId: 1,
  });
  return rs;
}

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
const key = (g, k) => g._keydownHandler({ key: k, code: `Key${k.toUpperCase()}`, preventDefault() {} });
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function sent(g) {
  return SEND.flatMap((name) => g.authorityClient[name].mock.calls.map((args) => [name, ...args]));
}


const PARTNER_RING = { id: 9, name: "Ring", category: "armor", slot: "ring" };
const side = (items = [], over = {}) => ({ items, gold: 0, locked: false, confirmed: false, ...over });
const offered = (id, over = {}) => ({ id, typeId: 1, quantity: 1, soulbound: false, rarity: "white", type: SWORD, ...over });
const tradeMsg = (over = {}) => ({
  type: "tradeState", partnerName: "Bob", phase: "open", mine: side(), theirs: side(), confirmOpensInMs: null, ...over,
});

function makeGame(msg = tradeMsg()) {
  const g = new Game();
  setupState(g);
  if (msg) g._onTradeState(msg);
  frame(g);
  return g;
}

const hitOf = (g, kind) => g.renderSystem._winHitAreas.find((a) => a.kind === kind);
const sentOf = (g, names) => names.flatMap((n) => g.authorityClient[n].mock.calls.map((a) => [n, ...a]));

describe("trade window input", () => {
  let originalWindow;
  let nowMs;
  beforeEach(() => {
    originalWindow = globalThis.window;
    globalThis.window = {
      addEventListener: vi.fn(), removeEventListener: vi.fn(), innerWidth: 1280, innerHeight: 720,
      location: { protocol: "http:", host: "localhost", hostname: "localhost" },
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    nowMs = 10000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  });
  afterEach(() => { globalThis.window = originalWindow; vi.restoreAllMocks(); });

  describe("opening and closing", () => {
    it("the first tradeState opens a paired trade window; inventoryOpen stays false", () => {
      const g = makeGame();
      expect(g.tradeOpen).toBe(true);
      expect(g._pairedKind()).toBe("trade");
      expect(g.isPairedWindowOpen()).toBe(true);
      expect(g.inventoryOpen).toBe(false);
      expect(g._inventoryVisible()).toBe(true);
      expect(win(g).kind).toBe("trade");
      expect(inv(g)).toBeTruthy();
    });

    it("another window cannot open over a trade, and a refresh frame still lands", () => {
      const g = makeGame();
      expect(g._otherPanelOpen("bank")).toBe(true);
      g.openShop({ villageId: 1, catalog: [], buyback: [] });
      g.openBank({ villageId: 1, items: [], capacity: 40 });
      expect(g.shopOpen).toBe(false);
      expect(g.bankOpen).toBe(false);
      g._onTradeState(tradeMsg({ mine: side([offered(101)]) }));
      expect(g.trade.mine.items).toHaveLength(1);
    });

    it("a tradeState closes the windows that were open", () => {
      const g = makeGame(null);
      g.openBank({ villageId: 1, items: [], capacity: 40 });
      g.skillsOpen = true;
      g._onTradeState(tradeMsg());
      expect(g.bankOpen).toBe(false);
      expect(g.skillsOpen).toBe(false);
      expect(g._pairedKind()).toBe("trade");
      expect(sentOf(g, SEND)).toEqual([]);
    });

    it("each way of closing the window cancels the trade, once", () => {
      const ways = {
        "window X": (g) => click(g, hitOf(g, "winclose")),
        "Cancel button": (g) => click(g, hitOf(g, "tradeabort")),
        "inventory X": (g) => click(g, g.renderSystem._invHitAreas.find((a) => a.kind === "invclose")),
        Escape: (g) => g._keydownHandler({ key: "Escape", code: "Escape", preventDefault() {} }),
      };
      for (const [name, close] of Object.entries(ways)) {
        const g = makeGame();
        close(g);
        expect(g.tradeOpen, name).toBe(false);
        expect(g._pairedKind(), name).toBeNull();
        expect(sentOf(g, SEND), name).toEqual([["sendTradeAbort"]]);
      }
    });

    it("closeAllPanels for another window cancels the trade", () => {
      const g = makeGame();
      g.closeAllPanels("skills");
      expect(sentOf(g, SEND)).toEqual([["sendTradeAbort"]]);
    });

    it("a late tradeState does not reopen a window the player closed; tradeEnded clears that", () => {
      const g = makeGame();
      click(g, hitOf(g, "winclose"));
      g._onTradeState(tradeMsg({ mine: side([offered(101)]) }));
      expect(g.tradeOpen).toBe(false);
      expect(g._pairedKind()).toBeNull();
      g._onTradeEnded({ completed: false, reason: "you cancelled the trade", removedItemIds: [], addedItems: [], gold: null });
      g._onTradeState(tradeMsg());
      expect(g.tradeOpen).toBe(true);
    });

    it("the X while settling does not send an abort the server would refuse", () => {
      const g = makeGame(tradeMsg({ phase: "settling", mine: side([], { locked: true, confirmed: true }), theirs: side([], { locked: true, confirmed: true }) }));
      click(g, hitOf(g, "winclose"));
      expect(sentOf(g, SEND)).toEqual([]);
      expect(g.tradeOpen).toBe(true);
    });

    it("a world change forgets the session", () => {
      const g = makeGame();
      g._resetTrade();
      expect(g.tradeOpen).toBe(false);
      expect(g.trade).toBeNull();
    });
  });

  describe("stash edits", () => {
    it("dragging a bag item onto the window offers it; dragging it back takes it back", () => {
      const g = makeGame();
      drag(g, invCell(g, 101), win(g).panel);
      expect(sentOf(g, SEND)).toEqual([["sendTradeItem", 101, true]]);
      g._onTradeState(tradeMsg({ mine: side([offered(101)]) }));
      frame(g);
      const cell = win(g).myCells[0];
      expect(cell.item.id).toBe(101);
      drag(g, cell, inv(g).panel);
      expect(sentOf(g, SEND)).toEqual([["sendTradeItem", 101, true], ["sendTradeItem", 101, false]]);
    });

    it("a worn item is refused with a toast and nothing is sent", () => {
      const g = makeGame();
      drag(g, invCell(g, 101), win(g).panel);
      sentOf(g, SEND);
      g.authorityClient.sendTradeItem.mockClear();
      g.inventory.equipment = { main_hand: 101 };
      frame(g);
      drag(g, invCell(g, 101), win(g).panel);
      expect(sentOf(g, SEND)).toEqual([]);
      expect(g._showToast).toHaveBeenCalledWith("unequip it first");
    });

    it("an item already offered is not offered a second time", () => {
      const g = makeGame(tradeMsg({ mine: side([offered(101)]) }));
      drag(g, invCell(g, 101), win(g).panel);
      expect(sentOf(g, SEND)).toEqual([]);
    });

    it("nothing can be dragged once my side is locked", () => {
      const g = makeGame(tradeMsg({ mine: side([offered(101)], { locked: true }) }));
      drag(g, invCell(g, 102), win(g).panel);
      drag(g, win(g).myCells[0], inv(g).panel);
      expect(sentOf(g, SEND)).toEqual([]);
    });

    it("the partner's items cannot be picked up", () => {
      const g = makeGame(tradeMsg({ theirs: side([offered(900, { typeId: 9, type: PARTNER_RING })]) }));
      drag(g, win(g).theirCells[0], inv(g).panel);
      expect(sentOf(g, SEND)).toEqual([]);
      expect(win(g).theirCells[0].type).toBe(PARTNER_RING);
      expect(g.inventory.types.has(9)).toBe(false);
    });

    it("equipping and unequipping are not sent during a trade", () => {
      const g = makeGame();
      drag(g, invCell(g, 102), invSlot(g, "head"));
      drag(g, invSlot(g, "main_hand"), emptyInvCell(g));
      click(g, invCell(g, 102));
      click(g, invSlot(g, "head"));
      click(g, invSlot(g, "main_hand"));
      expect(sentOf(g, SEND)).toEqual([]);
    });

    it("a drag whose release is lost never resolves on a later release", () => {
      const g = makeGame();
      press(g, invCell(g, 101));
      moveTo(g, win(g).panel);
      g._windowMouseUpHandler({ button: 0 });
      expect(g.inventoryDrag).toBeNull();
      g._mouseUpHandler(centre(win(g).panel));
      expect(sentOf(g, SEND)).toEqual([]);
    });
  });

  describe("the OK button", () => {
    it("walks lock, then confirm once the delay has passed", () => {
      const g = makeGame(tradeMsg({ mine: side([offered(101)]) }));
      click(g, hitOf(g, "tradeok"));
      expect(sentOf(g, SEND)).toEqual([["sendTradeLock"]]);

      g._onTradeState(tradeMsg({ phase: "both_locked", mine: side([offered(101)], { locked: true }), theirs: side([], { locked: true }), confirmOpensInMs: 1500 }));
      frame(g);
      expect(win(g).button).toEqual({ label: "Confirm", enabled: false });
      click(g, hitOf(g, "tradeok"));
      expect(sentOf(g, ["sendTradeConfirm"])).toEqual([]);

      nowMs += 1500;
      frame(g);
      expect(win(g).button).toEqual({ label: "Confirm", enabled: true });
      click(g, hitOf(g, "tradeok"));
      expect(sentOf(g, ["sendTradeConfirm"])).toEqual([["sendTradeConfirm"]]);
    });

    it("a disabled button sends nothing", () => {
      const g = makeGame(tradeMsg({ mine: side([], { locked: true }) }));
      expect(win(g).button.enabled).toBe(false);
      click(g, hitOf(g, "tradeok"));
      expect(sentOf(g, SEND)).toEqual([]);
    });
  });

  describe("the gold field", () => {
    const focusGold = (g) => click(g, hitOf(g, "tradegold"));

    it("owns the keyboard while focused: digits never reach hotbar skills", () => {
      const g = makeGame();
      focusGold(g);
      expect(g.tradeGoldField.focused).toBe(true);
      for (const k of ["1", "2", "5"]) key(g, k);
      expect(g.tradeGoldField.text).toBe("125");
      expect(g.keys["1"]).toBeFalsy();
      key(g, "Backspace");
      expect(g.tradeGoldField.text).toBe("12");
      key(g, "w");
      expect(g.tradeGoldField.text).toBe("12");
      expect(g.keys.w).toBeFalsy();
      expect(sentOf(g, SEND)).toEqual([]);
    });

    it("Enter commits the amount and leaves the field", () => {
      const g = makeGame();
      focusGold(g);
      key(g, "7"); key(g, "5"); key(g, "Enter");
      expect(sentOf(g, SEND)).toEqual([["sendTradeGold", 75]]);
      expect(g.tradeGoldField.focused).toBe(false);
    });

    it("Escape only leaves the field: no gold sent, trade not cancelled", () => {
      const g = makeGame();
      focusGold(g);
      key(g, "7");
      g._keydownHandler({ key: "Escape", code: "Escape", preventDefault() {} });
      expect(g.tradeGoldField.focused).toBe(false);
      expect(g.tradeOpen).toBe(true);
      expect(sentOf(g, SEND)).toEqual([]);
    });

    it("clicking elsewhere commits; an unchanged amount sends nothing", () => {
      const g = makeGame();
      focusGold(g);
      key(g, "4"); key(g, "2");
      click(g, win(g).title);
      expect(sentOf(g, SEND)).toEqual([["sendTradeGold", 42]]);
      const same = makeGame(tradeMsg({ mine: side([], { gold: 30 }) }));
      focusGold(same);
      expect(same.tradeGoldField.text).toBe("30");
      click(same, same.renderSystem._winLayout.title);
      expect(sentOf(same, SEND)).toEqual([]);
    });

    it("an empty field commits 0", () => {
      const g = makeGame(tradeMsg({ mine: side([], { gold: 30 }) }));
      focusGold(g);
      key(g, "Backspace"); key(g, "Backspace"); key(g, "Enter");
      expect(sentOf(g, SEND)).toEqual([["sendTradeGold", 0]]);
    });

    it("a state frame does not overwrite what is being typed", () => {
      const g = makeGame();
      focusGold(g);
      key(g, "9");
      g._onTradeState(tradeMsg({ theirs: side([], { gold: 5 }) }));
      frame(g);
      expect(win(g).goldText).toBe("9");
    });

    it("locking my side drops focus; the field is not clickable while locked", () => {
      const g = makeGame();
      focusGold(g);
      g._onTradeState(tradeMsg({ mine: side([], { locked: true }) }));
      expect(g.tradeGoldField.focused).toBe(false);
      frame(g);
      expect(hitOf(g, "tradegold")).toBeUndefined();
    });
  });

  describe("frozen actions", () => {
    it("E, F, G, B and T send nothing while a trade is open", () => {
      const g = makeGame();
      for (const k of ["e", "f", "g", "b", "t"]) g._keydownHandler({ key: k, code: `Key${k.toUpperCase()}`, preventDefault() {} });
      expect(sentOf(g, SEND)).toEqual([]);
    });

    it("a click on the world sends no attack and opens nothing", () => {
      const g = makeGame();
      g._mouseDownHandler({ clientX: 900, clientY: 650, button: 0 });
      expect(sentOf(g, SEND)).toEqual([]);
    });
  });

  describe("invite and end of session", () => {
    it("tradeInvited stores the invitation; the first tradeState clears it", () => {
      const g = makeGame(null);
      g._onTradeInvited({ fromName: "Ann", expiresInMs: 30000 });
      expect(g.tradeInvite).toMatchObject({ fromName: "Ann", expiresInMs: 30000, expiresAtMs: nowMs + 30000 });
      g._onTradeState(tradeMsg());
      expect(g.tradeInvite).toBeNull();
    });

    it("an invite outcome arrives as tradeEnded and clears the invitation", () => {
      const g = makeGame(null);
      g._onTradeInvited({ fromName: "Ann", expiresInMs: 30000 });
      g._onTradeEnded({ completed: false, reason: "invite expired", removedItemIds: [], addedItems: [], gold: null });
      expect(g.tradeInvite).toBeNull();
      expect(g._showToast).toHaveBeenCalledWith("invite expired");
    });

    it("a declined invite with no reason shows no toast", () => {
      const g = makeGame(null);
      g._onTradeEnded({ completed: false, reason: null, removedItemIds: [], addedItems: [], gold: null });
      expect(g._showToast).not.toHaveBeenCalled();
    });

    it("a completed trade updates the bag and wallet, even though the window was closed", () => {
      const g = makeGame(tradeMsg({ mine: side([offered(101)]), theirs: side([offered(900, { typeId: 9, type: PARTNER_RING })]) }));
      click(g, hitOf(g, "winclose"));
      g._onTradeEnded({
        completed: true, reason: null, removedItemIds: [101],
        addedItems: [{ id: 900, typeId: 9, quantity: 1, soulbound: false, rarity: "white", itemLevel: 1, enchantLevel: 0, affixes: [] }],
        gold: 777,
      });
      expect(g.inventory.items.map((i) => i.id).sort()).toEqual([102, 103, 900]);
      expect(g.inventory.types.get(9)).toBe(PARTNER_RING);
      expect(g.gold).toBe(777);
      expect(g._showToast).toHaveBeenCalledWith("Trade complete");
      expect(g.tradeOpen).toBe(false);
      expect(g._tradeDismissed).toBe(false);
    });

    it("a trade that did not complete leaves the bag and wallet alone", () => {
      const g = makeGame();
      g._onTradeEnded({ completed: false, reason: "Bob left", removedItemIds: [], addedItems: [], gold: null });
      expect(g.inventory.items).toHaveLength(3);
      expect(g.gold).toBe(500);
      expect(g._showToast).toHaveBeenCalledWith("Bob left");
      expect(g.tradeOpen).toBe(false);
    });

    it("tradeEnded before the world is entered does not throw", () => {
      const g = new Game();
      expect(() => g._onTradeEnded({ completed: true, reason: null, removedItemIds: [], addedItems: [], gold: 5 })).not.toThrow();
    });

    it("flashes the partner's stash for one second after they change it", () => {
      const g = makeGame();
      expect(win(g).theirFlash).toBe(false);
      g._onTradeState(tradeMsg({ theirs: side([offered(900)]) }));
      frame(g);
      expect(win(g).theirFlash).toBe(true);
      nowMs += 1001;
      frame(g);
      expect(win(g).theirFlash).toBe(false);
      g._onTradeState(tradeMsg({ theirs: side([offered(900)], { locked: true }) }));
      frame(g);
      expect(win(g).theirFlash).toBe(false);
    });
  });

  describe("source gates", () => {
    const text = readFileSync(new URL("../Game.js", import.meta.url), "utf8");
    const body = (name) => {
      const i = text.indexOf(`    ${name}(`);
      expect(i, name).toBeGreaterThan(-1);
      return text.slice(i, text.indexOf("\n    }\n", i));
    };
    it("every way out of the trade window goes through _abortTrade, which sends tradeAbort", () => {
      expect(body("_abortTrade")).toContain("sendTradeAbort()");
      expect(body("_closePairedWindows")).toContain("this._abortTrade()");
      expect(body("closeAllPanels")).toContain("this._abortTrade()");
      expect(text).toMatch(/hit\.kind === 'tradeabort'\) \{ this\._abortTrade\(\)/);
      expect(text).toMatch(/hit\.kind === 'winclose'\) \{ this\._closePairedWindows\(\)/);
      expect(text).toMatch(/else if \(this\.tradeOpen\) \{\s+this\._abortTrade\(\)/);
    });
    it("_otherPanelOpen covers tradeOpen and the wire callbacks are wired", () => {
      expect(body("_otherPanelOpen")).toContain("this.tradeOpen");
      for (const n of ["Invited", "State", "Ended"]) expect(text).toContain(`onTrade${n}: (msg) => this._onTrade${n}(msg)`);
    });
    it("the gold field is consulted before any hotkey", () => {
      const iField = text.indexOf("this._tradeFieldKey(e)");
      expect(iField).toBeGreaterThan(-1);
      expect(iField).toBeLessThan(text.indexOf("const isKey = (target)"));
    });
  });
});
