// What the LOCAL player takes from a server state frame, and how the HUD reads it.
//   G3: Bear Form's HP is the server's; the HP orb must not add a second +200.
//   G5: the server's `aura` (leech ring) must reach the local player, not only others.
//   G7: HP is the server's. Casting must not change it locally, or the next frame
//       (built before the server saw the cast) reads as a phantom heal / hit.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Game } from "../Game.js";
import { RenderSystem } from "../../systems/RenderSystem.js";
import { EntityAnimState } from "../../systems/entityAnimState.js";

const realWindow = globalThis.window;
const realPerf = globalThis.performance;
let clock = 0;

function makeGame() {
  const g = new Game();
  g.state = "playing";
  g.localUserId = "me";
  g.player = { x: 0, y: 0, width: 64, height: 64, hp: 100, maxHp: 100 };
  g._inputBuffer = [];
  g.chunkedMap = null;
  g.entityAnim = new EntityAnimState();
  return g;
}
const me = (over = {}) => ({ id: "me", x: 0, y: 0, hp: 100, maxHp: 100, ...over });

beforeEach(() => {
  clock = 1000;
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.performance = { now: () => clock };
});
afterEach(() => {
  globalThis.window = realWindow;
  globalThis.performance = realPerf;
  vi.restoreAllMocks();
});

describe("G5: the local player's leech aura reaches the player", () => {
  it("copies `aura` from the server row, and clears it when the server omits it", () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [me({ aura: 140 })] });
    expect(g.player.aura).toBe(140);
    g._onWorldState({ tick: 2, players: [me()] }); // aura expired: the key is omitted
    expect(g.player.aura).toBe(0);
  });
});

describe("dormant gear marker", () => {
  it("is copied every frame and defaults to none", () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [me({ dormantGear: ["plate"] })] });
    expect(g.player.dormantGear).toEqual(["plate"]);
    g._onWorldState({ tick: 2, players: [me()] });
    expect(g.player.dormantGear).toEqual([]);
  });
});

describe("G7: HP is the server's", () => {
  it("a Life-cost cast does not touch local HP, and the drop that follows is not a hit", () => {
    const g = makeGame();
    g.player = { x: 0, y: 0, width: 64, height: 64, hp: 100, maxHp: 100, className: "Cultist" };
    g.authorityClient = { sendCastSkill: () => {} };
    g.hotbarSkills.set(1, { id: "cul_test_blood", type: "magic", cost: 20, costType: "hp", cooldown: 1 });
    g.localStamina = 100;
    g._activateHotbarSkill(1);
    expect(g.player.hp).toBe(100); // not deducted locally

    // The server's frame brings the paid HP. It must not read as damage taken.
    clock = 1100;
    g._onWorldState({ tick: 1, players: [me({ hp: 80 })] });
    expect(g.player.hp).toBe(80);
    expect(g.entityAnim.stateFor("self").hitAt).toBe(-Infinity); // never hit
    expect(g.floatingTexts.some((f) => f.text.startsWith("-"))).toBe(false);
  });

  it("real damage after the window is still a hit", () => {
    const g = makeGame();
    clock = 5000;
    g._onWorldState({ tick: 1, players: [me({ hp: 70 })] });
    expect(g.entityAnim.stateFor("self").hitAt).toBe(5000);
    expect(g.floatingTexts.some((f) => f.text === "-30")).toBe(true);
  });

  it("a heal skill does not fabricate a heal then read the server's old HP as damage", () => {
    const g = makeGame();
    g.player = { x: 0, y: 0, width: 64, height: 64, hp: 50, maxHp: 200, className: "Paladin" };
    g.authorityClient = { sendCastSkill: () => {} };
    g.hotbarSkills.set(2, { id: "pal_flash_of_light", type: "buff", cost: 0, costType: "mana", descEn: "Heals 25% HP" });
    g._activateHotbarSkill(2);
    expect(g.player.hp).toBe(50);
    // The next frame was built before the server saw the cast: same HP. Nothing to draw.
    g._onWorldState({ tick: 1, players: [me({ hp: 50, maxHp: 200 })] });
    expect(g.floatingTexts.length).toBe(0);
    expect(g.entityAnim.stateFor("self").hitAt).toBe(-Infinity); // never hit
  });
});

describe("G3: the HP orb shows the server's pools", () => {
  function orbArgs(activeForm, player) {
    const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
    const rs = new RenderSystem({ getContext: () => ctx }, { get: () => null });
    const seen = [];
    rs._drawPoEOrb = (x, y, r, cur, max, label) => { if (label === "HP") seen.push([cur, max]); };
    rs._drawSkillBar = () => {};
    rs._drawActiveBuffs = () => {};
    try {
      rs.renderHud({ player, activeForm, activeBuffs: [] });
    } catch { /* the orb is drawn before anything else that needs a fuller fixture */ }
    return seen[0];
  }

  it("does not add Bear Form's HP on top of the server's already-raised maxHp", () => {
    // Server: 300 base * 1.6 = 480 while in Bear Form.
    expect(orbArgs("bear", { hp: 480, maxHp: 480 })).toEqual([480, 480]);
    expect(orbArgs(null, { hp: 480, maxHp: 480 })).toEqual([480, 480]);
  });
});
