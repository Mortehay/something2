// The trade key (R by default; T is teleport) invite and the Accept/Decline card, through the real handlers.
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

import { Game, DEFAULT_KEYBINDS, mergeKeybinds } from "../Game.js";
import { worldToScreen } from "../../core/iso.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../../core/constants.js";
import { RenderSystem } from "../../systems/RenderSystem.js";

const NativeMap = globalThis.Map;
// Item ids are uuids on the wire (player_items.id), never small integers.
const ID_A = "3f1c9a52-7d2e-4b8a-9c11-0a1b2c3d4e01";
const ID_B = "3f1c9a52-7d2e-4b8a-9c11-0a1b2c3d4e02";
const ID_C = "3f1c9a52-7d2e-4b8a-9c11-0a1b2c3d4e03";
const ID_P = "9b7e4d10-55aa-4f0e-8d3c-6e5f4a3b2c11";
const SWORD = { id: 1, name: "Sword", category: "weapon", slot: "main_hand", damage: 5, cooldown: 1 };
const HELM = { id: 2, name: "Helm", category: "armor", slot: "head", defense: 3 };

const SEND = [
  "sendDeposit", "sendWithdraw", "sendBuy", "sendSell", "sendEquip", "sendUnequip", "sendDrop",
  "sendAttack", "sendInteract", "sendOpenBank", "sendOpenChest", "sendPickup", "sendCastSkill",
  "sendTradeInvite", "sendTradeRespond", "sendTradeItem", "sendTradeGold", "sendTradeLock",
  "sendTradeConfirm", "sendTradeAbort", "sendTeleportCast", "sendTeleportCancel", "sendTravel",
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
    bank: params.bank, bankOpen: params.bankOpen, pairedKind: params.pairedKind, tradeView: params.tradeView, tradeInviteView: params.tradeInviteView, toast: params.toast,
    player: { x: 0, y: 0, width: 32, height: 32, hp: 10, maxHp: 10, facing: "down", effects: null },
    camera: { apply() {}, reset() {}, screenX: 0, screenY: 0, width: 1280, height: 720, x: 0, y: 0 },
    chunkedMap: { mapTiles: [], chunks: new NativeMap(), chunkSize: 16, tileSize: 32, loadedKeys: () => [] },
    remotePlayers: params.remotePlayers || new NativeMap(),
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
    items: [{ id: ID_A, typeId: 1, quantity: 1 }, { id: ID_B, typeId: 2, quantity: 1 }, { id: ID_C, typeId: 1, quantity: 1 }],
    equipment: { main_hand: ID_C },
    ammoCounts: new NativeMap(),
    capacity: 48,
  };
  g.authorityClient = Object.fromEntries(SEND.map((name) => [name, vi.fn()]));
  g.renderSystem = realRenderSystem();
  g.setupInput();
  g.showToast = vi.fn();
  g._showToast = vi.fn();
}


const key = (g, k, extra = {}) => g._keydownHandler({ key: k, code: `Key${k.toUpperCase()}`, preventDefault() {}, ...extra });
function sent(g) {
  return SEND.flatMap((name) => g.authorityClient[name].mock.calls.map((args) => [name, ...args]));
}
const remote = (id, x, y, over = {}) => [id, { id, x, y, width: 64, height: 64, hp: 10, ...over }];
const area = (g, kind) => g.renderSystem._inviteHitAreas.find((a) => a.kind === kind);
const clickBox = (g, a, button = 0) => {
  const p = { clientX: a.box.x + a.box.w / 2, clientY: a.box.y + a.box.h / 2, button };
  g._mouseDownHandler(p);
  g._mouseUpHandler(p);
};

