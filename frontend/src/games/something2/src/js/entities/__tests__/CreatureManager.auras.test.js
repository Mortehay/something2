import { describe, it, expect } from "vitest";
import { CreatureManager } from "../CreatureManager.js";

describe("CreatureManager aura names (SOMET-606)", () => {
  it("keeps intro aura names across frames that omit them", () => {
    const cm = new CreatureManager(null);
    cm.applySnapshot([{ id: "a", type: "T", x: 0, y: 0, hp: 9, maxHp: 9, auras: ["mire"] }]);
    cm.applySnapshot([{ id: "a", x: 1, y: 1, hp: 8, facing: "S", mode: "idle" }]);
    expect(cm.all()[0].auras).toEqual(["mire"]);
  });
  it("an ordinary creature has auras null", () => {
    const cm = new CreatureManager(null);
    cm.applySnapshot([{ id: "w", type: "Wolf", x: 0, y: 0, hp: 5, maxHp: 5 }]);
    expect(cm.all()[0].auras).toBe(null);
  });
});
