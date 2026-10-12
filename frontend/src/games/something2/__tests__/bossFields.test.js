import { describe, it, expect } from "vitest";
import {
  bossFieldsFromEntity, bossFieldsPayload, bossFieldError, bossBadgeLabel,
} from "../bossFields.js";

describe("boss fields form rules (SOMET-603)", () => {
  it("an entity with no boss data loads as empty inputs, not 0 or 'null'", () => {
    expect(bossFieldsFromEntity({ boss_tier: null, element: null, hitbox_size: null, xp_reward: null, base_damage: null }))
      .toEqual({ boss_tier: "", element: "", hitbox_size: "", xp_reward: "", base_damage: "" });
  });

  it("empty inputs travel as explicit nulls (a clear), every key always sent", () => {
    expect(bossFieldsPayload({ boss_tier: "", element: "", hitbox_size: "", xp_reward: Number.NaN, base_damage: "" }))
      .toEqual({ boss_tier: null, element: null, hitbox_size: null, xp_reward: null, base_damage: null });
  });

  it("filled inputs travel as values", () => {
    expect(bossFieldsPayload({ boss_tier: "world", element: "ice", hitbox_size: 96, xp_reward: 3800, base_damage: 35 }))
      .toEqual({ boss_tier: "world", element: "ice", hitbox_size: 96, xp_reward: 3800, base_damage: 35 });
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
