import { describe, it, expect } from "vitest";
import {
  bossFieldsFromEntity, bossFieldsPayload, bossFieldError, bossBadgeLabel, LOOT_RARITIES,
} from "../bossFields.js";

describe("boss fields form rules (SOMET-603)", () => {
  it("an entity with no boss data loads as empty inputs, not 0 or 'null'", () => {
    expect(bossFieldsFromEntity({
      boss_tier: null, element: null, hitbox_size: null, xp_reward: null, base_damage: null,
      loot_rolls: null, loot_min_rarity: null, loot_rarity_bias: null, loot_chest: null,
    })).toEqual({
      boss_tier: "", element: "", hitbox_size: "", xp_reward: "", base_damage: "",
      loot_rolls: "", loot_min_rarity: "", loot_rarity_bias: "", loot_chest: "",
    });
  });

  it("empty inputs travel as explicit nulls (a clear), every key always sent", () => {
    expect(bossFieldsPayload({
      boss_tier: "", element: "", hitbox_size: "", xp_reward: Number.NaN, base_damage: "",
      loot_rolls: "", loot_min_rarity: "", loot_rarity_bias: "", loot_chest: "",
    })).toEqual({
      boss_tier: null, element: null, hitbox_size: null, xp_reward: null, base_damage: null,
      loot_rolls: null, loot_min_rarity: null, loot_rarity_bias: null, loot_chest: null,
    });
  });

  it("filled inputs travel as values", () => {
    expect(bossFieldsPayload({
      boss_tier: "world", element: "ice", hitbox_size: 96, xp_reward: 3800, base_damage: 35,
      loot_rolls: 5, loot_min_rarity: "yellow", loot_rarity_bias: 0.6, loot_chest: "true",
    })).toEqual({
      boss_tier: "world", element: "ice", hitbox_size: 96, xp_reward: 3800, base_damage: 35,
      loot_rolls: 5, loot_min_rarity: "yellow", loot_rarity_bias: 0.6, loot_chest: true,
    });
  });

  it("rejects an out-of-range hitbox, a negative xp and a negative damage", () => {
    expect(bossFieldError({ hitbox_size: 0 })).toMatch(/Hitbox/);
    expect(bossFieldError({ hitbox_size: 401 })).toMatch(/Hitbox/);
    expect(bossFieldError({ xp_reward: -1 })).toMatch(/XP/);
    expect(bossFieldError({ base_damage: -2 })).toMatch(/Damage/);
    expect(bossFieldError({ hitbox_size: "", xp_reward: "", base_damage: "" })).toBe(null);
  });

  it("badges a boss row by tier and nothing else", () => {
    expect(bossBadgeLabel({ boss_tier: "world" })).toBe("World boss");
    expect(bossBadgeLabel({ boss_tier: "dungeon_elite" })).toBe("Dungeon mini-boss (Elite)");
    expect(bossBadgeLabel({ boss_tier: null, name: "Ignis, the Magma Colossus" })).toBe(null);
  });
});

// SOMET-611 (S10, spec §3.7/§5): the four loot override fields.
describe("boss loot fields form rules (SOMET-611)", () => {
  it("loot_chest round-trips through its tri-state string encoding", () => {
    expect(bossFieldsFromEntity({ loot_chest: true }).loot_chest).toBe("true");
    expect(bossFieldsFromEntity({ loot_chest: false }).loot_chest).toBe("false");
    expect(bossFieldsFromEntity({ loot_chest: null }).loot_chest).toBe("");
    expect(bossFieldsPayload({ loot_chest: "true" }).loot_chest).toBe(true);
    expect(bossFieldsPayload({ loot_chest: "false" }).loot_chest).toBe(false);
    expect(bossFieldsPayload({ loot_chest: "" }).loot_chest).toBe(null);
  });

  it("rejects a negative roll count, an unknown rarity name and an out-of-range bias", () => {
    expect(bossFieldError({ loot_rolls: -1 })).toMatch(/Loot Rolls/);
    expect(bossFieldError({ loot_rolls: 1.5 })).toMatch(/Loot Rolls/);
    expect(bossFieldError({ loot_min_rarity: "purple" })).toMatch(/Loot Min Rarity/);
    expect(bossFieldError({ loot_rarity_bias: -0.1 })).toMatch(/Loot Rarity Bias/);
    expect(bossFieldError({ loot_rarity_bias: 0.91 })).toMatch(/Loot Rarity Bias/);
    expect(bossFieldError({ loot_rolls: "", loot_min_rarity: "", loot_rarity_bias: "" })).toBe(null);
  });

  it("accepts every real rarity name and the bias range's own endpoints", () => {
    for (const r of LOOT_RARITIES) expect(bossFieldError({ loot_min_rarity: r })).toBe(null);
    expect(bossFieldError({ loot_rarity_bias: 0 })).toBe(null);
    expect(bossFieldError({ loot_rarity_bias: 0.9 })).toBe(null);
  });
});
