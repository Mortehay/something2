import { describe, it, expect } from "vitest";
import { SKILLS, checkGemRequirements, gemVisibility } from "../../core/skillsData.js";
import { layoutGemShopPanel } from "../gemShopPanel.js";

const MAXED = { level: 99, strength: 99, dexterity: 99, constitution: 99, intelligence: 99, wisdom: 99, charisma: 99 };
const gated = SKILLS.find((s) => (s.reqQuests || []).length > 0 && !s.secretGem);
const secret = SKILLS.find((s) => s.secretGem);
const vis = (gem, stats, ctx, owned = false) =>
  gemVisibility(gem, checkGemRequirements(gem, stats, { name: "any" }, ctx), owned, stats.level);

describe("gemVisibility", () => {
  it("owned wins over everything", () => {
    expect(vis(gated, { level: 1 }, { completedQuests: [] }, true)).toBe("unlocked");
  });
  it("is available once level, attributes and quests are met", () => {
    expect(vis(gated, MAXED, { completedQuests: gated.reqQuests })).toBe("available");
  });
  it("is locked (visible, with a reason) when only the quest is missing for a normal gem", () => {
    expect(vis(gated, MAXED, { completedQuests: [] })).toBe("locked");
  });
  it("seals a secret gem until its quest is done, then offers it", () => {
    expect(vis(secret, MAXED, { completedQuests: [] })).toBe("hidden");
    expect(vis(secret, MAXED, { completedQuests: secret.reqQuests })).toBe("available");
  });
  it("seals a gem far above the player's level but shows near ones as locked", () => {
    const far = SKILLS.find((s) => s.reqLvl >= 40 && !s.secretGem);
    expect(vis(far, { level: 1 }, { completedQuests: [] })).toBe("hidden");
    expect(vis(far, { level: far.reqLvl - 3 }, { completedQuests: [] })).toBe("locked");
  });
});

describe("gem shop with unlock states", () => {
  const base = { classFilter: "all", colorFilter: "all", playerGold: 99999, equippedWeapon: null };
  it("lists only non-sealed gems, counts the sealed ones and puts obtainable first", () => {
    const l = layoutGemShopPanel({ ...base, playerStats: { level: 1 }, questCtx: { completedQuests: [] }, ownedGemIds: [], playerLevel: 1 });
    expect(l.sealedCount).toBeGreaterThan(0);
    expect(l.sealedCount + l.totalCount).toBe(SKILLS.length);
    expect(l.rows.every((r) => r.state !== "hidden")).toBe(true);
    expect(l.rows[0].state).toBe("available");
  });
  it("a locked row carries the message and a non-affordable buy button", () => {
    const l = layoutGemShopPanel({ ...base, page: 0, playerStats: { level: 1 }, questCtx: { completedQuests: [] }, ownedGemIds: [], playerLevel: 1 });
    const buys = l.hitAreas.filter((h) => h.kind === "gem_shop_buy");
    const lockedHit = buys.find((h) => h.state === "locked");
    if (lockedHit) {
      expect(lockedHit.canAfford).toBe(false);
      expect(lockedHit.message).toMatch(/^Requires /);
    }
    const owned = layoutGemShopPanel({ ...base, playerStats: MAXED, questCtx: { completedQuests: [] }, ownedGemIds: [SKILLS[0].id], playerLevel: 99 });
    const mine = owned.hitAreas.find((h) => h.kind === "gem_shop_buy" && h.gemId === SKILLS[0].id);
    if (mine) expect(mine.state).toBe("unlocked");
  });
});
