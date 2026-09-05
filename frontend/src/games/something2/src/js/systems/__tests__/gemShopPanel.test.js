// frontend/src/games/something2/src/js/systems/__tests__/gemShopPanel.test.js
import { describe, it, expect } from "vitest";
import { layoutGemShopPanel, drawGemShopPanel, GEM_SHOP_W, GEM_SHOP_H, GEM_COLOR_TABS } from "../gemShopPanel.js";
import {
  SKILLS, getSkillById, checkGemRequirements,
  getWeaponCategory, isWeaponCompatible,
} from "../../core/skillsData.js";

describe("PoE Skill Gems Data & Requirements", () => {
  it("enriches all 300 skills with PoE Gem attributes (gemColor, reqLvl, reqStr, reqDex, reqCon, reqInt, reqWis, reqCha, reqWeapon, gemPrice)", () => {
    expect(SKILLS.length).toBe(300);
    const classCounters = {};
    for (const gem of SKILLS) {
      classCounters[gem.class] = (classCounters[gem.class] || 0) + 1;
      const idx = classCounters[gem.class];

      expect(gem.isGem).toBe(true);
      expect(["red", "green", "blue", "purple", "orange", "hybrid"]).toContain(gem.gemColor);
      expect(gem.reqLvl).toBeGreaterThanOrEqual(1);
      expect(typeof gem.reqStr).toBe("number");
      expect(typeof gem.reqDex).toBe("number");
      expect(typeof gem.reqCon).toBe("number");
      expect(typeof gem.reqInt).toBe("number");
      expect(typeof gem.reqWis).toBe("number");
      expect(typeof gem.reqCha).toBe("number");
      if (idx === 1) {
        expect(gem.gemPrice).toBe(30);
      } else {
        expect(gem.gemPrice).toBeGreaterThanOrEqual(250);
      }
      expect(gem.reqWeapon).toBeDefined();
    }
  });

  it("checks weapon category resolution and compatibility", () => {
    const bowItem = { id: "item_bow", name: "Shortbow", category: "weapon", kind: "projectile", ammo_type_id: 101 };
    const daggerItem = { id: "item_dagger", name: "Steel Dagger", category: "weapon", kind: "melee" };
    const wandItem = { id: "item_wand", name: "Novice Wand", category: "weapon", kind: "projectile" };

    expect(getWeaponCategory(bowItem)).toBe("bow");
    expect(getWeaponCategory(daggerItem)).toBe("dagger");
    expect(getWeaponCategory(wandItem)).toBe("staff_wand");
    expect(getWeaponCategory(null)).toBe("unarmed");

    // Bow skills require bows
    expect(isWeaponCompatible("bow", "bow")).toBe(true);
    expect(isWeaponCompatible("bow", "melee")).toBe(false);

    // Melee skills require melee weapons
    expect(isWeaponCompatible("melee", "melee")).toBe(true);
    expect(isWeaponCompatible("melee", "bow")).toBe(false);

    // Any skills accept any weapon
    expect(isWeaponCompatible("any", "melee")).toBe(true);
    expect(isWeaponCompatible("any", "bow")).toBe(true);
    expect(isWeaponCompatible("any", "unarmed")).toBe(true);
  });

  it("evaluates checkGemRequirements across all 6 stats (STR, DEX, CON, INT, WIS, CHA)", () => {
    const gem = getSkillById("arc_barrage"); // Archer skill: requires bow, dex, wis, con, level
    expect(gem).toBeDefined();

    // 1. Incompatible weapon (dagger) -> fails weapon requirement
    const dagger = { id: "item_dagger", name: "dagger", category: "weapon", kind: "melee" };
    const req1 = checkGemRequirements(gem, { level: 20, dex: 50, wis: 50, con: 50, str: 20, int: 20, cha: 20 }, dagger);
    expect(req1.ok).toBe(false);
    expect(req1.weaponOk).toBe(false);
    expect(req1.errors[0]).toContain("Requires Bow");

    // 2. Compatible weapon (bow), but level too low
    const bow = { id: "item_bow", name: "bow", category: "weapon", kind: "projectile", ammo_type_id: 101 };
    const req2 = checkGemRequirements(gem, { level: 0, dex: 100, wis: 100, con: 100, str: 20, int: 20, cha: 20 }, bow);
    expect(req2.ok).toBe(false);
    expect(req2.levelOk).toBe(false);

    // 3. Compatible weapon (bow), high level, high stats across all 6 attributes -> passes all requirements
    const req3 = checkGemRequirements(gem, { level: 50, dex: 200, wis: 150, con: 150, str: 100, int: 100, cha: 100 }, bow);
    expect(req3.ok).toBe(true);
    expect(req3.weaponOk).toBe(true);
    expect(req3.levelOk).toBe(true);
    expect(req3.strOk).toBe(true);
    expect(req3.dexOk).toBe(true);
    expect(req3.conOk).toBe(true);
    expect(req3.intOk).toBe(true);
    expect(req3.wisOk).toBe(true);
    expect(req3.chaOk).toBe(true);
  });
});

