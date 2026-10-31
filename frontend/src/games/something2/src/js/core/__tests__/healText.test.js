import { describe, it, expect } from "vitest";
import { shouldShowHealText, MIN_HEAL_TEXT } from "../Game.js";

describe("floating text for HP regeneration", () => {
  it("hides 5 HP and below, shows 6 and above", () => {
    expect(MIN_HEAL_TEXT).toBe(5);
    for (const h of [0, 1, 2, 3, 4, 5]) expect(shouldShowHealText(h)).toBe(false);
    for (const h of [6, 7, 25, 100]) expect(shouldShowHealText(h)).toBe(true);
  });
});
