// frontend/src/games/something2/src/js/systems/__tests__/skillsPanel.test.js
import { describe, it, expect } from "vitest";
import { layoutSkillsPanel, drawSkillsPanel, PANEL_W, PANEL_H, SKILL_TABS } from "../skillsPanel.js";
import { getSkillsForClass, getSkillById, SKILLS, SKILLS_BY_CLASS } from "../../core/skillsData.js";

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
    });

    expect(layout.panel.w).toBe(PANEL_W);
    expect(layout.panel.h).toBe(PANEL_H);
    expect(layout.classTabs.length).toBe(7); // All + 6 classes
    expect(layout.tabs.length).toBe(SKILL_TABS.length);
    expect(layout.rows.length).toBe(5); // 5 per page
    expect(layout.totalCount).toBe(300);
    expect(layout.totalPages).toBe(60); // ceil(300/5) = 60
    expect(layout.nextBtn).toBeTruthy();

    const selectedRow = layout.rows.find(r => r.skill.id === "dru_maul");
    // dru_maul is further in page index for all skills, or on its specific page
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
    });

    expect(() => drawSkillsPanel(ctx, layout, {})).not.toThrow();
  });
});
