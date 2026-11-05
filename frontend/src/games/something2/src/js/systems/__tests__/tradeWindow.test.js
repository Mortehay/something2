import { describe, it, expect, afterEach } from "vitest";
import { setLang } from "../../i18n/i18n.js";
import {
  layoutTradeWindow, drawTradeWindow, tradeButtonState, tradeReasonText, TRADE_CELLS,
} from "../tradeWindow.js";
import { WINDOW_X, WINDOW_Y, WINDOW_W } from "../storageWindows.js";
import { PANEL_H } from "../inventoryPanel.js";

const SWORD = { id: 1, name: "Sword", category: "weapon" };
const RING = { id: 9, name: "Ring", category: "armor" };
const types = new Map([[1, SWORD]]);
const it_ = (id, over = {}) => ({ id, typeId: 1, quantity: 1, soulbound: false, rarity: "white", type: SWORD, ...over });
const side = (items = [], over = {}) => ({ items, gold: 0, locked: false, confirmed: false, ...over });
const frame = (over = {}) => ({
  partnerName: "Bob", phase: "open", mine: side(), theirs: side(), confirmOpensInMs: null, receivedAtMs: 1000, ...over,
});
const many = (n, base = 100, over = {}) => Array.from({ length: n }, (_, i) => it_(base + i, over));
const inPanel = (r) => r.x >= WINDOW_X && r.y >= WINDOW_Y && r.x + r.w <= WINDOW_X + WINDOW_W && r.y + r.h <= WINDOW_Y + PANEL_H;
const lay = (trade, extra = {}) => layoutTradeWindow({ trade, types, goldField: { focused: false, text: "" }, nowMs: 1000, ...extra });

describe("tradeButtonState", () => {
  it("open and unlocked: OK, enabled", () => {
    expect(tradeButtonState(frame(), 1000)).toEqual({ label: "OK", enabled: true });
  });
  it("mine locked, theirs not: waiting, disabled", () => {
    const s = tradeButtonState(frame({ mine: side([], { locked: true }) }), 1000);
    expect(s).toEqual({ label: "Waiting for Bob", enabled: false });
  });
  it("both locked: Confirm is disabled until confirmOpensInMs has elapsed", () => {
    const t = frame({ phase: "both_locked", mine: side([], { locked: true }), theirs: side([], { locked: true }), confirmOpensInMs: 1500, receivedAtMs: 1000 });
    expect(tradeButtonState(t, 1000)).toEqual({ label: "Confirm", enabled: false });
    expect(tradeButtonState(t, 2499)).toEqual({ label: "Confirm", enabled: false });
    expect(tradeButtonState(t, 2500)).toEqual({ label: "Confirm", enabled: true });
  });
  it("both locked and mine confirmed: waiting, disabled", () => {
    const t = frame({ phase: "both_locked", mine: side([], { locked: true, confirmed: true }), theirs: side([], { locked: true }), confirmOpensInMs: 0 });
    expect(tradeButtonState(t, 5000)).toEqual({ label: "Waiting for Bob", enabled: false });
  });
  it("settling disables the button", () => {
    const t = frame({ phase: "settling", mine: side([], { locked: true, confirmed: true }), theirs: side([], { locked: true, confirmed: true }) });
    expect(tradeButtonState(t, 5000).enabled).toBe(false);
  });
  it("an absent or non-numeric timer counts as elapsed; a timer with no receipt time counts from now", () => {
    const base = { phase: "both_locked", mine: side([], { locked: true }), theirs: side([], { locked: true }) };
    expect(tradeButtonState(frame({ ...base, confirmOpensInMs: null }), 1000).enabled).toBe(true);
    expect(tradeButtonState(frame({ ...base, confirmOpensInMs: 800, receivedAtMs: undefined }), 1000).enabled).toBe(false);
    expect(tradeButtonState(frame({ ...base, confirmOpensInMs: NaN }), 1000).enabled).toBe(true);
  });
});

