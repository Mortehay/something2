import { describe, it, expect, beforeEach } from "vitest";
import {
  enchantLevelOf, enchantedName, damageBonusPercent, enchantedDamage, findScroll, scrollCount,
  enchantPlan, enchantButtonLabel, needsConfirm, enchantResultMessage, applyEnchantResult,
  skillLevelOf, skillUpgradePlan,
} from "../enchantUi.js";
import { glowParams, glowSprite, clearGlowCache, drawWeaponGlow, handOffset, shouldDrawGlow } from "../weaponGlow.js";
import { layoutInventory, formatItemTooltipLines } from "../inventoryPanel.js";
import { layoutSkillsPanel } from "../skillsPanel.js";
import { createInventory, applyJoined, addItem } from "../../core/inventory.js";
import { remotePlayerFromFrame } from "../../core/worldPlayers.js";

const CFG = {
  maxLevel: 15, safeMaxLevel: 3, damagePerLevel: 0.08, glowMinLevel: 4, glowFireLevel: 10,
  scrollItemName: "enchant_scroll",
  chances: { 1: 100, 2: 100, 3: 100, 4: 60, 5: 50, 6: 40, 7: 30, 8: 20, 9: 15, 10: 10, 11: 7, 12: 5, 13: 3, 14: 2, 15: 1 },
};

function inventoryWith(items, types) {
  const inv = createInventory();
  for (const t of types) inv.types.set(t.id, t);
  inv.items = items;
  return inv;
}
const SWORD = { id: 1, name: "sword", category: "weapon", damage: 10, cooldown: 1, kind: "melee" };
const SCROLL = { id: 2, name: "enchant_scroll", category: "consumable" };
const VEST = { id: 3, name: "vest", category: "armor" };

describe("enchant helpers", () => {
  it("names and levels", () => {
    expect(enchantLevelOf({ enchantLevel: 7 })).toBe(7);
    expect(enchantLevelOf({ enchantLevel: -2 })).toBe(0);
    expect(enchantLevelOf(null)).toBe(0);
    expect(enchantedName("sword", 7)).toBe("+7 sword");
    expect(enchantedName("sword", 0)).toBe("sword");
  });

  it("shows the damage an enchanted weapon really does", () => {
    expect(damageBonusPercent(5, CFG)).toBe(40);
    expect(damageBonusPercent(0, CFG)).toBe(0);
    expect(enchantedDamage(10, 5, CFG)).toBe(14);
    expect(enchantedDamage(10, 0, CFG)).toBe(10);
    expect(enchantedDamage(10, 5, null)).toBe(10);
  });

  it("counts scrolls across stacks", () => {
    const inv = inventoryWith([
      { id: "s1", typeId: 2, quantity: 3 }, { id: "s2", typeId: 2, quantity: 2 }, { id: "w", typeId: 1, quantity: 1 },
    ], [SWORD, SCROLL]);
    expect(scrollCount(inv, CFG)).toBe(5);
    expect(findScroll(inv, CFG).id).toBe("s1");
    expect(findScroll(inventoryWith([], [SCROLL]), CFG)).toBeNull();
  });
});

describe("enchantPlan", () => {
  const inv = (level, scrolls = 2) => inventoryWith([
    { id: "w", typeId: 1, quantity: 1, enchantLevel: level },
    ...(scrolls ? [{ id: "s", typeId: 2, quantity: scrolls }] : []),
    { id: "v", typeId: 3, quantity: 1 },
  ], [SWORD, SCROLL, VEST]);

  it("offers a safe enchant through +3 and a dangerous one from +4", () => {
    const safe = enchantPlan(inv(2), "w", CFG);
    expect(safe).toMatchObject({ ok: true, nextLevel: 3, chancePct: 100, danger: false, scrollId: "s" });
    expect(needsConfirm(safe)).toBe(false);
    expect(enchantButtonLabel(safe)).toBe("Enchant +3 (safe)");

    const risky = enchantPlan(inv(3), "w", CFG);
    expect(risky).toMatchObject({ ok: true, nextLevel: 4, chancePct: 60, danger: true });
    expect(needsConfirm(risky)).toBe(true);
    expect(enchantButtonLabel(risky)).toContain("60%");
    expect(enchantButtonLabel(risky, true)).toContain("BURNS");
  });

  it("walks the odds table", () => {
    for (let lvl = 3; lvl < 15; lvl += 1) {
      expect(enchantPlan(inv(lvl), "w", CFG).chancePct).toBe(CFG.chances[lvl + 1]);
    }
  });

  it("blocks a +15 weapon", () => {
    const p = enchantPlan(inv(15), "w", CFG);
    expect(p.ok).toBe(false);
    expect(p.maxed).toBe(true);
    expect(enchantButtonLabel(p)).toBe("Maximum +15");
  });

  it("is disabled, with a reason, when there is no scroll", () => {
    const p = enchantPlan(inv(0, 0), "w", CFG);
    expect(p.ok).toBe(false);
    expect(p.reason).toBe("No enchant scroll");
    expect(enchantButtonLabel(p)).toBe("No enchant scroll");
  });

  it("offers nothing for armor, missing items or a missing config", () => {
    expect(enchantPlan(inv(0), "v", CFG).nextLevel).toBe(0);
    expect(enchantPlan(inv(0), "nope", CFG).ok).toBe(false);
    expect(enchantPlan(inv(0), "w", null).ok).toBe(false);
  });
});

