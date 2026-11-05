// The T-key invite flow: who a trade invite goes to, and the Accept/Decline card.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { pickTradeTarget, hoverPlayerKey, layoutInviteCard, drawInviteCard } from "../tradeInvite.js";
import { setLang } from "../../i18n/i18n.js";
import { UK } from "../../i18n/uk/index.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../../core/constants.js";
import { worldToScreen } from "../../core/iso.js";

const NativeMap = globalThis.Map;
const me = { x: 0, y: 0, width: 64, height: 64 };
const players = (...list) => new NativeMap(list.map((p) => [p.id, { width: 64, height: 64, hp: 10, ...p }]));

describe("pickTradeTarget", () => {
  it("cursor target wins over a nearer player", () => {
    const remotePlayers = players({ id: "near", x: 10, y: 0 }, { id: "far", x: 80, y: 0 });
    expect(pickTradeTarget({ me, remotePlayers, hoverKey: "p:far" })).toBe("far");
  });

  it("cursor target out of range falls to nearest in range", () => {
    const remotePlayers = players({ id: "near", x: 40, y: 0 }, { id: "mid", x: 90, y: 0 }, { id: "gone", x: 900, y: 0 });
    expect(pickTradeTarget({ me, remotePlayers, hoverKey: "p:gone" })).toBe("near");
  });

  it("nobody in range is null", () => {
    expect(pickTradeTarget({ me, remotePlayers: players({ id: "a", x: 500, y: 0 }), hoverKey: null })).toBeNull();
    expect(pickTradeTarget({ me, remotePlayers: players(), hoverKey: null })).toBeNull();
    expect(pickTradeTarget({ me: null, remotePlayers: players({ id: "a", x: 1, y: 1 }) })).toBeNull();
  });

  it("a dead remote is skipped, as hover target and as nearest", () => {
    const remotePlayers = players({ id: "dead", x: 5, y: 0, hp: 0 }, { id: "flag", x: 6, y: 0, dead: true }, { id: "live", x: 100, y: 0 });
    expect(pickTradeTarget({ me, remotePlayers, hoverKey: "p:dead" })).toBe("live");
  });

  it("non-finite positions never pick a target", () => {
    const remotePlayers = players({ id: "nan", x: NaN, y: 0 }, { id: "ok", x: 50, y: 0 });
    expect(pickTradeTarget({ me, remotePlayers })).toBe("ok");
  });

  it("the radius is the argument, 120 by default", () => {
    const remotePlayers = players({ id: "a", x: 150, y: 0 });
    expect(pickTradeTarget({ me, remotePlayers })).toBeNull();
    expect(pickTradeTarget({ me, remotePlayers, radius: 200 })).toBe("a");
  });
});

describe("hoverPlayerKey", () => {
  const camera = { screenX: 640, screenY: 360 };
  const remotePlayers = players({ id: "7", x: 200, y: 100 });
  const rect = () => {
    const s = worldToScreen(200 + 32, 100 + 32);
    return { x: s.x - 32 + Math.floor(GAME_WIDTH / 2 - camera.screenX) + 0, y: s.y - 32 + Math.floor(GAME_HEIGHT / 2 - camera.screenY) };
  };

  it("finds the player under the cursor without the inspect pipeline", () => {
    const r = rect();
    expect(hoverPlayerKey({ remotePlayers, cursorX: r.x + 32, cursorY: r.y + 20, camera })).toBe("p:7");
  });

  it("is null on empty ground, with no camera, and for non-finite cursors", () => {
    expect(hoverPlayerKey({ remotePlayers, cursorX: 1, cursorY: 1, camera })).toBeNull();
    expect(hoverPlayerKey({ remotePlayers, cursorX: 300, cursorY: 300, camera: null })).toBeNull();
    expect(hoverPlayerKey({ remotePlayers, cursorX: NaN, cursorY: 3, camera })).toBeNull();
    expect(hoverPlayerKey({ remotePlayers, cursorX: null, cursorY: null, camera })).toBeNull();
  });

  it("the topmost of two overlapping players wins", () => {
    const two = players({ id: "back", x: 200, y: 100 }, { id: "front", x: 200, y: 100 });
    const r = rect();
    expect(hoverPlayerKey({ remotePlayers: two, cursorX: r.x + 32, cursorY: r.y + 20, camera })).toBe("p:front");
  });
});