describe("layoutTradeWindow", () => {
  it("is a paired-window layout of kind trade with two 8x2 stashes", () => {
    const l = lay(frame());
    expect(l.kind).toBe("trade");
    expect(TRADE_CELLS).toBe(16);
    expect(l.theirCells).toHaveLength(16);
    expect(l.myCells).toHaveLength(16);
    expect(l.cells).toHaveLength(32);
    expect(l.hitAreas.some((h) => h.kind === "winclose")).toBe(true);
    expect(l.hitAreas.some((h) => h.kind === "tradeok")).toBe(true);
    expect(l.hitAreas.some((h) => h.kind === "tradeabort")).toBe(true);
    expect(l.hitAreas.some((h) => h.kind === "tradegold")).toBe(true);
    expect(l.panel).toMatchObject({ x: WINDOW_X, y: WINDOW_Y, w: WINDOW_W, h: PANEL_H });
  });
  it("16 items fit on each side, in order, each with its own cell", () => {
    const mine = many(16, 100);
    const theirs = many(16, 500);
    const l = lay(frame({ mine: side(mine), theirs: side(theirs) }));
    expect(l.myCells.map((c) => c.item.id)).toEqual(mine.map((i) => i.id));
    expect(l.theirCells.map((c) => c.item.id)).toEqual(theirs.map((i) => i.id));
    const ids = l.hitAreas.filter((h) => h.kind === "tradeitem").map((h) => h.id);
    expect(ids).toEqual(mine.map((i) => i.id));
  });
  it("items past the 16th are not drawn or hit", () => {
    const l = lay(frame({ mine: side(many(20)) }));
    expect(l.myCells.filter((c) => c.item)).toHaveLength(16);
  });
  it("a partner item takes its type from the frame when the viewer has no such type, and is not draggable", () => {
    const theirs = [it_(77, { typeId: 9, type: RING })];
    const l = lay(frame({ theirs: side(theirs) }));
    expect(types.has(9)).toBe(false);
    expect(l.theirCells[0].type).toBe(RING);
    expect(l.hitAreas.filter((h) => h.id === 77)).toEqual([]);
    expect(l.hitAreas.some((h) => h.kind === "tradeitem" && h.id === 77)).toBe(false);
  });
  it("a frame item with no type falls back to the viewer's types, and to null", () => {
    const l = lay(frame({ mine: side([it_(1, { type: null }), it_(2, { typeId: 4, type: null })]) }));
    expect(l.myCells[0].type).toBe(SWORD);
    expect(l.myCells[1].type).toBeNull();
    expect(l.myCells[1].item.id).toBe(2);
  });
  it("my unlocked items are draggable hit areas carrying their type id", () => {
    const l = lay(frame({ mine: side([it_(5)]) }));
    expect(l.hitAreas.find((h) => h.kind === "tradeitem")).toMatchObject({ id: 5, typeId: 1 });
  });
  it("a locked side has no draggable cells and no gold hit area", () => {
    const l = lay(frame({ phase: "both_locked", mine: side([it_(5)], { locked: true }), theirs: side([], { locked: true }) }));
    expect(l.hitAreas.filter((h) => h.kind === "tradeitem")).toEqual([]);
    expect(l.hitAreas.some((h) => h.kind === "tradegold")).toBe(false);
    expect(l.myLocked).toBe(true);
    expect(l.theirLocked).toBe(true);
    expect(l.myCells[0].item.id).toBe(5);
  });
  it("every cell, field and button is inside the panel", () => {
    const l = lay(frame({ mine: side(many(16)), theirs: side(many(16, 500)) }));
    for (const r of [l.close, l.okButton, l.abortButton, l.goldRect, ...l.cells, ...l.hitAreas]) {
      expect(inPanel(r), JSON.stringify(r)).toBe(true);
    }
  });
  it("the button state and sides' status are on the layout", () => {
    const l = lay(frame({ mine: side([], { locked: true }), theirs: side([], { confirmed: true }) }));
    expect(l.button).toEqual({ label: "Waiting for Bob", enabled: false });
    expect(l.myStatus).toBe("Locked");
    expect(l.theirStatus).toBe("Confirmed");
    expect(lay(frame()).myStatus).toBe("Editing");
  });
  it("the gold field shows the typed text while focused and my gold otherwise", () => {
    expect(lay(frame({ mine: side([], { gold: 120 }) })).goldText).toBe("120");
    expect(lay(frame({ mine: side([], { gold: 120 }) }), { goldField: { focused: true, text: "45" } }).goldText).toBe("45");
    expect(lay(frame({ mine: side([], { gold: 120 }) }), { goldField: { focused: true, text: "45" } }).goldFocused).toBe(true);
  });
  it("flashes the partner's stash only while the flash window is open", () => {
    expect(lay(frame(), { theirFlashUntilMs: 1500 }).theirFlash).toBe(true);
    expect(lay(frame(), { theirFlashUntilMs: 900 }).theirFlash).toBe(false);
    expect(lay(frame()).theirFlash).toBe(false);
  });
  it("never emits a non-finite coordinate, whatever the frame holds", () => {
    const junk = { partnerName: undefined, phase: "open", mine: { items: [null, { id: 1 }], gold: NaN }, theirs: undefined };
    const l = lay(junk);
    for (const r of [l.panel, l.close, l.okButton, l.abortButton, l.goldRect, ...l.cells, ...l.hitAreas]) {
      for (const k of ["x", "y", "w", "h"]) expect(Number.isFinite(r[k]), `${k} of ${JSON.stringify(r)}`).toBe(true);
    }
    expect(lay(null).cells).toHaveLength(32);
  });
});

