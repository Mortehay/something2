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

  it("does not bind skills by clicking or pressing hotkeys; requires drag and drop assignment", () => {
    g.skillsOpen = true;
    g.selectedSkillId = "war_crushing_blow";
    
    // Press '1' while skills panel is open should NOT bind the skill to slot 1
    g._keydownHandler({ key: "1", code: "Digit1", repeat: false, preventDefault: () => {} });
    expect(g.hotbarSkills.get(1)).toBeUndefined();

    // Clicking slot 1 directly while a skill was selected in the panel should NOT bind it
    g.renderSystem = { _skillSlotHitAreas: [{ slot: 1, box: { x: 50, y: 50, w: 40, h: 40 } }] };
    g._cursorX = 60;
    g._cursorY = 60;
    g._mouseDownHandler({ button: 0 });
    expect(g.hotbarSkills.get(1)).toBeUndefined();
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

  it("dispatches server skill cast for offensive skills", () => {
    const sent = [];
    g.authorityClient = { sendCastSkill: (skillId, tx, ty, nx, ny) => sent.push({ skillId, tx, ty, nx, ny }) };
    g.camera = { screenX: 0, screenY: 0 };
    g.localMana = 100;

    const spell = getSkillById("dru_entangling_roots");
    g.hotbarSkills.set(3, spell);

    g._keydownHandler({ key: "3", code: "Digit3", repeat: false, preventDefault: () => {} });
    expect(sent.length).toBe(1);
    expect(sent[0].skillId).toBe("dru_entangling_roots");
  });

  it("spawns distinct visual effects: Fireball launches projectile, Lightning strikes with branches", () => {
    g.localMana = 100;

    // 1. Cast Fireball
    const fireball = getSkillById("mag_fireball");
    expect(fireball).toBeDefined();
    g.hotbarSkills.set(1, fireball);
    g.skillVisuals = [];
    g._keydownHandler({ key: "1", code: "Digit1", repeat: false, preventDefault: () => {} });
    expect(g.skillVisuals.length).toBe(1);
    expect(g.skillVisuals[0].kind).toBe("projectile");
    expect(g.skillVisuals[0].element).toBe("fire");

    // 2. Cast Lightning
    const lightning = getSkillById("mag_chain_lightning") || getSkillById("dru_storm_lightning");
    expect(lightning).toBeDefined();
    g.skillCooldowns.clear();
    g.hotbarSkills.set(2, lightning);
    g.skillVisuals = [];
    g._keydownHandler({ key: "2", code: "Digit2", repeat: false, preventDefault: () => {} });
    expect(g.skillVisuals.length).toBe(1);
    expect(g.skillVisuals[0].kind).toBe("lightning");
    expect(g.skillVisuals[0].branches.length).toBeGreaterThan(0);
  });

  it("prevents casting skills across the entire screen and clamps to max range", () => {
    g.localMana = 100;
    g.player = { x: 100, y: 100, width: 32, height: 32, hp: 100, maxHp: 100, className: "Warrior" };

    // Set camera and cursor far away (across the screen)
    g.camera = { screenX: 0, screenY: 0 };
    g._cursorX = 1500;
    g._cursorY = 1500;

    const fireballSkill = getSkillById("mag_fireball"); // range: 250
    g.hotbarSkills.set(1, fireballSkill);
    g.skillVisuals = [];
    g._activateHotbarSkill(1);

    expect(g.skillVisuals.length).toBe(1);
    const vis = g.skillVisuals[0];
    const castDist = Math.hypot(vis.toX - g.player.x, vis.toY - g.player.y);
    expect(castDist).toBeLessThanOrEqual(fireballSkill.range + 0.1);
  });

  it("delays projectile explosion VFX and blasts until the projectile arrives at the target", () => {
    g.localMana = 100;
    g.player = { x: 100, y: 100, width: 32, height: 32, hp: 100, maxHp: 100, className: "Mage" };
    g.camera = { screenX: 0, screenY: 0 };
    g._cursorX = 400;
    g._cursorY = 100;

    const fireball = getSkillById("mag_fireball");
    g.hotbarSkills.set(1, fireball);
    g.skillVisuals = [];
    g.vfx = [];
    g.blasts = [];

    g._activateHotbarSkill(1);
    expect(g.skillVisuals.length).toBe(1);
    expect(g.skillVisuals[0].kind).toBe("projectile");
    // At launch, explosion VFX/blast is not prematurely placed at destination
    expect(g.vfx.length).toBe(0);
    expect(g.blasts.length).toBe(0);
  });

  it("persists hotbar assignments per character", () => {
    g.characterId = "char_999";
    g.className = "Warrior";
    g.hotbarSkills = new Map();
    g.hotbarSkills.set(1, getSkillById("war_crushing_blow"));
    g.saveHotbar();

    // Reload hotbar
    const freshGame = makeTestGame();
    freshGame.loadHotbar("char_999", "Warrior");
    expect(freshGame.hotbarSkills.get(1)).toBeDefined();
    expect(freshGame.hotbarSkills.get(1).id).toBe("war_crushing_blow");
  });

  it("activates buff skills, applies local heal/buff, registers activeBuffs, and dispatches to server", () => {
    g.localStamina = 100;
    g.player = { x: 100, y: 100, hp: 50, maxHp: 100, className: "Warrior" };

    const sent = [];
    g.authorityClient = { sendCastSkill: (skillId, tx, ty, nx, ny) => sent.push({ skillId, tx, ty, nx, ny }) };

    const steelTempering = getSkillById("war_steel_tempering");
    expect(steelTempering).toBeDefined();
    g.hotbarSkills.set(3, steelTempering);
    g.activeBuffs = new Map();

    g._activateHotbarSkill(3);

    expect(g.activeBuffs.has("war_steel_tempering")).toBe(true);
    const b = g.activeBuffs.get("war_steel_tempering");
    expect(b.nameEn).toBe("Steel Tempering");
    expect(b.expiresAt).toBeGreaterThan(performance.now());
    expect(sent.length).toBe(1);
    expect(sent[0].skillId).toBe("war_steel_tempering");
  });

  it("spawns directional arrow projectiles for Archer / Ranger skills", () => {
    g.localStamina = 100;
    g.player = { x: 100, y: 100, hp: 100, maxHp: 100, className: "Archer" };

    const aimedShot = getSkillById("arc_aimed_shot") || getSkillById("arc_piercing_shot");
    expect(aimedShot).toBeDefined();
    g.hotbarSkills.set(4, aimedShot);
    g.skillVisuals = [];
    g._activateHotbarSkill(4);
    expect(g.skillVisuals.length).toBe(1);
    expect(g.skillVisuals[0].kind).toBe("projectile");
    expect(g.skillVisuals[0].projectileType).toBe("arrow");
    expect(g.skillVisuals[0].speed).toBeGreaterThanOrEqual(800);
  });

  it("spawns 12 staggered arrows for Barrage skill according to description", () => {
    g.localStamina = 100;
    g.player = { x: 100, y: 100, hp: 100, maxHp: 100, className: "Archer" };

    const barrage = getSkillById("arc_barrage");
    expect(barrage).toBeDefined();
    g.hotbarSkills.set(5, barrage);
    g.skillVisuals = [];

    g._activateHotbarSkill(5);
    expect(g.skillVisuals.length).toBe(12);
    expect(g.skillVisuals.every((v) => v.kind === "projectile" && v.projectileType === "arrow")).toBe(true);
  });

  it("spawns steep sky-falling arrows for Rain of Arrows skill", () => {
    g.localStamina = 100;
    g.player = { x: 100, y: 100, hp: 100, maxHp: 100, className: "Archer" };

    const rain = getSkillById("arc_rain_of_arrows");
    expect(rain).toBeDefined();
    g.hotbarSkills.set(6, rain);
    g.skillVisuals = [];

    g._activateHotbarSkill(6);
    expect(g.skillVisuals.length).toBe(14);
    expect(g.skillVisuals.every((v) => v.kind === "projectile" && v.projectileType === "arrow" && v.isSkyRain === true)).toBe(true);
    // Verified that sky arrows originate well above ground target (fromY < toY - 200)
    expect(g.skillVisuals[0].fromY).toBeLessThan(g.skillVisuals[0].toY - 200);
  });

  it("handles Mage skills: Meteor Shower (4 meteors), Frost Nova (around caster), Blink (teleport), Ball Lightning, Mirror Images", () => {
    g.localMana = 200;
    g.player = { x: 100, y: 100, hp: 100, maxHp: 100, className: "Mage" };

    // 1. Meteor Shower: 4 falling meteors
    const meteor = getSkillById("mag_meteor_shower");
    expect(meteor).toBeDefined();
    g.hotbarSkills.set(1, meteor);
    g.skillVisuals = [];
    g._activateHotbarSkill(1);
    expect(g.skillVisuals.length).toBe(4);
    expect(g.skillVisuals.every((v) => v.projectileType === "meteor" && v.isSkyRain === true)).toBe(true);

    // 2. Frost Nova: Centered on caster (fromX, fromY)
    const nova = getSkillById("mag_frost_nova");
    expect(nova).toBeDefined();
    g.hotbarSkills.set(2, nova);
    g.skillVisuals = [];
    g._activateHotbarSkill(2);
    expect(g.skillVisuals.length).toBe(1);
    expect(g.skillVisuals[0].kind).toBe("frost_nova");
    expect(g.skillVisuals[0].x).toBe(100);
    expect(g.skillVisuals[0].y).toBe(100);

    // 3. Blink: Instantly teleports player
    const blink = getSkillById("mag_blink");
    expect(blink).toBeDefined();
    g.hotbarSkills.set(3, blink);
    const prevX = g.player.x;
    g._activateHotbarSkill(3);
    expect(g.player.x).not.toBe(prevX);

    // 4. Ball Lightning: Slow-moving electrical orb
    const ball = getSkillById("mag_ball_lightning");
    expect(ball).toBeDefined();
    g.hotbarSkills.set(4, ball);
    g.skillVisuals = [];
    g._activateHotbarSkill(4);
    expect(g.skillVisuals.length).toBe(1);
    expect(g.skillVisuals[0].projectileType).toBe("lightning_orb");
    expect(g.skillVisuals[0].speed).toBe(320);

    // 5. Mirror Image: Spawns mirror images visual
    const mirror = getSkillById("mag_mirror_image");
    expect(mirror).toBeDefined();
    g.hotbarSkills.set(5, mirror);
    g.skillVisuals = [];
    g._activateHotbarSkill(5);
    expect(g.skillVisuals.length).toBe(1);
    expect(g.skillVisuals[0].kind).toBe("mirror_images");
  });
});


