import { describe, it, expect } from "vitest";
import { reduceGoldField, goldFromText, GOLD_MAX_DIGITS } from "../tradeGoldField.js";

const press = (text, key) => reduceGoldField(text, key);

describe("reduceGoldField", () => {
  it("appends digits", () => {
    expect(press("", "5").text).toBe("5");
    expect(press("12", "3").text).toBe("123");
  });
  it("ignores everything that is not a single digit", () => {
    for (const k of ["a", "-", ".", " ", "e", "ArrowLeft", "Tab", "Shift", "٣", "12", "", undefined, null]) {
      const r = press("12", k);
      expect(r.text, String(k)).toBe("12");
      expect(r.commit).toBeNull();
      expect(r.blur).toBe(false);
    }
  });
  it("Backspace removes the last digit and never goes below empty", () => {
    expect(press("123", "Backspace").text).toBe("12");
    expect(press("", "Backspace").text).toBe("");
  });
  it("caps the text at 15 digits", () => {
    const full = "9".repeat(GOLD_MAX_DIGITS);
    expect(GOLD_MAX_DIGITS).toBe(15);
    expect(press(full, "1").text).toBe(full);
    expect(press(full.slice(1), "1").text).toHaveLength(15);
  });
  it("collapses leading zeros", () => {
    expect(press("0", "7").text).toBe("7");
    expect(press("", "0").text).toBe("0");
    expect(press("0", "0").text).toBe("0");
    expect(press("00", "5").text).toBe("5");
  });
  it("Enter commits the number and blurs; empty commits 0", () => {
    expect(press("250", "Enter")).toEqual({ text: "250", commit: 250, blur: true });
    expect(press("", "Enter")).toEqual({ text: "", commit: 0, blur: true });
  });
  it("Escape blurs without committing", () => {
    expect(press("250", "Escape")).toMatchObject({ commit: null, blur: true });
  });
});

describe("goldFromText", () => {
  it("is a finite non-negative integer for any text", () => {
    expect(goldFromText("")).toBe(0);
    expect(goldFromText("0042")).toBe(42);
    expect(goldFromText("9".repeat(15))).toBe(999999999999999);
    expect(goldFromText("abc")).toBe(0);
    expect(goldFromText(undefined)).toBe(0);
  });
});