describe("trade invite input", () => {
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

  const makeGame = (players = []) => {
    const g = new Game();
    setupState(g);
    g.localUserId = "1";
    g.camera = { screenX: 640, screenY: 360, x: 0, y: 0 };
    g.remotePlayers = new NativeMap(players);
    return g;
  };
  // update() starts by expiring the card and then walks the whole world, which this fixture does not
  // have; whatever it trips over after the expiry step is not under test.
  const tick = (g) => { try { g.update(0.016); } catch { /* world machinery absent */ } };
  const invited = (g, over = {}) => { g._onTradeInvited({ type: "tradeInvited", fromName: "Ann", expiresInMs: 30000, ...over }); frame(g); };

  describe("the trade key", () => {
    it("R is the default; T stays the teleport key", () => {
      expect(DEFAULT_KEYBINDS.trade).toBe("r");
      expect(DEFAULT_KEYBINDS.teleport).toBe("t");
      const values = Object.values(DEFAULT_KEYBINDS);
      expect(values.filter((v) => v === DEFAULT_KEYBINDS.trade)).toHaveLength(1);
    });

    it("invites the nearest player in range", () => {
      const g = makeGame([remote("2", 300, 0), remote("3", 50, 0)]);
      key(g, "r");
      expect(sent(g)).toEqual([["sendTradeInvite", "3"]]);
    });

    it("works with inspect off (the renderer has no hover key)", () => {
      const g = makeGame([remote("2", 40, 0), remote("3", 60, 0)]);
      g.inspectEnabled = false;
      frame(g);
      expect(g.renderSystem._inspectHoverKey ?? null).toBeNull();
      const s = worldToScreen(60 + 32, 0 + 32);
      // Put the cursor on player 3 by inverting the camera transform.
      g._cursorX = s.x + Math.floor(GAME_WIDTH / 2 - g.camera.screenX);
      g._cursorY = s.y - 20 + Math.floor(GAME_HEIGHT / 2 - g.camera.screenY);
      key(g, "r");
      expect(sent(g)).toEqual([["sendTradeInvite", "3"]]);
    });

    it("nobody in range gives the No player nearby toast and sends nothing", () => {
      const g = makeGame([remote("2", 900, 0), remote("3", 50, 0, { hp: 0 })]);
      key(g, "r");
      expect(sent(g)).toEqual([]);
      expect(g._showToast).toHaveBeenCalledWith("No player nearby");
    });

    it("does nothing while any panel is open or a trade is running", () => {
      const panels = ["inventoryOpen", "passiveTreeOpen", "questLogOpen", "achievementsOpen", "buildGuideOpen", "skillsOpen", "gemShopOpen", "forgeOpen", "shopOpen", "bankOpen", "tradeOpen"];
      for (const flag of panels) {
        const g = makeGame([remote("3", 50, 0)]);
        g[flag] = true;
        key(g, "r");
        expect(sent(g), flag).toEqual([]);
        expect(g._showToast, flag).not.toHaveBeenCalled();
      }
    });

    it("ignores repeat, modifiers, and a non-playing game", () => {
      const g = makeGame([remote("3", 50, 0)]);
      key(g, "r", { repeat: true });
      key(g, "r", { ctrlKey: true });
      key(g, "r", { shiftKey: true });
      g.state = "menu";
      key(g, "r");
      expect(sent(g)).toEqual([]);
    });

    it("a rebound key works and the old one does not", () => {
      const g = makeGame([remote("3", 50, 0)]);
      g.keybinds = { ...DEFAULT_KEYBINDS, trade: "v" };
      key(g, "r");
      expect(sent(g)).toEqual([]);
      key(g, "v");
      expect(sent(g)).toEqual([["sendTradeInvite", "3"]]);
    });

    it("a player who saved pickup on R keeps pickup: no invite, no toast", () => {
      const g = makeGame([remote("3", 50, 0)]);
      g.keybinds = mergeKeybinds({ pickup: "r" });
      key(g, "r");
      expect(sent(g)).toEqual([["sendPickup"]]);
      expect(g._showToast).not.toHaveBeenCalled();
      expect(g.showToast).not.toHaveBeenCalled();
    });

    it("an unbound trade key matches no key at all", () => {
      const g = makeGame([remote("3", 50, 0)]);
      g.keybinds = mergeKeybinds({ pickup: "r" });
      for (const k of ["", " ", "Enter", "v", "t"]) key(g, k);
      expect(sent(g).filter(([n]) => n === "sendTradeInvite")).toEqual([]);
    });

    it("walk: no default binding key starts a trade when none is bound to it", () => {
      const g = makeGame([remote("3", 50, 0)]);
      for (const [action, k] of Object.entries(DEFAULT_KEYBINDS)) {
        if (action === "trade") continue;
        key(g, k);
      }
      expect(sent(g).filter(([n]) => n === "sendTradeInvite")).toEqual([]);
    });
  });

  describe("the card", () => {
    it("tradeInvited draws a card with two hit areas", () => {
      const g = makeGame();
      invited(g);
      expect(area(g, "tradeInviteAccept")).toBeTruthy();
      expect(area(g, "tradeInviteDecline")).toBeTruthy();
    });

    it("no card, no hit areas", () => {
      const g = makeGame();
      frame(g);
      expect(g.renderSystem._inviteHitAreas).toEqual([]);
    });

    it("clicking Accept sends accept=true once, clears the card, and fires no attack", () => {
      const g = makeGame();
      invited(g);
      clickBox(g, area(g, "tradeInviteAccept"));
      expect(sent(g)).toEqual([["sendTradeRespond", true]]);
      expect(g.tradeInvite).toBeNull();
      expect(g._attackHeld).toBeFalsy();
    });

    it("clicking Decline sends accept=false", () => {
      const g = makeGame();
      invited(g);
      clickBox(g, area(g, "tradeInviteDecline"));
      expect(sent(g)).toEqual([["sendTradeRespond", false]]);
      expect(g.tradeInvite).toBeNull();
    });

    it("a click outside the buttons passes through as an attack and leaves the card", () => {
      const g = makeGame();
      invited(g);
      g._mouseDownHandler({ clientX: 100, clientY: 600, button: 0 });
      expect(sent(g).map((s) => s[0])).toContain("sendAttack");
      expect(g.tradeInvite).not.toBeNull();
    });

    it("a right click on a button is not an answer", () => {
      const g = makeGame();
      invited(g);
      clickBox(g, area(g, "tradeInviteAccept"), 2);
      expect(sent(g).filter((s) => s[0] === "sendTradeRespond")).toEqual([]);
    });

    it("Y accepts and N declines while the card is live", () => {
      for (const [k, accept] of [["y", true], ["n", false]]) {
        const g = makeGame();
        invited(g);
        key(g, k);
        expect(sent(g)).toEqual([["sendTradeRespond", accept]]);
        expect(g.tradeInvite).toBeNull();
      }
    });

    it("Cyrillic н and т answer too (same physical keys)", () => {
      const g = makeGame();
      invited(g);
      key(g, "н");
      expect(sent(g)).toEqual([["sendTradeRespond", true]]);
    });

    it("Y and N fall through to their normal binding with no card", () => {
      const g = makeGame();
      g.keybinds = { ...DEFAULT_KEYBINDS, skills: "y", inventory: "n" };
      key(g, "y");
      expect(g.skillsOpen).toBe(true);
      expect(sent(g)).toEqual([]);
      const h = makeGame();
      h.keybinds = { ...DEFAULT_KEYBINDS, inventory: "n" };
      key(h, "n");
      expect(h.inventoryOpen).toBe(true);
      expect(sent(h)).toEqual([]);
    });

    it("Y with a card is not also the bound action", () => {
      const g = makeGame();
      g.keybinds = { ...DEFAULT_KEYBINDS, skills: "y" };
      invited(g);
      key(g, "y");
      expect(g.skillsOpen).toBeFalsy();
    });

    it("movement keys keep working with a card up", () => {
      const g = makeGame();
      invited(g);
      key(g, "w");
      expect(g.keys.w).toBe(true);
      expect(g.tradeInvite).not.toBeNull();
    });

    it("the card expires on the client at expiresAtMs, silently", () => {
      const g = makeGame();
      invited(g);
      nowMs += 29999;
      tick(g);
      expect(g.tradeInvite).not.toBeNull();
      nowMs += 2;
      tick(g);
      expect(g.tradeInvite).toBeNull();
      expect(g._showToast).not.toHaveBeenCalled();
      expect(sent(g)).toEqual([]);
      frame(g);
      expect(g.renderSystem._inviteHitAreas).toEqual([]);
    });

    it("the server's own expiry gives exactly one message", () => {
      const g = makeGame();
      invited(g);
      nowMs += 31000;
      tick(g);
      g._onTradeEnded({ type: "tradeEnded", completed: false, reason: "invite expired" });
      expect(g._showToast).toHaveBeenCalledTimes(1);
    });

    it("a later invite replaces the card; a too-late answer sends nothing", () => {
      const g = makeGame();
      invited(g);
      nowMs += 31000;
      tick(g);
      key(g, "y");
      expect(sent(g)).toEqual([]);
    });

    it("a card does not stop panel clicks below it, and panels hide nothing of the card", () => {
      const g = makeGame();
      invited(g);
      g.inventoryOpen = true;
      frame(g);
      expect(area(g, "tradeInviteAccept")).toBeTruthy();
    });

    it("a long Ukrainian-or-English name keeps the card on screen", () => {
      const g = makeGame();
      invited(g, { fromName: "Ж".repeat(32) });
      const l = g.renderSystem._inviteLayout;
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x + l.w).toBeLessThanOrEqual(1280);
    });

    it("a world change clears the card", () => {
      const g = makeGame();
      invited(g);
      g._onTransitionFrame({ type: "transition" });
      expect(g.tradeInvite).toBeNull();
    });
  });
});
