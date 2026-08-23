import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Game } from '../Game.js';
import { worldToScreen } from '../iso.js';
import { GAME_WIDTH, GAME_HEIGHT } from '../constants.js';

// SOMET-471. The village merchant post and the account-chest (bank) post sit
// exactly ONE TILE apart -- backend/src/services/mapService.js villageBankPost
// derives the bank by offsetting the merchant by one tile -- and the authority
// resolves them with two SEPARATE proximity picks for that reason (see
// nearestBankVillage's header in backend/src/authority/server.js).
//
// So a client that decides WHICH KIND of interactable a key means, by picking
// the nearest one, makes the loser unreachable: at the entry village's spawn
// point the bank post is nearer than the merchant, so "nearest wins" ate every
// merchant press and the shop could not be opened at all. Each key must carry
// ONE intent and let the authority decide whether anything is in range.
//
// Coordinates below are the live entry village (Vale Crossing): merchant
// (4750,4650), bank (4750,4550), village spawn (4650,4550).
const MERCHANT = { villageId: 'v1', x: 4750, y: 4650 };
const BANK = { villageId: 'v1', x: 4750, y: 4550 };

describe('Game interact keys', () => {
  let originalWindow;

  beforeEach(() => {
    originalWindow = globalThis.window;
    globalThis.window = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  // Places the player so their CENTRE is at (cx, cy); Player is 64x64 and every
  // proximity rule on both sides of the wire measures from the centre.
  function makeGame({ cx = 4682, cy = 4582 } = {}) {
    const g = new Game();
    g.canvas = {
      addEventListener: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: GAME_WIDTH, height: GAME_HEIGHT }),
      width: GAME_WIDTH,
      height: GAME_HEIGHT,
    };
    g.state = 'playing';
    g.chunked = true;
    g.player.x = cx - g.player.width / 2;
    g.player.y = cy - g.player.height / 2;
    g.merchants = [MERCHANT];
    g.banks = [BANK];
    g.worldChests = [];
    g.authorityClient = {
      sendInteract: vi.fn(),
      sendOpenBank: vi.fn(),
      sendOpenChest: vi.fn(),
      sendAttack: vi.fn(),
      sendPickup: vi.fn(),
    };
    // Camera centred on the player, as Camera.follow leaves it.
    const s = worldToScreen(cx, cy);
    g.camera = { screenX: s.x, screenY: s.y };
    g.setupInput();
    return g;
  }

  // Canvas pixel that lands on a world point, inverting cursorToWorld.
  function canvasPointFor(g, wx, wy) {
    const s = worldToScreen(wx, wy);
    return {
      clientX: s.x - g.camera.screenX + GAME_WIDTH / 2,
      clientY: s.y - g.camera.screenY + GAME_HEIGHT / 2,
    };
  }

  it("'e' asks the authority for the merchant even when the bank post is nearer", () => {
    // Village spawn: 82px from the bank post, 113px from the merchant. Both are
    // inside the authority's INTERACT_RADIUS of 120, so the shop MUST be
    // reachable from here.
    const g = makeGame({ cx: 4682, cy: 4582 });

    g._keydownHandler({ key: 'e', code: 'KeyE' });

    expect(g.authorityClient.sendInteract).toHaveBeenCalledTimes(1);
    expect(g.authorityClient.sendOpenBank).not.toHaveBeenCalled();
  });

  it("'b' asks the authority for the bank even when the merchant post is nearer", () => {
    // Standing on the merchant post: 0px from it, 100px from the bank.
    const g = makeGame({ cx: 4750, cy: 4650 });

    g._keydownHandler({ key: 'b', code: 'KeyB' });

    expect(g.authorityClient.sendOpenBank).toHaveBeenCalledTimes(1);
    expect(g.authorityClient.sendInteract).not.toHaveBeenCalled();
  });

  it("'f' asks the authority for a world chest even inside a village", () => {
    // A field chest and a village overlap constantly; 'f' must not be eaten by
    // whichever village post happens to be closer.
    const g = makeGame({ cx: 4682, cy: 4582 });

    g._keydownHandler({ key: 'f', code: 'KeyF' });

    expect(g.authorityClient.sendOpenChest).toHaveBeenCalledTimes(1);
    expect(g.authorityClient.sendOpenBank).not.toHaveBeenCalled();
    expect(g.authorityClient.sendInteract).not.toHaveBeenCalled();
  });

  it('closes its own panel rather than re-asking when the panel is open', () => {
    const g = makeGame();
    g.shopOpen = true;
    g._keydownHandler({ key: 'e', code: 'KeyE' });
    expect(g.shopOpen).toBe(false);
    expect(g.authorityClient.sendInteract).not.toHaveBeenCalled();

    const g2 = makeGame();
    g2.bankOpen = true;
    g2._keydownHandler({ key: 'b', code: 'KeyB' });
    expect(g2.bankOpen).toBe(false);
    expect(g2.authorityClient.sendOpenBank).not.toHaveBeenCalled();
  });

  it('a click on the merchant marker opens the shop, not the nearer bank', () => {
    const g = makeGame({ cx: 4700, cy: 4600 });
    const pt = canvasPointFor(g, MERCHANT.x, MERCHANT.y);

    g._mouseDownHandler({ button: 0, ...pt });

    expect(g.authorityClient.sendInteract).toHaveBeenCalledTimes(1);
    expect(g.authorityClient.sendOpenBank).not.toHaveBeenCalled();
    expect(g.authorityClient.sendAttack).not.toHaveBeenCalled();
  });

  it('a click on the bank marker opens the account chest', () => {
    const g = makeGame({ cx: 4700, cy: 4600 });
    const pt = canvasPointFor(g, BANK.x, BANK.y);

    g._mouseDownHandler({ button: 0, ...pt });

    expect(g.authorityClient.sendOpenBank).toHaveBeenCalledTimes(1);
    expect(g.authorityClient.sendInteract).not.toHaveBeenCalled();
    expect(g.authorityClient.sendAttack).not.toHaveBeenCalled();
  });

  it('a click on empty ground still attacks', () => {
    const g = makeGame({ cx: 4700, cy: 4600 });
    const pt = canvasPointFor(g, 5200, 4600);

    g._mouseDownHandler({ button: 0, ...pt });

    expect(g.authorityClient.sendAttack).toHaveBeenCalledTimes(1);
    expect(g.authorityClient.sendInteract).not.toHaveBeenCalled();
    expect(g.authorityClient.sendOpenBank).not.toHaveBeenCalled();
  });

  it('a click on a marker the player is too far from attacks instead of interacting', () => {
    // Out of range of both posts: the click must not be swallowed by a marker
    // the authority would refuse anyway.
    const g = makeGame({ cx: 4750, cy: 5200 });
    const pt = canvasPointFor(g, MERCHANT.x, MERCHANT.y);

    g._mouseDownHandler({ button: 0, ...pt });

    expect(g.authorityClient.sendInteract).not.toHaveBeenCalled();
    expect(g.authorityClient.sendAttack).toHaveBeenCalledTimes(1);
  });
});
