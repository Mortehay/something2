// frontend/src/games/something2/src/js/core/__tests__/elementsReaction.test.js
import { describe, it, expect } from "vitest";
import { evaluateElementalReaction, ELEMENTAL_REACTIONS } from "../elements.js";

describe("Elemental Synergy Combo Reactions", () => {
  it("evaluates Vaporize when Fire skill hits a Chilled target", () => {
    const res = evaluateElementalReaction(["chill"], "fire");
    expect(res).not.toBeNull();
    expect(res.reactionKey).toBe("vaporize");
    expect(res.multiplier).toBe(1.8);
    expect(res.consume).toContain("chill");
  });

  it("evaluates Shatter when Ice skill hits a Shocked target", () => {
    const res = evaluateElementalReaction(["shock"], "ice");
    expect(res).not.toBeNull();
    expect(res.reactionKey).toBe("shatter");
    expect(res.multiplier).toBe(2.0);
  });

  it("evaluates Super Shatter when Ice skill hits a Chilled and Shocked target", () => {
    const res = evaluateElementalReaction(["chill", "shock"], "ice");
    expect(res).not.toBeNull();
    expect(res.reactionKey).toBe("super_shatter");
    expect(res.multiplier).toBe(2.5);
    expect(res.consume).toContain("chill");
    expect(res.consume).toContain("shock");
  });

  it("evaluates Conductive Arc when Lightning skill hits a Chilled target", () => {
    const res = evaluateElementalReaction(["chill"], "lightning");
    expect(res).not.toBeNull();
    expect(res.reactionKey).toBe("conductive_arc");
    expect(res.multiplier).toBe(1.75);
  });

  it("evaluates Astral Rift when Arcane skill hits a target with active elemental debuffs", () => {
    const res = evaluateElementalReaction(["burn"], "arcane");
    expect(res).not.toBeNull();
    expect(res.reactionKey).toBe("astral_rift");
    expect(res.multiplier).toBe(1.6);
  });

  it("returns null when hitting a target with no active status effects", () => {
    const res = evaluateElementalReaction([], "fire");
    expect(res).toBeNull();
  });
});
