// frontend/src/games/something2/src/js/systems/__tests__/questLogPanel.test.js
import { describe, it, expect } from "vitest";
import { layoutQuestLog, QUEST_PANEL_W, QUEST_PANEL_H } from "../questLogPanel.js";
import { RenderSystem } from "../RenderSystem.js";
import { GAME_WIDTH } from "../../core/constants.js";

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
    // Track, Complete, and the Abandon button an accepted quest carries.
    expect(layout.actionButtons.length).toBe(3);
    expect(layout.actionButtons[0].kind).toBe("quest_toggle_track");
    expect(layout.actionButtons[1].kind).toBe("quest_complete");
    expect(layout.actionButtons[2].kind).toBe("quest_abandon");
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
      objective_type: "choice",
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

  it("does not offer the Act IV legacy choice before the objective is done or once chosen", () => {
    const base = {
      id: 4, key: "act4_elemental_crucible", act: 4, objective_type: "floor", title: "Crucible",
      description: "d", required_level: 52, status: "active", target_count: 25,
    };
    const inProgress = layoutQuestLog({
      quests: [{ ...base, progress_count: 3 }], legacyChoice: null, activeQuestKey: base.key,
    });
    expect(inProgress.actionButtons.find(b => b.kind === "quest_choice_city")).toBeUndefined();
    expect(inProgress.actionButtons.some(b => b.type === "banner_in_progress")).toBe(true);

    const chosen = layoutQuestLog({
      quests: [{ ...base, progress_count: 25 }], legacyChoice: "city_restoration", activeQuestKey: base.key,
    });
    expect(chosen.actionButtons.find(b => b.kind === "quest_choice_city")).toBeUndefined();
    expect(chosen.actionButtons.find(b => b.kind === "quest_complete")).toBeDefined();
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

  it("positions quest tracker HUD in the top-left corner with panel styling", () => {
    let filledCard = null;
    const dummyCtx = {
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      roundRect: (x, y, w, h, r) => {
        if (!filledCard) filledCard = { x, y, w, h, r };
      },
      moveTo: () => {},
      arcTo: () => {},
      closePath: () => {},
      fill: () => {},
      stroke: () => {},
      fillText: () => {},
      translate: () => {},
      rotate: () => {},
      measureText: () => ({ width: 50 }),
    };

    const rs = Object.create(RenderSystem.prototype);
    rs._drawQuestTrackerHUD(dummyCtx, QUESTS[0], null, null);

    expect(filledCard).not.toBeNull();
    expect(filledCard.x).toBe(16);
    expect(filledCard.y).toBe(16);
    expect(filledCard.w).toBe(300);
  });
});


