// frontend/src/games/something2/src/js/core/__tests__/questLogInteractions.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Game } from "../Game.js";

vi.mock("../../net/questsClient.js", () => ({
  fetchAllQuests: vi.fn().mockResolvedValue([
    {
      id: 1,
      key: "act1_core_whisper",
      act: 1,
      title: "Шепіт Забутого Ядра",
      description: "Огляньте стародавні руїни.",
      required_level: 1,
      exp_reward: 2500,
      gold_reward: 350,
      passive_points_reward: 1,
      start_npc_key: "npc_thorn",
      village_key: "oakhaven",
    },
    {
      id: 4,
      key: "act4_primordial_core",
      act: 4,
      title: "Первинне Ядро",
      description: "Зробіть перманентний вибір для долі континенту.",
      required_level: 40,
      exp_reward: 100000,
      gold_reward: 25000,
      passive_points_reward: 5,
      start_npc_key: "npc_elder_sunspire",
      village_key: "sunspire",
    }
  ]),
  fetchCharacterQuests: vi.fn().mockResolvedValue([]),
  startQuest: vi.fn().mockResolvedValue({ success: true, questId: 1, status: "active" }),
  completeQuest: vi.fn().mockImplementation((charId, questId, choice) => {
    return Promise.resolve({
      success: true,
      questId,
      status: "completed",
      legacyChoice: choice || null,
      rewards: { exp: 2500, gold: 350, passive_points: 1 }
    });
  }),
}));

function makeTestGame() {
  const canvas = {
    width: 800,
    height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const g = new Game(canvas);
  g.setupInput();
  g.state = "playing";
  g.chunked = true;
  g.authorityClient = { sendInteract: () => {} };
  g.characterId = "char_test_123";
  g.player = { x: 100, y: 100, width: 32, height: 32, hp: 100, maxHp: 100, className: "Warrior" };
  g.progression = { level: 20, passivePoints: 3, legacyChoice: null };
  g.gold = 500;
  g.renderSystem = { _questHitAreas: [] };
  return g;
}

describe("Quest Log Panel & Storyline Interactions", () => {
  let g;

  beforeEach(() => {
    g = makeTestGame();
  });

  it("toggles quest log panel when pressing 'j'", () => {
    expect(g.questLogOpen).toBe(false);
    g._keydownHandler({ key: "j", code: "KeyJ", repeat: false });
    expect(g.questLogOpen).toBe(true);
    g._keydownHandler({ key: "j", code: "KeyJ", repeat: false });
    expect(g.questLogOpen).toBe(false);
  });

  it("toggles quest log panel when pressing cyrillic 'о'", () => {
    expect(g.questLogOpen).toBe(false);
    g._keydownHandler({ key: "о", code: "KeyJ", repeat: false });
    expect(g.questLogOpen).toBe(true);
    g._keydownHandler({ key: "Escape", code: "Escape", repeat: false });
    expect(g.questLogOpen).toBe(false);
  });

  it("selects a quest and handles close button click", () => {
    g.openQuestLog();
    expect(g.questLogOpen).toBe(true);

    g.renderSystem._questHitAreas = [
      { x: 100, y: 100, w: 20, h: 20, kind: "questclose" },
      { x: 10, y: 50, w: 100, h: 30, kind: "selectquest", key: "act4_primordial_core" },
    ];

    // Click select quest
    g._cursorX = 20;
    g._cursorY = 60;
    g._mouseDownHandler({ button: 0, clientX: 20, clientY: 60 });
    expect(g.activeQuestKey).toBe("act4_primordial_core");

    // Click close
    g._cursorX = 105;
    g._cursorY = 105;
    g._mouseDownHandler({ button: 0, clientX: 105, clientY: 105 });
    expect(g.questLogOpen).toBe(false);
  });

  it("handles accepting and completing a quest", async () => {
    g.openQuestLog();
    g.renderSystem._questHitAreas = [
      { x: 200, y: 300, w: 150, h: 40, kind: "quest_accept", questId: 1, questKey: "act1_core_whisper" },
    ];

    g._cursorX = 220;
    g._cursorY = 320;
    g._mouseDownHandler({ button: 0, clientX: 220, clientY: 320 });

    // Now test complete
    g.renderSystem._questHitAreas = [
      { x: 200, y: 300, w: 150, h: 40, kind: "quest_complete", questId: 1, questKey: "act1_core_whisper" },
    ];
    g._mouseDownHandler({ button: 0, clientX: 220, clientY: 320 });
  });

  it("supports choosing Act IV permanent legacy choices", async () => {
    g.openQuestLog();
    g.renderSystem._questHitAreas = [
      { x: 200, y: 400, w: 100, h: 40, kind: "quest_choice_city", questId: 4, questKey: "act4_primordial_core" },
    ];

    g._cursorX = 220;
    g._cursorY = 410;
    g._mouseDownHandler({ button: 0, clientX: 220, clientY: 410 });

    // Wait for promise resolution
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(g.legacyChoice).toBe("city_restoration");
    expect(g.progression.legacyChoice).toBe("city_restoration");
  });

  it("reports quest markers in getMinimapSnapshot()", () => {
    g.allQuests = [
      { id: 1, key: "act1", title: "Act 1", act: 1, status: "active", start_npc_key: "npc_thorn", village_key: "oakhaven" }
    ];
    g.questGivers = [{ x: 120, y: 120, name: "Elder Eldrin" }];
    const snap = g.getMinimapSnapshot();
    expect(snap).not.toBeNull();
    expect(snap.questMarkers).toBeDefined();
    expect(snap.questMarkers.length).toBe(1);
    expect(snap.questMarkers[0].key).toBe("act1");
    expect(snap.questMarkers[0].status).toBe("active");
    expect(snap.questGivers).toBeDefined();
    expect(snap.questGivers.length).toBe(1);
    expect(snap.questGivers[0].name).toBe("Elder Eldrin");
  });

  it("opens quest log when pressing 'e' near a quest giver", () => {
    g.questGivers = [{ x: 100, y: 100, name: "Elder Eldrin" }];
    expect(g.questLogOpen).toBe(false);
    g._keydownHandler({ key: "e", code: "KeyE", repeat: false });
    expect(g.questLogOpen).toBe(true);
  });
});
