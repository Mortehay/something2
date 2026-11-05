import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { t, tn, getLang, setLang, onLangChange, pluralIndex, LANGS } from "../i18n.js";
import { UK, UK_AREAS } from "../uk/index.js";
import { HINT_STORE, HINT_TAKE, HINT_SELL, HINT_BUY, REFUSE_WORN, HINT_OFFER, HINT_UNOFFER } from "../../systems/pairedDrop.js";
import { TRADE_STRINGS, TRADE_MESSAGES, NAMED_REASON_TEMPLATES, layoutTradeWindow, tradeButtonState } from "../../systems/tradeWindow.js";

afterEach(() => setLang("en"));

describe("t", () => {
  beforeEach(() => setLang("en"));

  it("is the identity in English, with {param} filling", () => {
    expect(t("Inventory")).toBe("Inventory");
    expect(t("Progress {a}/{b}", { a: 1, b: 10 })).toBe("Progress 1/10");
    expect(t("{x} stays", {})).toBe("{x} stays");
    expect(t(42)).toBe(42);
    expect(t(undefined)).toBeUndefined();
  });

  it("translates through the dictionary in Ukrainian and falls back to English when missing", () => {
    UK["__probe {n}"] = "проба {n}";
    setLang("uk");
    expect(t("__probe {n}", { n: 3 })).toBe("проба 3");
    expect(t("__no such string__")).toBe("__no such string__");
    delete UK["__probe {n}"];
  });

  it("ignores prototype keys", () => {
    setLang("uk");
    expect(t("constructor")).toBe("constructor");
    expect(t("toString")).toBe("toString");
  });
});

describe("language switch", () => {
  it("only accepts known languages, notifies listeners, and persists", () => {
    const seen = [];
    const off = onLangChange((l) => seen.push(l));
    setLang("xx");
    expect(getLang()).toBe("en");
    setLang("uk");
    setLang("uk");
    expect(getLang()).toBe("uk");
    expect(seen).toEqual(["uk"]);
    expect(globalThis.localStorage?.getItem?.("something2.lang") ?? "uk").toBe("uk");
    off();
    setLang("en");
    expect(seen).toEqual(["uk"]);
    expect(LANGS.map((l) => l.code)).toEqual(["en", "uk"]);
  });
});

describe("plurals", () => {
  it("English: one / other", () => {
    expect(pluralIndex(1, "en")).toBe(0);
    expect(pluralIndex(0, "en")).toBe(1);
    expect(pluralIndex(5, "en")).toBe(1);
  });
  it("Ukrainian: one / few / many", () => {
    const idx = (n) => pluralIndex(n, "uk");
    expect([1, 21, 101].map(idx)).toEqual([0, 0, 0]);
    expect([2, 3, 4, 22, 24, 102].map(idx)).toEqual([1, 1, 1, 1, 1, 1]);
    expect([0, 5, 11, 12, 14, 15, 20, 25].map(idx)).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
  });
  it("tn picks the right form per language", () => {
    expect(tn(1, ["{n} point", "{n} points"])).toBe("1 point");
    expect(tn(3, ["{n} point", "{n} points"])).toBe("3 points");
    UK["{n} point"] = ["{n} пункт", "{n} пункти", "{n} пунктів"];
    setLang("uk");
    expect(tn(1, ["{n} point", "{n} points"])).toBe("1 пункт");
    expect(tn(3, ["{n} point", "{n} points"])).toBe("3 пункти");
    expect(tn(7, ["{n} point", "{n} points"])).toBe("7 пунктів");
    delete UK["{n} point"];
  });
});

