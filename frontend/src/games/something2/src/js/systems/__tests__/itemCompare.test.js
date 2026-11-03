import { describe, it, expect } from "vitest";
import { compareItems, compareLines, comparisonSlot } from "../itemCompare.js";

const iron = { name: "iron-sword", category: "weapon", damage: 18, cooldown: 0.6, reach: 40 };
const steel = { name: "steel-sword", category: "weapon", damage: 24, cooldown: 0.5, reach: 44, mana_cost: 2 };
const by = (rows, l) => rows.find((r) => r.label === l);

describe("compareItems", () => {
  it("weapon deltas and DPS", () => {
    const rows = compareItems(steel, iron);
    expect(by(rows, "Damage")).toMatchObject({ value: 24, delta: 6, better: true });
    expect(by(rows, "DPS")).toMatchObject({ value: 48, delta: 18, better: true });
    expect(by(rows, "Reach").delta).toBe(4);
    expect(by(rows, "Mana cost")).toMatchObject({ delta: 2, better: false });
  });
  it("lower cooldown is better, higher is worse", () => {
    expect(by(compareItems(steel, iron), "Cooldown")).toMatchObject({ delta: -0.1, better: true });
    expect(by(compareItems(iron, steel), "Cooldown")).toMatchObject({ delta: 0.1, better: false });
  });
  it("equal stats give null", () => {
    const rows = compareItems(iron, { ...iron });
    expect(rows.every((r) => r.better === null && r.delta === 0)).toBe(true);
  });
  it("empty slot compares against zero", () => {
    expect(by(compareItems(iron, null), "Damage")).toMatchObject({ delta: 18, better: true });
  });
  it("armor defense and resistances", () => {
    const a = { category: "armor", slot: "chest", defense: 5, resistances: { fire: 10 } };
    const b = { category: "armor", slot: "chest", defense: 8, resistances: { fire: 5, ice: 3 } };
    const rows = compareItems(b, a);
    expect(by(rows, "Defense")).toMatchObject({ delta: 3, better: true });
    expect(by(rows, "fire res")).toMatchObject({ delta: -5, better: false });
    expect(by(rows, "ice res").delta).toBe(3);
  });
  it("non-comparable or mismatched categories return []", () => {
    expect(compareItems({ category: "consumable" }, null)).toEqual([]);
    expect(compareItems(null, iron)).toEqual([]);
    expect(compareItems(iron, { category: "armor" })).toEqual([]);
  });
  it("comparisonSlot", () => {
    expect(comparisonSlot(iron)).toBe("main_hand");
    expect(comparisonSlot({ category: "armor", slot: "head" })).toBe("head");
    expect(comparisonSlot({ category: "ammo" })).toBe(null);
  });
});

describe("compareLines", () => {
  it("header, colours and text", () => {
    const lines = compareLines({ id: 2 }, steel, { id: 1 }, iron);
    expect(lines[0].text).toBe("vs equipped: iron-sword");
    const dmg = lines.find((l) => l.text.startsWith("Damage"));
    expect(dmg.text).toBe("Damage 24 (+6)");
    expect(dmg.color).toBe("#4ade80");
    expect(lines.find((l) => l.text.startsWith("DPS")).text).toBe("DPS 48.0 (+18)");
    expect(lines.find((l) => l.text.startsWith("Mana")).color).toBe("#f87171");
  });
  it("nothing equipped", () => {
    expect(compareLines({ id: 2 }, iron, null, null)[0].text).toBe("vs equipped: nothing");
  });
  it("same item shows nothing", () => {
    expect(compareLines({ id: 1 }, iron, { id: 1 }, iron)).toEqual([]);
  });
  it("grey for equal", () => {
    const l = compareLines({ id: 2 }, iron, { id: 1 }, { ...iron });
    expect(l.find((x) => x.text.startsWith("Damage")).color).toBe("#9ca3af");
  });
  it("consumables", () => {
    expect(compareLines({ id: 2 }, { category: "consumable" }, null, null)).toEqual([]);
  });
});