describe("quest tracker HUD destination line", () => {
  function draw(route, quest = { key: "q1", act: 1, title: "Slime Swarm", objective: "Slay 50 Slimes", target_count: 50, progress_count: 3 }) {
    const texts = [];
    const ctx = {
      save: () => {}, restore: () => {}, beginPath: () => {}, roundRect: () => {}, rect: () => {},
      moveTo: () => {}, lineTo: () => {}, arcTo: () => {}, closePath: () => {}, fill: () => {}, stroke: () => {},
      translate: () => {}, rotate: () => {}, arc: () => {},
      fillText: (t) => texts.push(t),
      measureText: (t) => ({ width: String(t).length * 6 }),
    };
    const rs = Object.create(RenderSystem.prototype);
    rs.questRoute = route && { questKey: quest.key, ...route };
    rs._drawQuestTrackerHUD(ctx, quest, { x: 1000, y: 1000, width: 64, height: 64 }, null);
    return texts;
  }

  it("a hunt route says what to hunt, where, over how many maps, and the SUMMED distance", () => {
    // First leg: player (1032,1032) -> doorway (1032, 5032) = 4000px = 40m; plus 1500px beyond.
    const t = draw({ found: true, mode: "hunt", huntLabel: "Slime", placeName: "Thornbriar Reach", first: { x: 1032, y: 5032 }, restPx: 1500, hops: ["A", "B", "C"], sameWorld: false });
    expect(t.some((s) => s.includes("Hunt Slime: Thornbriar Reach"))).toBe(true);
    expect(t.some((s) => s.includes("+2 maps"))).toBe(true);
    expect(t.some((s) => s.includes("55m"))).toBe(true);
    expect(t.some((s) => s.includes("Hunt in the field"))).toBe(false);
  });

  it("standing in the hunting grounds says so instead of showing a tiny arrow", () => {
    const t = draw({ found: true, mode: "hunt", huntLabel: "Slime", placeName: "Vale Crossing", first: { x: 1100, y: 1100 }, restPx: 0, hops: ["Vale Crossing"], sameWorld: true });
    expect(t.some((s) => s.includes("you are in the right place"))).toBe(true);
    expect(t.some((s) => /↗/.test(s))).toBe(false);
  });

  it("climb and turn-in use their own verbs; an empty search is explained", () => {
    expect(draw({ found: true, mode: "climb", huntLabel: "Spire floor 5", placeName: "Spire of Trials: Floor 5", first: { x: 1032, y: 3032 }, restPx: 0, hops: ["X", "Y"], sameWorld: false })
      .some((s) => s.includes("Climb Spire floor 5"))).toBe(true);
    expect(draw({ found: true, mode: "turn_in", placeName: "Vale Crossing", first: { x: 1032, y: 3032 }, restPx: 0, hops: ["Vale Crossing"], sameWorld: true })
      .some((s) => s.includes("Turn in: Vale Crossing"))).toBe(true);
    expect(draw({ found: false, mode: "hunt", huntLabel: "boss" }).some((s) => s.includes("No boss found yet"))).toBe(true);
  });

  it("long objectives wrap instead of being cut, and the remaining count is shown", () => {
    const quest = { key: "q1", act: 1, title: "Bandit Encampment Cull", objective: "Slay 25 Rogue Bandits near Sunspire Crossing and the old watchtower", target_count: 25, progress_count: 3 };
    const t = draw(null, quest);
    expect(t.some((s) => s.includes("…"))).toBe(false);
    const objective = t.filter((s) => /Slay|Sunspire|watchtower|old/.test(s)).join(" ");
    expect(objective).toContain("watchtower");
    expect(t.some((s) => s.includes("Progress 3/25 • 22 left"))).toBe(true);
  });

  it("the arrow turns toward the next point: opposite targets give opposite headings", () => {
    const headings = [];
    const run = (first) => {
      const ctx = {
        save() {}, restore() {}, beginPath() {}, roundRect() {}, rect() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {}, fill() {}, stroke() {}, translate() {}, arc() {},
        rotate: (a) => headings.push(a), fillText() {}, measureText: (t) => ({ width: String(t).length * 6 }),
      };
      const rs = Object.create(RenderSystem.prototype);
      rs.questRoute = { questKey: "q1", found: true, mode: "turn_in", placeName: "Vale Crossing", first, restPx: 0, hops: ["Vale Crossing"], sameWorld: true };
      rs._drawQuestTrackerHUD(ctx, { key: "q1", act: 1, title: "T", objective: "o", target_count: 1 }, { x: 5000, y: 5000, width: 0, height: 0 }, null);
    };
    run({ x: 9000, y: 5000 });
    run({ x: 1000, y: 5000 });
    expect(headings.length).toBe(2);
    expect(Math.abs(headings[0] - headings[1])).toBeGreaterThan(2);
  });

  it("reports where the card ends and the buff list starts below it (a tall card no longer covers the first buff)", () => {
    const ctx = { save() {}, restore() {}, beginPath() {}, roundRect() {}, rect() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {}, fill() {}, stroke() {}, translate() {}, rotate() {}, arc() {}, fillText() {}, measureText: (t) => ({ width: String(t).length * 6 }) };
    const rs = Object.create(RenderSystem.prototype);
    rs.questRoute = { questKey: "q1", found: true, mode: "hunt", huntLabel: "Skeleton", placeName: "Rimehollow", first: { x: 5000, y: 5000 }, restPx: 5000, hops: ["A", "B"], sameWorld: false };
    rs._drawQuestTrackerHUD(ctx, { key: "q1", act: 1, title: "Bone Sweep", objective: "Slay 10 Skeletons in the old crypt below the village", target_count: 10, progress_count: 1 }, { x: 0, y: 0, width: 64, height: 64 }, null);
    expect(rs._trackerBottom).toBeGreaterThan(104);
  });

  it("a route fetched for a different quest is ignored", () => {
    const rs = Object.create(RenderSystem.prototype);
    rs.questRoute = { questKey: "other", found: true, mode: "hunt", huntLabel: "Slime", placeName: "Elsewhere", first: { x: 1, y: 1 }, restPx: 0, hops: ["A"] };
    const texts = [];
    const ctx = { save() {}, restore() {}, beginPath() {}, roundRect() {}, rect() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {}, fill() {}, stroke() {}, translate() {}, rotate() {}, arc() {}, fillText: (t) => texts.push(t), measureText: (t) => ({ width: String(t).length * 6 }) };
    rs._drawQuestTrackerHUD(ctx, { key: "q1", act: 1, title: "T", objective: "o", target_count: 1 }, { x: 0, y: 0, width: 64, height: 64 }, null);
    expect(texts.some((s) => s.includes("Elsewhere"))).toBe(false);
  });
});

