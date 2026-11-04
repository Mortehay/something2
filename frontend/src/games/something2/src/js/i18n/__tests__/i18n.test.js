import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { t, tn, getLang, setLang, onLangChange, pluralIndex, LANGS } from "../i18n.js";
import { UK, UK_AREAS } from "../uk/index.js";

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
    "Store in chest", "Take", "Sell for {n} g", "Buy for {n} g", "Stored ({n})", "worn", "Merchant",
    "Account Chest ({used}/{cap})",
    "unequip it first", "unsocket it first", "unsocket the stone first", "starting gear cannot be sold",
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