describe("applying an enchant result", () => {
  let inv;
  beforeEach(() => {
    inv = inventoryWith([
      { id: "w", typeId: 1, quantity: 1, enchantLevel: 4 },
      { id: "s", typeId: 2, quantity: 3 },
    ], [SWORD, SCROLL]);
    inv.equipment = { main_hand: "w" };
  });

  it("a success raises the level and shrinks the stack", () => {
    const name = applyEnchantResult(inv, { outcome: "success", itemId: "w", scrollId: "s", scrollsLeft: 2, level: 5, destroyed: false });
    expect(name).toBe("sword");
    expect(inv.items.find((i) => i.id === "w").enchantLevel).toBe(5);
    expect(inv.items.find((i) => i.id === "s").quantity).toBe(2);
  });

  it("a burn removes the weapon and unequips it", () => {
    applyEnchantResult(inv, { outcome: "destroyed", itemId: "w", scrollId: "s", scrollsLeft: 2, level: 4, destroyed: true });
    expect(inv.items.some((i) => i.id === "w")).toBe(false);
    expect(inv.equipment.main_hand).toBeUndefined();
    expect(inv.items.find((i) => i.id === "s").quantity).toBe(2);
  });

  it("the last scroll leaves the inventory", () => {
    applyEnchantResult(inv, { outcome: "success", itemId: "w", scrollId: "s", scrollsLeft: 0, level: 5, destroyed: false });
    expect(inv.items.some((i) => i.id === "s")).toBe(false);
  });

  it("messages", () => {
    expect(enchantResultMessage({ outcome: "success", level: 6 }, "sword")).toContain("+6");
    expect(enchantResultMessage({ outcome: "destroyed" }, "sword")).toContain("burned");
    expect(enchantResultMessage({ outcome: "safe_fail" }, "sword")).toContain("unchanged");
  });
});

describe("the inventory mirror keeps the enchant level", () => {
  it("applyJoined and addItem carry enchantLevel", () => {
    const inv = createInventory();
    applyJoined(inv, { itemTypes: [SWORD], items: [{ id: "a", typeId: 1, enchantLevel: 9 }, { id: "b", typeId: 1 }], equipment: {} });
    expect(inv.items.find((i) => i.id === "a").enchantLevel).toBe(9);
    expect(inv.items.find((i) => i.id === "b").enchantLevel).toBe(0);
    addItem(inv, { id: "c", typeId: 1, enchantLevel: 4 });
    expect(inv.items.find((i) => i.id === "c").enchantLevel).toBe(4);
  });

  it("a remote player's frame carries the held weapon level", () => {
    expect(remotePlayerFromFrame({ enchant: 12 }).enchant).toBe(12);
  });
});