describe("quest log Spire footer", () => {
  it("shows the highest floor and the next boss", async () => {
    const { spireLine, layoutQuestLog } = await import("../questLogPanel.js");
    expect(spireLine({ highestFloor: 12, maxFloor: 61, nextBossFloor: 15 })).toBe("🗼 Spire: floor 12/61 · next boss: floor 15");
    expect(spireLine({ highestFloor: 0, maxFloor: 61, nextBossFloor: 5 })).toContain("not entered yet");
    expect(spireLine({ highestFloor: 61, maxFloor: 61, nextBossFloor: null })).toContain("all gate bosses defeated");
    expect(spireLine(null)).toBeNull();
    const layout = layoutQuestLog({ quests: [], spireProgress: { highestFloor: 3, maxFloor: 61, nextBossFloor: 5 } });
    expect(layout.header.spireText).toContain("floor 3/61");
  });
});

import { formatCountdown, liveTimeLeft, questLabels, listBadgeText, reputationLine, humanizeVillage, choiceRewardText } from "../questLogPanel.js";

describe("quest expansion layout helpers", () => {
  const pick = {
    key: "p1", id: 9, act: 1, title: "Pick", description: "d", required_level: 1,
    status: "active", objective_type: "pick", progress_count: 0, target_count: 1,
    choices: [{ key: "a", label: "A", gold_reward: 50 }, { key: "b", label: "B", item_reward: "Sword" }],
  };

  it("formats countdowns as m:ss", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(-3)).toBe("0:00");
    expect(formatCountdown(59.2)).toBe("1:00");
  });

  it("ticks time left from the fetch time and only for active timed quests", () => {
    const q = { status: "active", time_limit_sec: 300, time_left_sec: 100, _fetchedAt: 1000 };
    expect(liveTimeLeft(q, 11000)).toBe(90);
    expect(liveTimeLeft(q, 1e9)).toBe(0);
    expect(liveTimeLeft({ ...q, status: "available" }, 11000)).toBeNull();
    expect(liveTimeLeft({ ...q, time_limit_sec: null }, 11000)).toBeNull();
  });

  it("builds labels", () => {
    const t = questLabels({ repeat_kind: "daily", status: "active", time_limit_sec: 300, time_left_sec: 75, _fetchedAt: 0, required_class: "Mage", required_reputation: 30, reputation_reward: 5 }, 0)
      .map((l) => l.text);
    expect(t).toEqual(["Daily", "Challenge ⏱ 1:15", "Mage only", "Standing 30", "+5 standing"]);
    expect(questLabels({ repeat_kind: "weekly" }).map((l) => l.text)).toEqual(["Weekly"]);
  });

  it("list badge prefers the locked reason", () => {
    expect(listBadgeText({ status: "locked", locked_reason: "Mage only" })).toBe("🔒 Mage only");
    expect(listBadgeText({ status: "locked" })).toBe("🔒 Locked");
    expect(listBadgeText({ status: "available", repeat_kind: "daily" })).toBe("✦ Available · Daily");
  });

  it("summarises reputation", () => {
    expect(humanizeVillage("village_sun_spire")).toBe("Sun Spire");
    expect(reputationLine([{ village_key: "sunspire", points: 35, tier: "Friend" }])).toBe("Sunspire: Friend (35)");
    expect(reputationLine([])).toBeNull();
    expect(choiceRewardText({ gold_reward: 50, exp_reward: 10, item_reward: "Sword" })).toBe("+50g · +10 EXP · Sword");
  });

  it("pick quests: choices are hit areas and Complete is disabled until one is selected", () => {
    let l = layoutQuestLog({ quests: [pick], activeQuestKey: "p1" });
    const choices = l.hitAreas.filter((a) => a.kind === "quest_pick_choice");
    expect(choices.map((c) => c.choiceKey)).toEqual(["a", "b"]);
    const complete = l.actionButtons.find((b) => b.kind === "quest_complete");
    expect(complete.disabled).toBe(true);
    expect(l.hitAreas.some((a) => a.kind === "quest_complete")).toBe(false);

    l = layoutQuestLog({ quests: [pick], activeQuestKey: "p1", pickChoices: { p1: "b" } });
    const done = l.hitAreas.find((a) => a.kind === "quest_complete");
    expect(done.choiceKey).toBe("b");
    expect(l.actionButtons.find((b) => b.choiceKey === "b" && b.kind === "quest_pick_choice").selected).toBe(true);
  });

  it("locked quests show the server reason in the banner", () => {
    const l = layoutQuestLog({ quests: [{ ...pick, status: "locked", locked_reason: "Standing 30 needed" }], activeQuestKey: "p1" });
    expect(l.actionButtons[0].text).toContain("Standing 30 needed");
  });
});