describe("Skill Gem Merchant Panel Layout & Render", () => {
  it("creates gem shop layout with 6-attribute tabs, class tabs, rows, and buy buttons", () => {
    const layout = layoutGemShopPanel({
      colorFilter: "all",
      classFilter: "all",
      page: 0,
      playerGold: 100,
      playerStats: { level: 10, str: 25, dex: 25, con: 25, int: 25, wis: 25, cha: 25 },
      equippedWeapon: null,
    });

    expect(layout.panel.w).toBe(GEM_SHOP_W);
    expect(layout.panel.h).toBe(GEM_SHOP_H);
    expect(layout.colorTabs.length).toBe(GEM_COLOR_TABS.length);
    expect(layout.rows.length).toBe(5);
    expect(layout.totalCount).toBe(300);
    expect(layout.rows[0].buyBtn).toBeDefined();
    expect(layout.rows[0].buyBtn.canAfford).toBe(true);
  });

  it("filters gem shop by all 6 attributes (STR, DEX, CON, INT, WIS, CHA)", () => {
    const strLayout = layoutGemShopPanel({ colorFilter: "str", classFilter: "all", page: 0, playerGold: 500 });
    expect(strLayout.rows.every(r => r.gem.reqStr > 0)).toBe(true);

    const dexLayout = layoutGemShopPanel({ colorFilter: "dex", classFilter: "all", page: 0, playerGold: 500 });
    expect(dexLayout.rows.every(r => r.gem.reqDex > 0)).toBe(true);

    const conLayout = layoutGemShopPanel({ colorFilter: "con", classFilter: "all", page: 0, playerGold: 500 });
    expect(conLayout.rows.every(r => r.gem.reqCon > 0)).toBe(true);

    const intLayout = layoutGemShopPanel({ colorFilter: "int", classFilter: "all", page: 0, playerGold: 500 });
    expect(intLayout.rows.every(r => r.gem.reqInt > 0)).toBe(true);

    const wisLayout = layoutGemShopPanel({ colorFilter: "wis", classFilter: "all", page: 0, playerGold: 500 });
    expect(wisLayout.rows.every(r => r.gem.reqWis > 0)).toBe(true);

    const chaLayout = layoutGemShopPanel({ colorFilter: "cha", classFilter: "all", page: 0, playerGold: 500 });
    expect(chaLayout.rows.every(r => r.gem.reqCha > 0)).toBe(true);
  });

  it("disables buy button when player does not have enough gold", () => {
    const brokeLayout = layoutGemShopPanel({
      colorFilter: "all",
      classFilter: "all",
      page: 0,
      playerGold: 5, // Not enough for 25g+ gems
    });

    expect(brokeLayout.rows.every(r => r.canAfford === false)).toBe(true);
    expect(brokeLayout.rows.every(r => r.buyBtn.canAfford === false)).toBe(true);
  });

  it("ensures Buy button hitArea takes precedence over row item click", () => {
    const layout = layoutGemShopPanel({
      colorFilter: "all",
      classFilter: "all",
      page: 0,
      playerGold: 500,
    });

    const firstRow = layout.rows[0];
    const buyBtnBox = firstRow.buyBtn;
    const clickX = buyBtnBox.x + buyBtnBox.w / 2;
    const clickY = buyBtnBox.y + buyBtnBox.h / 2;

    const hit = layout.hitAreas.find(
      a => clickX >= a.box.x && clickX <= a.box.x + a.box.w && clickY >= a.box.y && clickY <= a.box.y + a.box.h
    );

    expect(hit).toBeDefined();
    expect(hit.kind).toBe("gem_shop_buy");
    expect(hit.gemId).toBe(firstRow.gem.id);
  });
});