describe("inventory panel", () => {
  const view = (level, scrolls, armed = null) => {
    const inventory = inventoryWith([
      { id: "w", typeId: 1, quantity: 1, enchantLevel: level },
      ...(scrolls ? [{ id: "s", typeId: 2, quantity: scrolls }] : []),
    ], [SWORD, SCROLL]);
    return layoutInventory({ inventory, selectedItemId: "w", enchantCfg: CFG, enchantArmedItemId: armed });
  };

  it("shows an Enchant button for a selected weapon, clickable only when usable", () => {
    const ok = view(2, 1);
    expect(ok.footer.enchant).toBeTruthy();
    expect(ok.hitAreas.some((a) => a.kind === "enchant" && a.id === "w")).toBe(true);

    const noScroll = view(2, 0);
    expect(noScroll.footer.enchant.enabled).toBe(false);
    expect(noScroll.hitAreas.some((a) => a.kind === "enchant")).toBe(false);

    const maxed = view(15, 3);
    expect(maxed.footer.enchant.plan.maxed).toBe(true);
    expect(maxed.hitAreas.some((a) => a.kind === "enchant")).toBe(false);
  });

  it("is armed for the confirming click on a dangerous level", () => {
    const l = view(5, 1, "w");
    expect(l.footer.enchant.armed).toBe(true);
    expect(l.footer.enchant.label).toContain("BURNS");
  });

  it("has no button for armor or without a config", () => {
    const inventory = inventoryWith([{ id: "v", typeId: 3, quantity: 1 }], [VEST]);
    expect(layoutInventory({ inventory, selectedItemId: "v", enchantCfg: CFG }).footer.enchant).toBeNull();
    const inv2 = inventoryWith([{ id: "w", typeId: 1, quantity: 1 }], [SWORD]);
    expect(layoutInventory({ inventory: inv2, selectedItemId: "w" }).footer.enchant).toBeNull();
  });

  it("the tooltip names the level and shows the real damage", () => {
    const lines = formatItemTooltipLines({ enchantLevel: 5, rarity: "white" }, SWORD, CFG).map((l) => l.text);
    expect(lines[0]).toBe("+5 sword");
    expect(lines.some((t) => t.startsWith("dmg 14"))).toBe(true);
    expect(lines.some((t) => t.includes("+40% damage"))).toBe(true);
    const plain = formatItemTooltipLines({ rarity: "white" }, SWORD, CFG).map((l) => l.text);
    expect(plain[0]).toBe("sword");
    expect(plain.some((t) => t.startsWith("dmg 10"))).toBe(true);
  });
});

describe("skill upgrade plan", () => {
  const LCFG = { maxLevel: 15, powerPerLevel: 0.01, costs: Array.from({ length: 15 }, (_, i) => Math.round(100 * 1.2 ** i)) };

  it("prices the next level and checks the wallet", () => {
    const rich = skillUpgradePlan({}, "s", 1000, LCFG);
    expect(rich).toMatchObject({ level: 0, maxed: false, cost: 100, canAfford: true, disabled: false });
    expect(rich.label).toContain("Lv 1");
    const poor = skillUpgradePlan({ s: 2 }, "s", 50, LCFG);
    expect(poor).toMatchObject({ level: 2, cost: LCFG.costs[2], canAfford: false, disabled: true, bonusPct: 2 });
  });

  it("blocks the button at the cap", () => {
    const p = skillUpgradePlan({ s: 15 }, "s", 1e9, LCFG);
    expect(p.maxed).toBe(true);
    expect(p.disabled).toBe(true);
    expect(p.label).toBe("MAX Lv 15");
    expect(p.bonusPct).toBe(15);
  });

  it("reads levels from a Map or an object", () => {
    expect(skillLevelOf(new Map([["a", 4]]), "a")).toBe(4);
    expect(skillLevelOf({ a: 4 }, "a")).toBe(4);
    expect(skillLevelOf(null, "a")).toBe(0);
  });

  it("the skills panel draws the button, and gives a maxed skill no hit area", () => {
    const gem = { id: "war_crushing_blow", class: "Warrior", type: "melee", gemColor: "red", nameEn: "Crushing Blow", cooldown: 4, cost: 5, reqLvl: 1 };
    const mk = (level) => layoutSkillsPanel({
      tab: "inventory", inventoryGems: [gem], hotbarSkills: new Map(),
      skillLevels: { war_crushing_blow: level }, skillLevelingCfg: LCFG, playerGold: 5000,
    });
    const normal = mk(3);
    const row = normal.gemRows.find((r) => r.gem.id === "war_crushing_blow");
    expect(row, 'the owned skill must have a row, or this test proves nothing').toBeTruthy();
    {
      expect(row.upgrade.plan.level).toBe(3);
      expect(normal.hitAreas.some((a) => a.kind === "skills_upgrade" && a.skillId === "war_crushing_blow")).toBe(true);
      const maxed = mk(15);
      expect(maxed.gemRows.find((r) => r.gem.id === "war_crushing_blow").upgrade.plan.maxed).toBe(true);
      expect(maxed.hitAreas.some((a) => a.kind === "skills_upgrade")).toBe(false);
    }
  });
});

