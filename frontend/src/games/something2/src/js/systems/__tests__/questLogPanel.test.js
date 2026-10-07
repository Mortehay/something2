// frontend/src/games/something2/src/js/systems/__tests__/questLogPanel.test.js
import { describe, it, expect } from "vitest";
import { layoutQuestLog, QUEST_PANEL_W, QUEST_PANEL_H } from "../questLogPanel.js";

const QUESTS = [
  {
    key: "act1_core_whisper",
    act: 1,
    title: "Шепіт Забутого Ядра",
    description: "Огляньте руїни та здолайте Елементаля Землі.",
    required_level: 1,
    exp_reward: 2500,
    gold_reward: 350,
    passive_points_reward: 1,
    title_reward: "Шукач Джерел",
    status: "active",
    progress_count: 1,
    target_count: 1,
  },
  {
    key: "act2_elemental_seals",
    act: 2,
    title: "Печаті Стихійних Біомів",
    description: "Здобудьте 4 Кристали у лідерів чотирьох міст.",
    required_level: 15,
    exp_reward: 18000,
    gold_reward: 5000,
    passive_points_reward: 3,
    status: "active",
    progress_count: 0,
    target_count: 4,
  },
];

describe("layoutQuestLog", () => {
  it("computes panel rects, close button, list items, and selected quest", () => {
    const layout = layoutQuestLog({
      quests: QUESTS,
      legacyChoice: "city_restoration",
      activeQuestKey: "act1_core_whisper",
    });

    expect(layout.panel.w).toBe(QUEST_PANEL_W);
    expect(layout.panel.h).toBe(QUEST_PANEL_H);
    expect(layout.quests.length).toBe(2);
    expect(layout.selectedQuest.key).toBe("act1_core_whisper");
    expect(layout.legacyChoice).toBe("city_restoration");
    expect(layout.header.choiceText).toContain("City Restoration");
    expect(layout.actionButtons.length).toBe(2);
    expect(layout.actionButtons[0].kind).toBe("quest_toggle_track");
    expect(layout.actionButtons[1].kind).toBe("quest_complete");
  });

  it("adds quest_toggle_track button for active quests and supports trackedQuestKey", () => {
    const layout = layoutQuestLog({
      quests: QUESTS,
      legacyChoice: null,
      activeQuestKey: "act2_elemental_seals",
      trackedQuestKey: "act2_elemental_seals",
    });

    const trackBtn = layout.actionButtons.find(b => b.kind === "quest_toggle_track");
    expect(trackBtn).toBeDefined();
    expect(trackBtn.isTracked).toBe(true);
    expect(trackBtn.text).toContain("Tracking");
  });

  it("shows in-progress banner when objective progress is incomplete", () => {
    const layout = layoutQuestLog({
      quests: QUESTS,
      legacyChoice: null,
      activeQuestKey: "act2_elemental_seals",
    });

    const banner = layout.actionButtons.find(b => b.type === "banner_in_progress");
    expect(banner).toBeDefined();
    expect(banner.text).toContain("Objective In Progress (0/4)");
  });

  it("offers legacy choices A and B for Act IV when active and unchosen", () => {
    const act4Quest = {
      id: 4,
      key: "act4_primordial_core",
      act: 4,
      title: "Первинне Ядро",
      description: "Вирішіть долю стародавнього Ядра.",
      required_level: 40,
      status: "active",
      progress_count: 1,
      target_count: 1,
    };
    const layout = layoutQuestLog({
      quests: [act4Quest],
      legacyChoice: null,
      activeQuestKey: "act4_primordial_core",
    });

    const cityBtn = layout.actionButtons.find(b => b.kind === "quest_choice_city");
    const surgeBtn = layout.actionButtons.find(b => b.kind === "quest_choice_surge");
    expect(cityBtn).toBeDefined();
    expect(surgeBtn).toBeDefined();
  });

  it("handles locked quest status and displays locked banner", () => {
    const lockedQuest = {
      id: 5,
      key: "act2_molten_anvil",
      act: 2,
      title: "Серце Розплавленого Ковадла",
      description: "Поверніть молот Тітана.",
      objective: "Поверніть молот Тітана з вулкана",
      required_level: 16,
      status: "locked",
    };
    const layout = layoutQuestLog({
      quests: [lockedQuest],
      legacyChoice: null,
      activeQuestKey: "act2_molten_anvil",
    });

    expect(layout.selectedQuest.status).toBe("locked");
    expect(layout.actionButtons.length).toBe(1);
    expect(layout.actionButtons[0].type).toBe("banner_locked");
  });
});