describe("invite card layout", () => {
  const invite = (over = {}) => ({ fromName: "Ann", expiresInMs: 30000, receivedAtMs: 1000, expiresAtMs: 31000, ...over });
  const inside = (b, c) => b.x >= c.x && b.y >= c.y && b.x + b.w <= c.x + c.w && b.y + b.h <= c.y + c.h;
  const ctx = (w = 6) => {
    const texts = [];
    const c = new Proxy({ measureText: (s) => ({ width: String(s).length * w }), texts }, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => { o[k] = v; return true; },
    });
    c.fillText = (s) => texts.push(String(s));
    return c;
  };

  it("sits inside the canvas at the top centre, buttons inside the card", () => {
    const l = layoutInviteCard({ invite: invite(), nowMs: 2000, canvasW: 1280, canvasH: 720 });
    expect(l.y).toBeLessThan(40);
    expect(Math.abs(l.x + l.w / 2 - 640)).toBeLessThan(1);
    expect(inside(l, { x: 0, y: 0, w: 1280, h: 720 })).toBe(true);
    expect(inside(l.accept, l)).toBe(true);
    expect(inside(l.decline, l)).toBe(true);
    expect(l.accept.x + l.accept.w).toBeLessThanOrEqual(l.decline.x);
    expect(l.hitAreas.map((a) => a.kind).sort()).toEqual(["tradeInviteAccept", "tradeInviteDecline"]);
  });

  it("a 32-character name is clipped to the card in English and Ukrainian", () => {
    const long = "W".repeat(32);
    for (const lang of ["en", "uk"]) {
      setLang(lang);
      const l = layoutInviteCard({ invite: invite({ fromName: long }), nowMs: 2000, canvasW: 1280, canvasH: 720 });
      expect(l.text.length * 13 * 0.6).toBeLessThanOrEqual(l.w - 20);
      expect(l.text).toContain("…");
      const c = ctx();
      drawInviteCard(c, l, 2000);
      expect(c.texts).toContain(l.text);
    }
    setLang("en");
  });

  it("a short name is not clipped", () => {
    const l = layoutInviteCard({ invite: invite(), nowMs: 2000, canvasW: 1280, canvasH: 720 });
    expect(l.text).toBe("Ann wants to trade");
  });

  it("is null when there is no invite, it expired, or the clock is not finite", () => {
    expect(layoutInviteCard({ invite: null, nowMs: 0, canvasW: 1280, canvasH: 720 })).toBeNull();
    expect(layoutInviteCard({ invite: invite(), nowMs: 31000, canvasW: 1280, canvasH: 720 })).toBeNull();
    expect(layoutInviteCard({ invite: invite(), nowMs: NaN, canvasW: 1280, canvasH: 720 })).toBeNull();
    expect(layoutInviteCard({ invite: invite({ expiresAtMs: NaN }), nowMs: 5, canvasW: 1280, canvasH: 720 })).toBeNull();
  });

  it("a narrow canvas still keeps the card inside", () => {
    const l = layoutInviteCard({ invite: invite(), nowMs: 2000, canvasW: 240, canvasH: 200 });
    expect(inside(l, { x: 0, y: 0, w: 240, h: 200 })).toBe(true);
  });

  it("draws only finite numbers", () => {
    const l = layoutInviteCard({ invite: invite({ fromName: undefined }), nowMs: 2000, canvasW: 1280, canvasH: 720 });
    const bad = [];
    const c = new Proxy({ measureText: (s) => ({ width: String(s).length * 6 }) }, {
      get: (o, k) => (k in o ? o[k] : (...args) => { if (args.some((a) => typeof a === "number" && !Number.isFinite(a))) bad.push(k); }),
      set: (o, k, v) => { o[k] = v; return true; },
    });
    drawInviteCard(c, l, 2000);
    expect(bad).toEqual([]);
  });

  it("every string the card shows is in the Ukrainian dictionary", () => {
    for (const s of ["{name} wants to trade", "Accept (Y)", "Decline (N)", "No player nearby"]) {
      expect(UK[s], s).toBeTruthy();
    }
  });
});

describe("source gates", () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("the trade action is listed in settings", () => {
    expect(src("../../../../GameSettings.jsx")).toMatch(/key: 'trade'/);
  });

  it("the default key is R, because T is the teleport key", () => {
    expect(src("../../core/Game.js")).toMatch(/trade: 'r'/);
  });

  it("Y and N act only while an invite is live", () => {
    const g = src("../../core/Game.js");
    expect(g).toMatch(/_inviteKey\(/);
    expect(g).toMatch(/if \(this\._inviteKey\(e, isKey\)\) return;/);
  });
});