describe("tradeReasonText", () => {
  it("passes a known reason through and fills a partner's name", () => {
    expect(tradeReasonText("you cancelled the trade")).toBe("you cancelled the trade");
    expect(tradeReasonText("Bob cancelled the trade")).toBe("Bob cancelled the trade");
    expect(tradeReasonText(null)).toBeNull();
  });
});

describe("tradeReasonText in Ukrainian", () => {
  afterEach(() => setLang("en"));
  it("fills a partner's name into the template, whatever the name", () => {
    setLang("uk");
    expect(tradeReasonText("Bob left")).toBe("Bob вийшов(ла)");
    expect(tradeReasonText("Bob cancelled the trade")).toBe("Bob скасував(ла) обмін");
    expect(tradeReasonText("Mary Ann has no room")).toBe("у Mary Ann немає місця");
    expect(tradeReasonText("you died")).toBe("ви загинули");
    expect(tradeReasonText("something the server invented")).toBe("something the server invented");
  });
});

describe("settling", () => {
  it("Abort has no hit area and is flagged disabled", () => {
    const t = frame({ phase: "settling", mine: side([], { locked: true, confirmed: true }), theirs: side([], { locked: true, confirmed: true }) });
    const l = lay(t);
    expect(l.abortEnabled).toBe(false);
    expect(l.hitAreas.some((h) => h.kind === "tradeabort")).toBe(false);
    expect(lay(frame()).abortEnabled).toBe(true);
  });
});

// Draws into a recording context that measures like the monospace the game ships
// and checks every string stays inside the window, with a real 32-character name
// (the longest CharacterSelect allows) in both languages.
describe("drawn text stays inside the window", () => {
  afterEach(() => setLang("en"));
  const NAME32 = "Bartholomew-Maximilian-Oleksandr";

  function drawn(trade) {
    const out = [];
    let px = 12, align = "left";
    const ctx = new Proxy({}, {
      get: (o, k) => {
        if (k === "measureText") return (s) => ({ width: String(s).length * px * 0.6 });
        if (k === "fillText") return (txt, x) => {
          const w = String(txt).length * px * 0.6;
          const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
          out.push({ txt: String(txt), left, right: left + w });
        };
        if (k in o) return o[k];
        return () => {};
      },
      set: (o, k, v) => {
        if (k === "font") px = Number(String(v).match(/(\d+)px/)[1]);
        if (k === "textAlign") align = v;
        o[k] = v;
        return true;
      },
    });
    const l = layoutTradeWindow({ trade, types, goldField: { focused: true, text: "9".repeat(15) }, nowMs: 0 });
    drawTradeWindow(ctx, l, {}, null);
    return out;
  }
  const phases = {
    open: frame({ partnerName: NAME32 }),
    locked: frame({ partnerName: NAME32, mine: side([], { locked: true }), theirs: side([], { confirmed: true, gold: 999999999999999 }) }),
    both: frame({ partnerName: NAME32, phase: "both_locked", mine: side([], { locked: true }), theirs: side([], { locked: true }), confirmOpensInMs: 0 }),
    waiting: frame({ partnerName: NAME32, phase: "both_locked", mine: side([], { locked: true, confirmed: true }), theirs: side([], { locked: true }) }),
    settling: frame({ partnerName: NAME32, phase: "settling", mine: side([], { locked: true, confirmed: true }), theirs: side([], { locked: true, confirmed: true }) }),
  };
  for (const lang of ["en", "uk"]) {
    for (const [phase, trade] of Object.entries(phases)) {
      it(`${lang}, ${phase}`, () => {
        setLang(lang);
        const texts = drawn(trade);
        expect(texts.length).toBeGreaterThan(5);
        for (const x of texts) {
          expect(x.left, x.txt).toBeGreaterThanOrEqual(WINDOW_X);
          expect(x.right, x.txt).toBeLessThanOrEqual(WINDOW_X + WINDOW_W);
        }
        // Buttons are narrower than the window: their labels must fit the button.
        const l = layoutTradeWindow({ trade, types, goldField: null, nowMs: 0 });
        for (const b of [l.okButton, l.abortButton]) {
          const labels = texts.filter((y) => Math.abs((y.left + y.right) / 2 - (b.x + b.w / 2)) < 1);
          expect(labels.length).toBeGreaterThan(0);
          for (const x of labels) {
            expect(x.left, x.txt).toBeGreaterThanOrEqual(b.x);
            expect(x.right, x.txt).toBeLessThanOrEqual(b.x + b.w);
          }
        }
      });
    }
  }
});
