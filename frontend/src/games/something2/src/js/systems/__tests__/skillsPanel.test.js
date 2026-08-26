// frontend/src/games/something2/src/js/systems/__tests__/skillsPanel.test.js
import { describe, it, expect } from "vitest";
import { layoutSkillsPanel, drawSkillsPanel, PANEL_W, PANEL_H, GEM_FILTER_TABS } from "../skillsPanel.js";
import { getSkillsForClass, getSkillById, SKILLS } from "../../core/skillsData.js";

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

describe("Skill Gem Socketing Board (Hotbar Sockets 1-9) Layout & Render", () => {
  it("creates a 9-socket board with 9 hotbar sockets and inventory gems", () => {
    const hotbar = new Map();
    const fireball = getSkillById("mag_fireball");
    hotbar.set(1, fireball);

    const invGems = [
      getSkillById("mag_fireball"),
      getSkillById("mag_frost_nova"),
      getSkillById("arc_barrage"),
    ];

    const layout = layoutSkillsPanel({
      tab: "inventory",
      page: 0,
      selectedSkillId: "mag_fireball",
      hotbarSkills: hotbar,
      inventoryGems: invGems,
      playerStats: { level: 20, str: 20, dex: 20, con: 20, int: 50, wis: 30, cha: 20 },
      equippedWeapon: { id: 1, name: "wand", category: "weapon", kind: "projectile" },
    });

    expect(layout.panel.w).toBe(PANEL_W);
    expect(layout.panel.h).toBe(PANEL_H);
    expect(layout.sockets.length).toBe(9); // Sockets 1..9
    expect(layout.sockets[0].gem).toBe(fireball);
    expect(layout.sockets[0].unsocketBtn).toBeDefined();
    expect(layout.sockets[1].gem).toBeNull(); // Socket 2 is empty

    expect(layout.tabs.length).toBe(GEM_FILTER_TABS.length);
    expect(layout.gemRows.length).toBe(3); // 3 inventory gems visible
    expect(layout.gemRows[0].quickButtons.length).toBe(9); // Quick buttons for slots 1-9
    expect(layout.gemRows[0].socketedInSlot).toBe(1);
  });

  it("filters gems in catalog by attribute tabs (STR, DEX, CON, INT, WIS, CHA)", () => {
    const strLayout = layoutSkillsPanel({
      tab: "str",
      page: 0,
    });
    expect(strLayout.totalCount).toBeGreaterThan(0);
    expect(strLayout.gemRows.every(r => r.gem.reqStr > 0)).toBe(true);

    const intLayout = layoutSkillsPanel({
      tab: "int",
      page: 0,
    });
    expect(intLayout.totalCount).toBeGreaterThan(0);
    expect(intLayout.gemRows.every(r => r.gem.reqInt > 0)).toBe(true);
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
      setLineDash: () => {},
    };

    const layout = layoutSkillsPanel({
      tab: "all",
      page: 0,
      hotbarSkills: new Map([[1, getSkillById("mag_fireball")]]),
    });

    expect(() => drawSkillsPanel(ctx, layout, {})).not.toThrow();
  });
});
