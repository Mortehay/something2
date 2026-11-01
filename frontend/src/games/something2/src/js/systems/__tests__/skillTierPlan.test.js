import { describe, it, expect } from "vitest";
import { skillUpgradePlan } from "../enchantUi.js";
import { SKILLS } from "../../core/skillsData.js";

describe("skill upgrade plan by tier", () => {
  const costsByTier = { 1: [100, 120], 2: [150, 180], 5: [500, 600] };
  const CFG = { maxLevel: 15, powerPerLevel: 0.01, costs: costsByTier[1], costsByTier };

  it("reads the price from the skill's tier table", () => {
    expect(skillUpgradePlan({}, "s", 1e6, CFG, 1).cost).toBe(100);
    expect(skillUpgradePlan({}, "s", 1e6, CFG, 2).cost).toBe(150);
    expect(skillUpgradePlan({}, "s", 1e6, CFG, 5).cost).toBe(500);
    expect(skillUpgradePlan({ s: 1 }, "s", 1e6, CFG, 5).cost).toBe(600);
  });

  it("the same wallet affords a cheap skill and not an ultimate", () => {
    expect(skillUpgradePlan({}, "s", 300, CFG, 1).canAfford).toBe(true);
    const ultimate = skillUpgradePlan({}, "s", 300, CFG, 5);
    expect(ultimate.canAfford).toBe(false);
    expect(ultimate.disabled).toBe(true);
  });

  it("falls back to the single table for an older config or an unknown tier", () => {
    expect(skillUpgradePlan({}, "s", 1e6, { maxLevel: 15, powerPerLevel: 0.01, costs: [100] }, 5).cost).toBe(100);
    expect(skillUpgradePlan({}, "s", 1e6, CFG, undefined).cost).toBe(100);
    expect(skillUpgradePlan({}, "s", 1e6, CFG, 3).cost).toBe(100);
  });

  it("every generated catalog skill carries the tier the plan needs", () => {
    for (const s of SKILLS) expect([1, 2, 3, 4, 5], s.id).toContain(s.tier);
  });
});
