// frontend/src/games/something2/src/js/systems/__tests__/skillsPanel.test.js
import { describe, it, expect } from "vitest";
import { layoutSkillsPanel, drawSkillsPanel, PANEL_W, PANEL_H, SKILL_TABS } from "../skillsPanel.js";
import {
  getSkillsForClass, getSkillById, getSkillPrice, getSkillTier,
  getSkillTierName, getSkillLevelReq, SKILLS, SKILLS_BY_CLASS
} from "../../core/skillsData.js";

describe("Skills Catalog Data (300 skills total)", () => {
  it("contains exactly 300 skills across all 6 classes (50 each)", () => {
    expect(SKILLS.length).toBe(300);
    const classes = ["Warrior", "Mage", "Monk", "Cultist", "Archer", "Druid"];
    for (const c of classes) {
      const classSkills = getSkillsForClass(c);
      expect(classSkills.length, `${c} should have 50 skills`).toBe(50);
    }
  });

  it("ensures every skill has unique ID, nameUk, nameEn, type, and valid costType", () => {
    const ids = new Set();
    const validTypes = new Set(["melee", "magic", "buff", "debuff"]);
    const validCostTypes = new Set(["mana", "stamina", "hp"]);

    for (const s of SKILLS) {
      expect(ids.has(s.id), `Duplicate skill id: ${s.id}`).toBe(false);
      ids.add(s.id);
      expect(s.nameUk.length).toBeGreaterThan(0);
      expect(s.nameEn.length).toBeGreaterThan(0);
      expect(validTypes.has(s.type), `Invalid skill type: ${s.type}`).toBe(true);
      expect(validCostTypes.has(s.costType), `Invalid costType: ${s.costType}`).toBe(true);
    }
  });

  it("scales skill prices from 250 gold (first skill) up to 10,000 gold (last skill) per class", () => {
    const classes = ["Warrior", "Mage", "Monk", "Cultist", "Archer", "Druid"];
    for (const c of classes) {
      const classSkills = getSkillsForClass(c);
      const firstSkill = classSkills[0];
      const lastSkill = classSkills[classSkills.length - 1];

      expect(getSkillPrice(firstSkill)).toBe(250);
      expect(getSkillPrice(lastSkill)).toBe(10000);
      expect(firstSkill.price).toBe(250);
      expect(lastSkill.price).toBe(10000);

      // Verify prices strictly increase
      for (let i = 1; i < classSkills.length; i++) {
        expect(getSkillPrice(classSkills[i])).toBeGreaterThanOrEqual(getSkillPrice(classSkills[i - 1]));
      }
    }
  });

  it("assigns progressive levels (1 to 50) and tiers (1 to 5) across class skills", () => {
    const classes = ["Warrior", "Mage", "Monk", "Cultist", "Archer", "Druid"];
    for (const c of classes) {
      const classSkills = getSkillsForClass(c);
      expect(getSkillLevelReq(classSkills[0])).toBe(1);
      expect(getSkillLevelReq(classSkills[classSkills.length - 1])).toBe(50);
      expect(getSkillTier(classSkills[0])).toBe(1);
      expect(getSkillTier(classSkills[classSkills.length - 1])).toBe(5);
      expect(getSkillTierName(1)).toBe("Novice");
      expect(getSkillTierName(5)).toBe("Grandmaster");
    }
  });

  it("checks Druid transformations include Bear, Hawk, and Wolf forms", () => {
    const druidSkills = getSkillsForClass("Druid");
    const formSkills = druidSkills.filter(s => s.id.includes("form"));
    const formIds = formSkills.map(s => s.id);
    expect(formIds).toContain("dru_bear_form");
    expect(formIds).toContain("dru_hawk_form");
    expect(formIds).toContain("dru_wolf_form");
  });
});

describe("Skills Panel Layout & Render", () => {
  it("creates a centered layout with class tabs, category tabs, rows, and pagination controls", () => {
    const layout = layoutSkillsPanel({
      className: "Druid",
      classFilter: "all",
      tab: "all",
      page: 0,
      selectedSkillId: "dru_maul",
      playerGold: 1000,
      playerLevel: 10,
      unlockedSkills: new Set(["dru_strike"]),
    });

    expect(layout.panel.w).toBe(PANEL_W);
    expect(layout.panel.h).toBe(PANEL_H);
    expect(layout.classTabs.length).toBe(7); // All + 6 classes
    expect(layout.tabs.length).toBe(SKILL_TABS.length);
    expect(layout.rows.length).toBe(5); // 5 per page
    expect(layout.totalCount).toBe(300);
    expect(layout.totalPages).toBe(60); // ceil(300/5) = 60
    expect(layout.nextBtn).toBeTruthy();
    expect(layout.playerGold).toBe(1000);
    expect(layout.playerLevel).toBe(10);
  });

  it("creates buy buttons for locked skills and learned badges for unlocked skills", () => {
    const firstWarSkill = getSkillsForClass("Warrior")[0].id;
    const unlocked = new Set([firstWarSkill]);
    const layout = layoutSkillsPanel({
      className: "Warrior",
      classFilter: "Warrior",
      tab: "all",
      page: 0,
      playerGold: 500,
      playerLevel: 5,
      unlockedSkills: unlocked,
    });

    const unlockedRow = layout.rows.find(r => r.skill.id === firstWarSkill);
    expect(unlockedRow.isUnlocked).toBe(true);
    expect(unlockedRow.buyBtn).toBeNull();

    const lockedRow = layout.rows.find(r => !unlocked.has(r.skill.id));
    expect(lockedRow.isUnlocked).toBe(false);
    expect(lockedRow.buyBtn).toBeDefined();
    expect(lockedRow.buyBtn.price).toBeGreaterThanOrEqual(250);

    const buyHit = layout.hitAreas.find(h => h.kind === "skills_buy");
    expect(buyHit).toBeDefined();
    expect(buyHit.skillId).toBe(lockedRow.skill.id);
  });

  it("filters skills by class and tab category", () => {
    const meleeLayout = layoutSkillsPanel({
      className: "Warrior",
      classFilter: "Warrior",
      tab: "melee",
      page: 0,
    });
    expect(meleeLayout.totalCount).toBe(20);
    expect(meleeLayout.rows.every(r => r.skill.class === "Warrior" && r.skill.type === "melee")).toBe(true);

    const buffLayout = layoutSkillsPanel({
      className: "Mage",
      classFilter: "Mage",
      tab: "buff",
      page: 0,
    });
    expect(buffLayout.rows.every(r => r.skill.class === "Mage" && r.skill.type === "buff")).toBe(true);
  });

  it("renders without canvas errors", () => {
    const ctx = {
      save: () => {},
      restore: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      fillText: () => {},
      strokeText: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      stroke: () => {},
      fill: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      measureText: () => ({ width: 60 }),
    };

    const layout = layoutSkillsPanel({
      className: "Archer",
      tab: "all",
      page: 0,
      playerGold: 2000,
      playerLevel: 25,
      unlockedSkills: new Set(),
    });

    expect(() => drawSkillsPanel(ctx, layout, {})).not.toThrow();
  });
});