describe("quest log category tabs", () => {
  const mk = (key, extra = {}) => ({ key, title: key, status: "available", is_side: false, repeat_kind: "none", target_count: 1, progress_count: 0, ...extra });
  const SET = [
    mk("m1", { status: "completed" }),
    mk("m2", { status: "active" }),
    mk("s1", { is_side: true }),
    mk("d1", { is_side: true, repeat_kind: "daily" }),
    mk("w1", { is_side: true, repeat_kind: "weekly", status: "active" }),
    mk("c1", { is_side: true, required_class: "Mage", status: "locked" }),
  ];

  it("splits quests into tabs, a quest may sit in several", async () => {
    const { filterQuests } = await import("../questLogPanel.js");
    const keys = (tab) => filterQuests(SET, tab).map((q) => q.key);
    expect(keys("all")).toHaveLength(6);
    expect(keys("main").sort()).toEqual(["m1", "m2"]);
    expect(keys("side")).toEqual(["s1"]);
    expect(keys("repeat")).toEqual(["d1", "w1"]); // dailies before weeklies
    expect(keys("class")).toEqual(["c1"]);
    expect(keys("done")).toEqual(["m1"]);
    expect(keys("active").sort()).toEqual(["m2", "w1"]);
  });

  it("lists actionable quests first outside the storyline tab", async () => {
    const { filterQuests } = await import("../questLogPanel.js");
    const order = filterQuests(SET, "all").map((q) => q.key);
    expect(order.indexOf("m2")).toBeLessThan(order.indexOf("s1"));
    expect(order.indexOf("s1")).toBeLessThan(order.indexOf("c1"));
    expect(order[order.length - 1]).toBe("m1");
    // the storyline keeps its authored order
    expect(filterQuests(SET, "main").map((q) => q.key)).toEqual(["m1", "m2"]);
  });

  it("layout only lists the selected tab and exposes clickable tabs with counts", () => {
    const l = layoutQuestLog({ quests: SET, questTab: "repeat" });
    expect(l.quests.map((q) => q.key)).toEqual(["d1", "w1"]);
    expect(l.tab).toBe("repeat");
    const tabHits = l.hitAreas.filter((h) => h.kind === "questtab");
    expect(tabHits.map((h) => h.tab)).toEqual(["all", "active", "main", "side", "repeat", "class", "done"]);
    expect(tabHits.find((h) => h.tab === "repeat").count).toBe(2);
    expect(tabHits.find((h) => h.tab === "repeat").selected).toBe(true);
    for (const t of tabHits) {
      expect(l.listArea.y).toBeGreaterThanOrEqual(t.y + t.h);
    }
  });

  it("falls back to All for an unknown tab and selects within the tab", () => {
    expect(layoutQuestLog({ quests: SET, questTab: "bogus" }).tab).toBe("all");
    const l = layoutQuestLog({ quests: SET, questTab: "class", activeQuestKey: "m2" });
    expect(l.selectedQuest.key).toBe("c1");
  });
});