// The dictionaries themselves: a translation that loses or invents a {placeholder}
// would show a raw "{n}" or silently drop a number.
describe("Ukrainian dictionaries", () => {
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  const entries = Object.entries(UK);

  it("every value is non-empty text (or a plural array of non-empty text)", () => {
    for (const [k, v] of entries) {
      const vals = Array.isArray(v) ? v : [v];
      for (const x of vals) expect(typeof x === "string" && x.trim().length > 0, `empty translation for "${k}"`).toBe(true);
    }
  });

  it("keeps exactly the placeholders of the English string", () => {
    for (const [k, v] of entries) {
      for (const x of Array.isArray(v) ? v : [v]) expect(ph(x), `placeholders differ for "${k}"`).toBe(ph(k));
    }
  });

  it("no area overrides another area's entry with a different text", () => {
    const seen = new Map();
    for (const [area, d] of Object.entries(UK_AREAS)) {
      for (const [k, v] of Object.entries(d)) {
        const j = JSON.stringify(v);
        if (seen.has(k)) expect(seen.get(k).j, `"${k}" differs between ${seen.get(k).area} and ${area}`).toBe(j);
        else seen.set(k, { area, j });
      }
    }
  });

  it("contains no untranslated Latin-only values for multi-word text (catches pasted English)", () => {
    const bad = entries.filter(([k, v]) => typeof v === "string" && v === k && /[a-z]{4,} [a-z]{4,}/i.test(k));
    expect(bad.map(([k]) => k)).toEqual([]);
  });
});

describe("chest and merchant windows", () => {
  const KEYS = [
    HINT_STORE, HINT_TAKE, HINT_SELL, HINT_BUY, "Stored ({n})", "worn", "bound", "Merchant",
    "Account Chest ({used}/{cap})",
    REFUSE_WORN, "unsocket it first", "unsocket the stone first", "starting gear cannot be sold",
    "cannot sell a stacked item", "your chest is full", "Inventory full", "not enough gold",
    "stones cannot be stored", "chest was busy, try again", "that item is not in your chest",
    "that item cannot be withdrawn right now", "that item is no longer for sale", "you do not own that item",
    "no merchant nearby", "no bank nearby",
  ];

  it("every paired-window string and trade refusal has a Ukrainian entry", () => {
    for (const k of KEYS) {
      expect(typeof UK[k] === "string" && UK[k].trim().length > 0, `missing Ukrainian entry for "${k}"`).toBe(true);
      expect(UK[k], `"${k}" left in English`).not.toBe(k);
    }
  });
});

describe("trade window", () => {
  const KEYS = [...new Set([...TRADE_STRINGS, ...TRADE_MESSAGES, ...NAMED_REASON_TEMPLATES, HINT_OFFER, HINT_UNOFFER])];

  it("every string the window or the server can show has a Ukrainian entry", () => {
    expect(KEYS.length).toBeGreaterThan(50);
    for (const k of KEYS) {
      expect(typeof UK[k] === "string" && UK[k].trim().length > 0, `missing Ukrainian entry for "${k}"`).toBe(true);
      expect(UK[k], `"${k}" left in English`).not.toBe(k);
    }
  });

  // The window draws 12 px and 14 px monospace; every label is clipped to its box,
  // but a clip loses words, so the shipped translations should fit whole with a
  // long player name. 0.6 em advance, as clipToWidth assumes.
  it("the Ukrainian labels without a name fit their boxes whole", () => {
    const px = (str, font) => String(str).length * font * 0.6;
    for (const k of ["Confirm", "Abort", "Completing the trade...", "OK"]) expect(px(UK[k], 14), k).toBeLessThanOrEqual(186 - 16);
    for (const k of ["Editing", "Locked", "Confirmed"]) expect(px(UK[k], 12), k).toBeLessThanOrEqual(100);
    for (const k of ["Drag items from your bag to offer them", "Both locked. Review, then confirm."]) {
      expect(px(UK[k], 12), k).toBeLessThanOrEqual(408 - 28);
    }
    expect(px(UK["Your gold"], 12)).toBeLessThanOrEqual(90);
  });
  // Strings that carry a player name (up to 32 characters) are clipped by the
  // window; tradeWindow.test.js draws them with a real 32-character name.

  it("button states carry translated labels in Ukrainian", () => {
    setLang("uk");
    const trade = { partnerName: "Bob", phase: "open", mine: { items: [], locked: true }, theirs: { items: [] } };
    expect(tradeButtonState(trade, 0).label).toBe("Очікуємо Bob");
    expect(layoutTradeWindow({ trade, types: new Map(), nowMs: 0 }).titleText).toBe("Обмін із Bob");
  });
});