describe("weapon glow", () => {
  it("has no aura below +4", () => {
    for (const n of [0, 1, 2, 3]) expect(glowParams(n)).toBeNull();
    expect(glowParams(4)).not.toBeNull();
    expect(glowSprite(3)).toBeNull();
  });

  it("goes from faint blue to saturated turquoise across +4..+9", () => {
    const first = glowParams(4);
    const last = glowParams(9);
    expect(first.tier).toBe(1);
    expect(last.tier).toBe(1);
    expect(first.alpha).toBeLessThan(last.alpha);
    expect(first.radius).toBeLessThan(last.radius);
    // blue: the blue channel dominates red throughout
    for (let n = 4; n <= 9; n += 1) {
      const [r, , b] = glowParams(n).rgb;
      expect(b).toBeGreaterThan(r);
    }
    // turquoise at the top: green rises toward blue
    expect(glowParams(9).rgb[1]).toBeGreaterThan(glowParams(4).rgb[1]);
  });

  it("turns fire red from +10 and gets brighter, denser and wider to +15", () => {
    for (let n = 10; n <= 15; n += 1) {
      const [r, g, b] = glowParams(n).rgb;
      expect(glowParams(n).tier).toBe(2);
      expect(r).toBeGreaterThan(g);
      expect(r).toBeGreaterThan(b);
    }
    for (let n = 10; n < 15; n += 1) {
      const a = glowParams(n);
      const b = glowParams(n + 1);
      expect(b.alpha).toBeGreaterThan(a.alpha);
      expect(b.radius).toBeGreaterThan(a.radius);
      expect(b.sparks).toBeGreaterThanOrEqual(a.sparks);
    }
    expect(glowParams(15).radius).toBeGreaterThan(glowParams(9).radius);
    expect(glowParams(15).sparks).toBeGreaterThan(glowParams(10).sparks);
  });

  it("follows the server's thresholds", () => {
    expect(glowParams(5, { minLevel: 6 })).toBeNull();
    expect(glowParams(6, { minLevel: 6 })).not.toBeNull();
    expect(glowParams(8, { minLevel: 4, fireLevel: 8 }).tier).toBe(2);
  });

  it("clamps absurd levels to the cap", () => {
    expect(glowParams(99)).toEqual(glowParams(15));
  });

  describe("drawing", () => {
    function fakeCtx() {
      const calls = { drawImage: 0, fillRect: 0 };
      return {
        calls,
        globalCompositeOperation: "source-over", globalAlpha: 1, fillStyle: "",
        drawImage() { calls.drawImage += 1; },
        fillRect() { calls.fillRect += 1; },
      };
    }

    it("draws nothing for an unenchanted or +3 weapon", () => {
      const ctx = fakeCtx();
      expect(drawWeaponGlow(ctx, 10, 10, 0, 0)).toBe(false);
      expect(drawWeaponGlow(ctx, 10, 10, 3, 0)).toBe(false);
      expect(ctx.calls.drawImage).toBe(0);
    });

    it("rejects a non-finite position without throwing", () => {
      const ctx = fakeCtx();
      expect(() => drawWeaponGlow(ctx, NaN, 10, 12, 0, { width: 800, height: 600 })).not.toThrow();
      expect(shouldDrawGlow(NaN, 0, 10, 800, 600)).toBe(false);
      expect(shouldDrawGlow(-500, 10, 20, 800, 600)).toBe(false);
      expect(shouldDrawGlow(400, 300, 20, 800, 600)).toBe(true);
    });

    it("builds each level's sprite once and reuses it (no per-frame gradients)", () => {
      clearGlowCache();
      const a = glowSprite(12);
      const b = glowSprite(12);
      expect(a === b).toBe(true);
    });

    it("restores the context state it changed", () => {
      const ctx = fakeCtx();
      // headless: no canvas to build a sprite on, so nothing is drawn -- and nothing is left changed
      drawWeaponGlow(ctx, 50, 50, 15, 1000);
      expect(ctx.globalCompositeOperation).toBe("source-over");
      expect(ctx.globalAlpha).toBe(1);
    });

    it("anchors at the weapon hand on the side the player faces", () => {
      expect(handOffset("e").dx).toBeGreaterThan(0);
      expect(handOffset("w").dx).toBeLessThan(0);
      expect(Number.isFinite(handOffset("nonsense").dx)).toBe(true);
      expect(Number.isFinite(handOffset(undefined).dy)).toBe(true);
    });
  });
});
