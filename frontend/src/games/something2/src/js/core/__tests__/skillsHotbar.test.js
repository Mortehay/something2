// frontend/src/games/something2/src/js/core/__tests__/skillsHotbar.test.js
import { describe, it, expect, beforeEach } from "vitest";
import { Game } from "../Game.js";
import { getSkillById } from "../skillsData.js";

function makeTestGame() {
  const canvas = {
    width: 800,
    height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const g = new Game(canvas);
  g.setupInput();
  g.state = "playing";
  g.chunked = true;
  g.player = { x: 100, y: 100, width: 32, height: 32, hp: 100, maxHp: 100, className: "Warrior" };
  g.playerClass = "Warrior";
  return g;
}

describe("Skills Panel & Hotbar Interactions", () => {
  let g;

  beforeEach(() => {
    g = makeTestGame();
  });

  it("toggles skills window when pressing 'k'", () => {
    expect(g.skillsOpen).toBe(false);
    g._keydownHandler({ key: "k", code: "KeyK", repeat: false });
    expect(g.skillsOpen).toBe(true);
    g._keydownHandler({ key: "k", code: "KeyK", repeat: false });
    expect(g.skillsOpen).toBe(false);
  });

  it("closes skills window when pressing Escape", () => {
    g.skillsOpen = true;
    g._keydownHandler({ key: "Escape", code: "Escape", repeat: false, preventDefault: () => {} });
    expect(g.skillsOpen).toBe(false);
  });

  it("binds a selected skill to slot 1-9 when pressing the corresponding hotkey", () => {
    g.skillsOpen = true;
    g.selectedSkillId = "war_crushing_blow";
    
    // Press '1'
    g._keydownHandler({ key: "1", code: "Digit1", repeat: false, preventDefault: () => {} });
    
    const slot1Skill = g.hotbarSkills.get(1);
    expect(slot1Skill).toBeDefined();
    expect(slot1Skill.id).toBe("war_crushing_blow");
    expect(slot1Skill.nameUk).toBe("Нищівний удар");

    // Press '3' with another skill
    g.selectedSkillId = "war_whirlwind";
    g._keydownHandler({ key: "3", code: "Digit3", repeat: false, preventDefault: () => {} });
    const slot3Skill = g.hotbarSkills.get(3);
    expect(slot3Skill).toBeDefined();
    expect(slot3Skill.id).toBe("war_whirlwind");
  });

  it("opens skills panel if an empty hotbar key is pressed while playing", () => {
    expect(g.skillsOpen).toBe(false);
    g.hotbarSkills.clear();
    
    // Press slot '5' which is empty
    g._keydownHandler({ key: "5", code: "Digit5", repeat: false, preventDefault: () => {} });
    expect(g.skillsOpen).toBe(true);
  });

  it("supports drag and drop assignment from skills panel to hotbar slot", () => {
    const skill = getSkillById("war_shield_slam");
    expect(skill).toBeDefined();

    // Start drag
    g.skillsOpen = true;
    g.skillDrag = {
      skillId: "war_shield_slam",
      skill,
      x: 100, y: 100,
      startX: 100, startY: 100,
      armed: true,
      targetSlot: 2,
    };

    // Simulate mouse up over slot 2
    g._mouseUpHandler({ button: 0 });
    
    expect(g.hotbarSkills.get(2)).toBeDefined();
    expect(g.hotbarSkills.get(2).id).toBe("war_shield_slam");
    expect(g.skillDrag).toBeNull();
  });

  it("blocks non-Druid classes from activating Druid transformations or form skills", () => {
    let lastToast = null;
    g.showToast = (msg) => { lastToast = msg; };
    g.className = "Warrior";
    g.player.className = "Warrior";

    g.hotbarSkills.set(1, getSkillById("dru_bear_form"));
    g._keydownHandler({ key: "1", code: "Digit1", repeat: false, preventDefault: () => {} });
    expect(lastToast).toContain("Exclusive to Druid class");
    expect(g.activeForm).toBeNull();

    g.hotbarSkills.set(2, getSkillById("dru_maul"));
    g._keydownHandler({ key: "2", code: "Digit2", repeat: false, preventDefault: () => {} });
    expect(lastToast).toContain("Exclusive to Druid class");
  });

  it("handles Druid transformation toggling into Bear form and back to normal form for Druid", () => {
    let lastToast = null;
    g.showToast = (msg) => { lastToast = msg; };
    g.className = "Druid";
    g.player.className = "Druid";

    g.hotbarSkills.set(1, getSkillById("dru_bear_form"));
    expect(g.activeForm).toBeNull();

    // 1. Enter Bear Form
    g._keydownHandler({ key: "1", code: "Digit1", repeat: false, preventDefault: () => {} });
    expect(g.activeForm).toBe("bear");
    expect(lastToast).toContain("Transformed into BEAR Form");
    expect(g.blasts.length).toBeGreaterThan(0);
    expect(g.hotbarFlashSlot).toBe(1);

    // 2. Exit Bear Form
    g._keydownHandler({ key: "1", code: "Digit1", repeat: false, preventDefault: () => {} });
    expect(g.activeForm).toBeNull();
    expect(lastToast).toContain("Exited BEAR Form");
  });

  it("enforces form requirements: prevents casting Bear Maul unless in Bear form", () => {
    let lastToast = null;
    g.showToast = (msg) => { lastToast = msg; };
    g.className = "Druid";
    g.player.className = "Druid";

    g.hotbarSkills.set(2, getSkillById("dru_maul"));
    g.activeForm = null;

    // Try to cast Bear Maul in normal form
    g._keydownHandler({ key: "2", code: "Digit2", repeat: false, preventDefault: () => {} });
    expect(lastToast).toContain("Requires BEAR Form");

    // Transform into Bear form
    g.activeForm = "bear";
    g._keydownHandler({ key: "2", code: "Digit2", repeat: false, preventDefault: () => {} });
    expect(lastToast).toContain("Cast: Bear Maul");
    expect(g.blasts.length).toBeGreaterThan(0);
  });

  it("allows casting non-form Druid spells in normal human form", () => {
    let lastToast = null;
    g.showToast = (msg) => { lastToast = msg; };

    g.hotbarSkills.set(3, getSkillById("dru_entangling_roots"));
    g.activeForm = null;

    g._keydownHandler({ key: "3", code: "Digit3", repeat: false, preventDefault: () => {} });
    expect(lastToast).toContain("Cast: Entangling Roots");
    expect(g.blasts.length).toBeGreaterThan(0);
  });

  it("spends mana when casting a spell and prevents casting when insufficient mana", () => {
    let lastToast = null;
    g.showToast = (msg) => { lastToast = msg; };
    g.localMana = 30;

    const spell = getSkillById("dru_entangling_roots"); // cost: 25 mana
    g.hotbarSkills.set(3, spell);

    // Cast 1st time (30 - 25 = 5 mana remaining)
    g._keydownHandler({ key: "3", code: "Digit3", repeat: false, preventDefault: () => {} });
    expect(g.localMana).toBe(5);
    expect(lastToast).toContain("Cast: Entangling Roots");

    // Clear cooldown to test mana check directly
    g.skillCooldowns.clear();

    // Cast 2nd time with only 5 mana (requires 25)
    g._keydownHandler({ key: "3", code: "Digit3", repeat: false, preventDefault: () => {} });
    expect(g.localMana).toBe(5);
    expect(lastToast).toContain("Not enough Mana");
  });

  it("enforces skill cooldowns and prevents casting until cooldown expires", () => {
    let lastToast = null;
    g.showToast = (msg) => { lastToast = msg; };
    g.localMana = 100;

    const spell = getSkillById("dru_entangling_roots");
    g.hotbarSkills.set(3, spell);

    // Cast 1st time
    g._keydownHandler({ key: "3", code: "Digit3", repeat: false, preventDefault: () => {} });
    expect(lastToast).toContain("Cast: Entangling Roots");
    expect(g.skillCooldowns.has("dru_entangling_roots")).toBe(true);

    // Immediate 2nd cast triggers cooldown warning
    g._keydownHandler({ key: "3", code: "Digit3", repeat: false, preventDefault: () => {} });
    expect(lastToast).toContain("on cooldown");
  });

  it("dispatches server attack for offensive skills", () => {
    const sent = [];
    g.authorityClient = { sendAttack: (nx, ny) => sent.push({ nx, ny }) };
    g.camera = { screenX: () => 0, screenY: () => 0 };
    g.localMana = 100;

    const spell = getSkillById("dru_entangling_roots");
    g.hotbarSkills.set(3, spell);

    g._keydownHandler({ key: "3", code: "Digit3", repeat: false, preventDefault: () => {} });
    expect(sent.length).toBe(1);
  });
});
