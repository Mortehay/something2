// frontend/src/games/something2/src/js/systems/questLogPanel.js
//
// Pure layout and Canvas 2D renderer for the Quest Log window (hotkey 'J').

import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";

export const QUEST_PANEL_W = 760;
// 22px taller than the lists need: the bottom strip carries the Spire progress line.
const FOOTER_H = 22;
export const QUEST_PANEL_H = 542;
const TITLE_H = 40;

function truncateText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 0 && ctx.measureText(s + "…").width > maxWidth) {
    s = s.slice(0, -1);
  }
  return s + "…";
}

function drawRoundedRect(ctx, x, y, w, h, r = 0) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    const radii = Array.isArray(r) ? r : [r, r, r, r];
    const [tl, tr, br, bl] = radii;
    ctx.moveTo(x + tl, y);
    ctx.arcTo(x + w, y, x + w, y + h, tr);
    ctx.arcTo(x + w, y + h, x, y + h, br);
    ctx.arcTo(x, y + h, x, y, bl);
    ctx.arcTo(x, y, x + w, y, tl);
    ctx.closePath();
  }
}

// "Spire: floor 12/61 · next boss: floor 15" for the log's footer, or null when
// the server sent no progress (the footer is then simply not drawn).
export function spireLine(p) {
  if (!p || !Number.isFinite(p.maxFloor) || p.maxFloor <= 0) return null;
  const floor = p.highestFloor > 0 ? `floor ${p.highestFloor}/${p.maxFloor}` : "not entered yet";
  const boss = p.nextBossFloor == null ? "all gate bosses defeated" : `next boss: floor ${p.nextBossFloor}`;
  return `🗼 Spire: ${floor} · ${boss}`;
}

// m:ss for a countdown in seconds (never negative; rounds up so 0:00 means over).
export function formatCountdown(sec) {
  const n = Math.max(0, Math.ceil(Number(sec) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

// Seconds left on a timed active quest. The server sends time_left_sec as of
// the fetch; `_fetchedAt` (stamped by Game.loadQuests) lets it keep ticking
// without another request. null when the quest is not a running timed one.
export function liveTimeLeft(q, now = Date.now()) {
  if (!q || q.status !== "active" || !q.time_limit_sec || q.time_left_sec == null) return null;
  const elapsed = q._fetchedAt ? Math.max(0, (now - q._fetchedAt) / 1000) : 0;
  return Math.max(0, q.time_left_sec - elapsed);
}

// Small coloured tags for a quest: [{ text, color }].
export function questLabels(q, now = Date.now()) {
  if (!q) return [];
  const out = [];
  if (q.repeat_kind === "daily") out.push({ text: "Daily", color: "#fbbf24" });
  else if (q.repeat_kind === "weekly") out.push({ text: "Weekly", color: "#c084fc" });
  if (q.time_limit_sec) {
    const left = liveTimeLeft(q, now);
    out.push({
      text: left != null ? `Challenge ⏱ ${formatCountdown(left)}` : `Challenge (${formatCountdown(q.time_limit_sec)})`,
      color: left != null && left <= 30 ? "#f87171" : "#fb923c",
    });
  }
  if (q.required_class) out.push({ text: `${q.required_class} only`, color: "#f472b6" });
  if (q.required_reputation > 0) out.push({ text: `Standing ${q.required_reputation}`, color: "#a3e635" });
  if (q.reputation_reward > 0) out.push({ text: `+${q.reputation_reward} standing`, color: "#86efac" });
  return out;
}

// One-line version of the labels for the cramped list rows.
export function listBadgeText(q, now = Date.now()) {
  if (!q) return "";
  if (q.status === "locked" && q.locked_reason) return `🔒 ${q.locked_reason}`;
  const base = q.status === "completed" ? "✔ Completed" : q.status === "active" ? "⚙ Active" : q.status === "locked" ? "🔒 Locked" : "✦ Available";
  const extra = [];
  if (q.repeat_kind === "daily") extra.push("Daily");
  else if (q.repeat_kind === "weekly") extra.push("Weekly");
  const left = liveTimeLeft(q, now);
  if (left != null) extra.push(`⏱${formatCountdown(left)}`);
  else if (q.time_limit_sec) extra.push("Challenge");
  return extra.length ? `${base} · ${extra.join(" · ")}` : base;
}

export function humanizeVillage(key) {
  return String(key || "").replace(/^village[_-]/, "").split(/[_-]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// "Sunspire: Friend (35) · Ironhold: Stranger (0)" or null with no standing.
export function reputationLine(reputation) {
  if (!Array.isArray(reputation) || reputation.length === 0) return null;
  return reputation
    .map((r) => `${humanizeVillage(r.village_key)}: ${r.tier || "Stranger"} (${r.points || 0})`)
    .join(" · ");
}

// "+50g · +200 EXP · Iron Sword" for a pick choice.
export function choiceRewardText(c) {
  if (!c) return "";
  const parts = [];
  if (c.gold_reward > 0) parts.push(`+${c.gold_reward}g`);
  if (c.exp_reward > 0) parts.push(`+${c.exp_reward} EXP`);
  if (c.item_reward) parts.push(String(c.item_reward));
  return parts.join(" · ");
}

// --- Category tabs -------------------------------------------------------
// The list used to be one long scroll; tabs split it so a daily or a class
// trial is one click away. A quest can belong to several tabs.
export const QUEST_TABS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "main", label: "Main" },
  { key: "side", label: "Side" },
  { key: "repeat", label: "Repeat" },
  { key: "class", label: "Class" },
  { key: "done", label: "Done" },
];
const TAB_ROWS = [["all", "active", "main", "side"], ["repeat", "class", "done"]];
const TAB_H = 22;
const TAB_GAP = 4;
const TABS_AREA_H = TAB_H * 2 + TAB_GAP;

export function inQuestTab(q, tab) {
  switch (tab) {
    case "active": return q.status === "active";
    case "main": return !q.is_side;
    case "side": return !!q.is_side && q.repeat_kind !== "daily" && q.repeat_kind !== "weekly" && !q.required_class;
    case "repeat": return q.repeat_kind === "daily" || q.repeat_kind === "weekly";
    case "class": return !!q.required_class;
    case "done": return q.status === "completed";
    default: return true;
  }
}

const STATUS_RANK = { active: 0, available: 1, locked: 2, completed: 3 };

// The quests a tab shows, in display order: the storyline keeps its authored
// order; every other tab lists what you can act on first (active, then
// available, locked, completed), dailies before weeklies in "Repeat".
export function filterQuests(quests, tab) {
  const list = (quests || []).filter((q) => inQuestTab(q, tab));
  if (tab === "main") return list;
  const rep = (q) => (q.repeat_kind === "daily" ? 0 : q.repeat_kind === "weekly" ? 1 : 2);
  return list
    .map((q, i) => ({ q, i }))
    .sort((a, b) => (tab === "repeat" ? rep(a.q) - rep(b.q) : 0)
      || (STATUS_RANK[a.q.status] ?? 4) - (STATUS_RANK[b.q.status] ?? 4)
      || a.i - b.i)
    .map((x) => x.q);
}

export function questTabCounts(quests) {
  const out = {};
  for (const t of QUEST_TABS) out[t.key] = (quests || []).filter((q) => inQuestTab(q, t.key)).length;
  return out;
}

export function layoutQuestLog(state = {}) {
  const {
    quests: allQuests = [],
    legacyChoice = null,
    activeQuestKey = null,
    questScroll = 0,
    spireProgress = null,
    reputation = [],
    characterClass = null,
    pickChoices = {},
    questTab = "all",
    now = Date.now(),
  } = state;
  const tab = QUEST_TABS.some((t) => t.key === questTab) ? questTab : "all";
  const quests = filterQuests(allQuests, tab);

  const px = (GAME_WIDTH - QUEST_PANEL_W) / 2;
  const py = (GAME_HEIGHT - QUEST_PANEL_H) / 2;

  const panel = { x: px, y: py, w: QUEST_PANEL_W, h: QUEST_PANEL_H };
  const title = { x: px, y: py, w: QUEST_PANEL_W, h: TITLE_H };
  const close = { x: px + QUEST_PANEL_W - 32, y: py + 8, w: 24, h: 24 };

  const hitAreas = [{ ...close, kind: "questclose", id: null }];

  // Category tabs sit above the list; the list takes what is left.
  const tabsTop = py + TITLE_H + 12;
  const counts = questTabCounts(allQuests);
  const tabs = [];
  TAB_ROWS.forEach((row, r) => {
    const gap = 4;
    const w = Math.floor((260 - gap * (row.length - 1)) / row.length);
    row.forEach((key, c) => {
      const def = QUEST_TABS.find((t) => t.key === key);
      const rect = { x: px + 14 + c * (w + gap), y: tabsTop + r * (TAB_H + TAB_GAP), w, h: TAB_H };
      const t = { ...rect, kind: "questtab", tab: key, label: def.label, count: counts[key], selected: key === tab };
      tabs.push(t);
      hitAreas.push(t);
    });
  });
  const listArea = {
    x: px + 14, y: tabsTop + TABS_AREA_H + 6, w: 260,
    h: QUEST_PANEL_H - TITLE_H - 26 - FOOTER_H - TABS_AREA_H - 6,
  };
  const detailArea = { x: px + 288, y: py + TITLE_H + 12, w: QUEST_PANEL_W - 302, h: QUEST_PANEL_H - TITLE_H - 26 - FOOTER_H };

  const itemH = 44;
  const itemGap = 6;
  const totalH = quests.length * (itemH + itemGap);
  const maxScroll = Math.max(0, totalH - listArea.h);
  const scrollY = Math.max(0, Math.min(maxScroll, questScroll));

  const questItems = [];
  for (let i = 0; i < quests.length; i++) {
    const q = quests[i];
    const itemY = listArea.y + i * (itemH + itemGap) - scrollY;
    const itemRect = { x: listArea.x, y: itemY, w: listArea.w, h: itemH };
    questItems.push({ ...q, ...itemRect });

    if (itemY + itemH >= listArea.y && itemY <= listArea.y + listArea.h) {
      hitAreas.push({ ...itemRect, kind: "selectquest", key: q.key });
    }
  }

  const trackedQuestKey = state.trackedQuestKey || (allQuests.find(q => q.status === "active")?.key || activeQuestKey);
  const selectedQuest = quests.find(q => q.key === activeQuestKey) || quests[0] || null;

  let actionButtons = [];
  if (selectedQuest) {
    // Add Track Quest Toggle Button top-right of detail area
    if (selectedQuest.status !== "completed" && selectedQuest.status !== "locked") {
      const isTracked = trackedQuestKey === selectedQuest.key;
      const trackBtn = {
        kind: "quest_toggle_track",
        questKey: selectedQuest.key,
        isTracked,
        x: detailArea.x + detailArea.w - 138,
        y: detailArea.y + 10,
        w: 124,
        h: 26,
        text: isTracked ? "📌 Tracking" : "📌 Track Quest",
        color: isTracked ? "#38bdf8" : "#94a3b8",
      };
      actionButtons.push(trackBtn);
      hitAreas.push(trackBtn);
    }

    const btnY = detailArea.y + detailArea.h - 52;
    if (selectedQuest.status === "completed") {
      actionButtons.push({
        type: "banner",
        x: detailArea.x + 14,
        y: btnY,
        w: detailArea.w - 28,
        h: 42,
        text: "✔ Quest completed! All rewards claimed.",
        color: "#4ade80",
      });
    } else if (selectedQuest.status === "locked") {
      actionButtons.push({
        type: "banner_locked",
        x: detailArea.x + 14,
        y: btnY,
        w: detailArea.w - 28,
        h: 42,
        text: selectedQuest.locked_reason ? `🔒 ${selectedQuest.locked_reason}` : "🔒 Locked: Complete previous quest first.",
        color: "#64748b",
      });
    } else if (selectedQuest.status === "active") {
      const progCnt = selectedQuest.progress_count || 0;
      const targetCnt = selectedQuest.target_count || 1;
      const isPick = selectedQuest.objective_type === "pick";
      // A pick quest is met as soon as it is accepted: the turn-in is the choice.
      const isObjectiveComplete = isPick || progCnt >= targetCnt;
      const pickList = isPick && Array.isArray(selectedQuest.choices) ? selectedQuest.choices : [];
      const pickedKey = isPick ? ((pickChoices && pickChoices[selectedQuest.key]) || null) : null;
      const pickValid = !!pickedKey && pickList.some((c) => c.key === pickedKey);
      if (isPick) {
        const rowH = 30;
        const rowW = detailArea.w - 28 - 124;
        const pickButtons = pickList.map((c, i) => ({
          kind: "quest_pick_choice",
          questKey: selectedQuest.key,
          choiceKey: c.key,
          selected: c.key === pickedKey,
          x: detailArea.x + 14,
          y: btnY - 6 - (pickList.length - i) * (rowH + 4),
          w: rowW,
          h: rowH,
          title: c.label || c.key,
          sub: choiceRewardText(c),
          color: c.key === pickedKey ? "#22c55e" : "#38bdf8",
        }));
        actionButtons.push(...pickButtons);
        hitAreas.push(...pickButtons);
      }

      // The permanent choice rides on completing an Act IV quest, so it is
      // offered only once the objective is done and nothing is chosen yet. It
      // used to show from the moment the quest was accepted (a click then just
      // failed on the server), and kept showing on act4_new_dawn after the
      // choice was made, next to a key ("act4_primordial_core") that no quest has.
      if (selectedQuest.objective_type === "choice" && !legacyChoice && isObjectiveComplete) {
        const halfW = Math.floor((detailArea.w - 36) / 2);
        const cityBtn = {
          kind: "quest_choice_city",
          questId: selectedQuest.id,
          questKey: selectedQuest.key,
          x: detailArea.x + 14,
          y: btnY - 14,
          w: halfW,
          h: 56,
          title: "🏛️ City Restoration",
          sub: "-15% Vendor Prices (Peace & Trade)",
          color: "#38bdf8",
        };
        const surgeBtn = {
          kind: "quest_choice_surge",
          questId: selectedQuest.id,
          questKey: selectedQuest.key,
          x: detailArea.x + 22 + halfW,
          y: btnY - 14,
          w: halfW,
          h: 56,
          title: "⚡ Elemental Surge",
          sub: "+15% Magic Find / +20% Gold (Primal Might)",
          color: "#f59e0b",
        };
        actionButtons.push(cityBtn, surgeBtn);
        hitAreas.push(cityBtn, surgeBtn);
      } else if (!isObjectiveComplete) {
        actionButtons.push({
          type: "banner_in_progress",
          x: detailArea.x + 14,
          y: btnY,
          w: detailArea.w - 28,
          h: 42,
          text: `⚙ Objective In Progress (${progCnt}/${targetCnt})`,
          color: "#38bdf8",
        });
      } else {
        const disabled = isPick && !pickValid;
        const completeBtn = {
          kind: "quest_complete",
          questId: selectedQuest.id,
          questKey: selectedQuest.key,
          choiceKey: isPick ? pickedKey : null,
          disabled,
          x: detailArea.x + 14,
          y: btnY,
          w: detailArea.w - 28,
          h: 42,
          text: disabled ? "Choose a reward above" : "✔ Complete Quest & Claim Rewards",
          color: disabled ? "#64748b" : "#22c55e",
        };
        actionButtons.push(completeBtn);
        if (!disabled) hitAreas.push(completeBtn);
      }
      // Give up the quest (progress is lost). Not offered next to the Act IV
      // choice buttons, which occupy that row.
      if (!(selectedQuest.objective_type === "choice" && !legacyChoice && isObjectiveComplete)) {
        const abandonBtn = {
          kind: "quest_abandon",
          questId: selectedQuest.id,
          questKey: selectedQuest.key,
          x: detailArea.x + detailArea.w - 124,
          y: btnY - 26,
          w: 110,
          h: 20,
          text: "✖ Abandon",
          color: "#f87171",
        };
        actionButtons.push(abandonBtn);
        hitAreas.push(abandonBtn);
      }
    } else {
      const acceptBtn = {
        kind: "quest_accept",
        questId: selectedQuest.id,
        questKey: selectedQuest.key,
        x: detailArea.x + 14,
        y: btnY,
        w: detailArea.w - 28,
        h: 42,
        text: "⚔️ Accept Quest",
        color: "#eab308",
      };
      actionButtons.push(acceptBtn);
      hitAreas.push(acceptBtn);
    }
  }

  return {
    panel, title, close, hitAreas, listArea, detailArea,
    quests: questItems, selectedQuest, legacyChoice, actionButtons, now, tabs, tab,
    totalH, maxScroll, scrollY,
    header: {
      spireText: spireLine(spireProgress),
      reputationText: [reputationLine(reputation), characterClass ? `Class: ${characterClass}` : null].filter(Boolean).join(" · ") || null,
      titleText: "📜 Quest Log (Hotkey 'J')" + (allQuests.filter((q) => q.status === "completed" && q.title_reward).length ? ` · 👑 ${allQuests.filter((q) => q.status === "completed" && q.title_reward).length}` : ""),
      choiceText: legacyChoice === "city_restoration"
        ? "✨ Legacy: City Restoration (-15% Vendor Prices)"
        : legacyChoice === "elemental_surge"
          ? "⚡ Legacy: Elemental Surge (+15% MF / +20% Gold)"
          : "⏳ Unchosen Legacy (Act IV)",
    },
  };
}

export function drawQuestLog(ctx, layout) {
  if (!layout) return;

  const { panel, title, close, listArea, detailArea, quests, selectedQuest, header, totalH, maxScroll, scrollY } = layout;

  ctx.save();
  ctx.textBaseline = "top";

  // 1. Main Background Panel (Dark Glassmorphic UI)
  drawRoundedRect(ctx, panel.x, panel.y, panel.w, panel.h, 14);
  ctx.fillStyle = "rgba(15, 15, 26, 0.95)";
  ctx.fill();
  ctx.strokeStyle = "#2e2e3e";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Subtle inner accent glow
  drawRoundedRect(ctx, panel.x + 1, panel.y + 1, panel.w - 2, panel.h - 2, 13);
  ctx.strokeStyle = "rgba(56, 189, 248, 0.1)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // 2. Title Bar Header
  drawRoundedRect(ctx, title.x, title.y, title.w, title.h, [14, 14, 0, 0]);
  ctx.fillStyle = "rgba(22, 22, 38, 0.98)";
  ctx.fill();

  // Header bottom border
  ctx.beginPath();
  ctx.moveTo(title.x, title.y + title.h);
  ctx.lineTo(title.x + title.w, title.y + title.h);
  ctx.strokeStyle = "#2e2e3e";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Title icon & text
  ctx.fillStyle = "#fde047";
  ctx.font = "bold 14px monospace";
  ctx.fillText(header.titleText, title.x + 16, title.y + 11);

  // Legacy status badge/pill
  if (header.choiceText) {
    ctx.font = "11px monospace";
    const choiceStr = truncateText(ctx, header.choiceText, title.w - 380);
    const textW = ctx.measureText(choiceStr).width;
    const badgeX = title.x + 360;
    const badgeY = title.y + 9;

    drawRoundedRect(ctx, badgeX, badgeY, textW + 16, 22, 11);
    ctx.fillStyle = "rgba(52, 211, 153, 0.1)";
    ctx.fill();
    ctx.strokeStyle = "rgba(52, 211, 153, 0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#34d399";
    ctx.fillText(choiceStr, badgeX + 8, badgeY + 4);
  }

  // Spire progress, in the panel's bottom margin.
  if (header.spireText) {
    ctx.font = "11px monospace";
    ctx.fillStyle = "#93c5fd";
    ctx.fillText(header.spireText, panel.x + 16, panel.y + panel.h - 18);
  }
  // Village standing + class, right-aligned in the same strip.
  if (header.reputationText) {
    ctx.font = "11px monospace";
    ctx.fillStyle = "#86efac";
    ctx.textAlign = "right";
    ctx.fillText(truncateText(ctx, header.reputationText, panel.w * 0.6), panel.x + panel.w - 16, panel.y + panel.h - 18);
    ctx.textAlign = "left";
  }

  // Close Button (Sleek red glass button)
  drawRoundedRect(ctx, close.x, close.y, close.w, close.h, 6);
  ctx.fillStyle = "rgba(239, 68, 68, 0.15)";
  ctx.fill();
  ctx.strokeStyle = "rgba(239, 68, 68, 0.4)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#fca5a5";
  ctx.font = "bold 13px monospace";
  ctx.fillText("✕", close.x + 7, close.y + 4);

  // 3. Left List Area Box
  drawRoundedRect(ctx, listArea.x, listArea.y, listArea.w, listArea.h, 10);
  ctx.fillStyle = "rgba(18, 18, 30, 0.7)";
  ctx.fill();
  ctx.strokeStyle = "#252538";
  ctx.lineWidth = 1;
  ctx.stroke();

  // 4. Right Detail Box
  drawRoundedRect(ctx, detailArea.x, detailArea.y, detailArea.w, detailArea.h, 10);
  ctx.fillStyle = "rgba(18, 18, 30, 0.7)";
  ctx.fill();
  ctx.strokeStyle = "#252538";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Category tabs
  ctx.font = "bold 10px monospace";
  for (const t of layout.tabs || []) {
    drawRoundedRect(ctx, t.x, t.y, t.w, t.h, 6);
    ctx.fillStyle = t.selected ? "rgba(56, 189, 248, 0.22)" : "rgba(30, 30, 48, 0.8)";
    ctx.fill();
    ctx.strokeStyle = t.selected ? "#38bdf8" : "#2e2e3e";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = t.selected ? "#e0f2fe" : t.count > 0 ? "#94a3b8" : "#475569";
    ctx.textAlign = "center";
    ctx.fillText(`${t.label} ${t.count}`, t.x + t.w / 2, t.y + 6);
  }
  ctx.textAlign = "left";
  if (quests.length === 0) {
    ctx.font = "11px monospace";
    ctx.fillStyle = "#64748b";
    ctx.fillText("Nothing here yet.", listArea.x + 14, listArea.y + 16);
  }

  // Draw Quest List (clipped to listArea)
  ctx.save();
  ctx.beginPath();
  drawRoundedRect(ctx, listArea.x, listArea.y, listArea.w, listArea.h, 10);
  ctx.clip();

  for (const q of quests) {
    if (q.y + q.h < listArea.y || q.y > listArea.y + listArea.h) continue;

    const isSelected = selectedQuest && selectedQuest.key === q.key;
    const isCompleted = q.status === "completed";
    const isActive = q.status === "active";
    const isLocked = q.status === "locked";
    const isTracked = layout.trackedQuestKey === q.key;

    // Item Background
    drawRoundedRect(ctx, q.x, q.y, q.w, q.h, 8);
    ctx.fillStyle = isSelected
      ? "rgba(56, 189, 248, 0.14)"
      : isCompleted
        ? "rgba(34, 197, 94, 0.06)"
        : isLocked
          ? "rgba(15, 15, 24, 0.4)"
          : "rgba(26, 26, 42, 0.5)";
    ctx.fill();

    ctx.strokeStyle = isSelected
      ? "#38bdf8"
      : isCompleted
        ? "rgba(34, 197, 94, 0.2)"
        : isLocked
          ? "rgba(47, 53, 74, 0.4)"
          : "rgba(40, 40, 60, 0.5)";
    ctx.lineWidth = isSelected ? 1.5 : 1;
    ctx.stroke();

    // Left Accent Strip for selected or active quest
    if (isSelected || isActive) {
      drawRoundedRect(ctx, q.x, q.y, 4, q.h, [8, 0, 0, 8]);
      ctx.fillStyle = isSelected ? "#38bdf8" : "#f59e0b";
      ctx.fill();
    }

    // Quest Title
    ctx.fillStyle = isSelected ? "#ffffff" : isCompleted ? "#86efac" : isActive ? "#93c5fd" : isLocked ? "#64748b" : "#e2e8f0";
    ctx.font = "bold 12px monospace";
    const titleStr = `Act ${q.act}: ${q.title}`;
    const truncatedTitle = truncateText(ctx, titleStr, q.w - (isTracked ? 34 : 16));
    ctx.fillText(truncatedTitle, q.x + 10, q.y + 7);

    // Tracked Pin Icon
    if (isTracked) {
      ctx.fillStyle = "#38bdf8";
      ctx.font = "bold 12px monospace";
      ctx.fillText("📌", q.x + q.w - 22, q.y + 7);
    }

    // Status Badge Text
    ctx.fillStyle = isCompleted ? "#4ade80" : isActive ? "#38bdf8" : isLocked ? "#64748b" : "#fde047";
    ctx.font = "11px monospace";
    ctx.fillText(truncateText(ctx, listBadgeText(q, layout.now), q.w - 20), q.x + 10, q.y + 25);
  }
  ctx.restore();

  // Scrollbar indicator
  if (maxScroll > 0) {
    const barW = 4;
    const barX = listArea.x + listArea.w - barW - 3;
    const trackH = listArea.h - 8;
    const thumbH = Math.max(20, Math.floor((listArea.h / totalH) * trackH));
    const thumbY = listArea.y + 4 + Math.floor((scrollY / maxScroll) * (trackH - thumbH));

    drawRoundedRect(ctx, barX, listArea.y + 4, barW, trackH, 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
    ctx.fill();

    drawRoundedRect(ctx, barX, thumbY, barW, thumbH, 2);
    ctx.fillStyle = "#38bdf8";
    ctx.fill();
  }

  // Draw Selected Quest Details
  if (selectedQuest) {
    let dy = detailArea.y + 14;
    const dx = detailArea.x + 16;
    const detailW = detailArea.w - 32;

    // Detail Header Title
    ctx.fillStyle = "#fde047";
    ctx.font = "bold 15px monospace";
    const detailTitle = `[Act ${selectedQuest.act}] ${selectedQuest.title}`;
    const truncatedDetailTitle = truncateText(ctx, detailTitle, detailArea.w - 160);
    ctx.fillText(truncatedDetailTitle, dx, dy);
    dy += 24;

    // Quest Description
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "12px monospace";
    const maxDescWidth = detailW;
    const words = selectedQuest.description.split(" ");
    let currentLine = "";
    for (const word of words) {
      const testLine = currentLine ? currentLine + " " + word : word;
      if (ctx.measureText(testLine).width > maxDescWidth) {
        if (currentLine) ctx.fillText(currentLine, dx, dy);
        dy += 18;
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      ctx.fillText(currentLine, dx, dy);
      dy += 22;
    }

    // Required Level Subtitle
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px monospace";
    ctx.fillText(`Required Level: ${selectedQuest.required_level}`, dx, dy);
    dy += 18;

    // Daily / Challenge / class / standing tags, wrapped onto as many rows as needed.
    const tags = questLabels(selectedQuest, layout.now);
    if (tags.length) {
      let tx = dx;
      for (const tag of tags) {
        const tw = ctx.measureText(tag.text).width + 14;
        if (tx > dx && tx + tw > dx + detailW) { tx = dx; dy += 20; }
        drawRoundedRect(ctx, tx, dy - 2, tw, 17, 8);
        ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
        ctx.fill();
        ctx.strokeStyle = tag.color;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = tag.color;
        ctx.fillText(tag.text, tx + 7, dy);
        tx += tw + 6;
      }
      dy += 22;
    } else {
      dy += 4;
    }

    // --- Quest Objective Card Section ---
    ctx.fillStyle = "#38bdf8";
    ctx.font = "bold 12px monospace";
    ctx.fillText("🎯 Quest Objective:", dx, dy);
    dy += 20;

    const objText = selectedQuest.objective || selectedQuest.description;
    const targetCnt = selectedQuest.target_count || 1;
    const progCnt = selectedQuest.progress_count || 0;

    let statusPrefix = "[✦] ";
    let statusColor = "#fde047";
    let statusProgressStr = `(0/${targetCnt})`;

    if (selectedQuest.status === "completed") {
      statusPrefix = "[✔] ";
      statusColor = "#4ade80";
      statusProgressStr = `(${targetCnt}/${targetCnt})`;
    } else if (selectedQuest.status === "active") {
      statusPrefix = "[⚙] ";
      statusColor = "#60a5fa";
      // A pick quest has nothing to grind: it is met on accept.
      statusProgressStr = selectedQuest.objective_type === "pick" ? `(${targetCnt}/${targetCnt})` : `(${progCnt}/${targetCnt})`;
    } else if (selectedQuest.status === "locked") {
      statusPrefix = "[🔒] ";
      statusColor = "#64748b";
      statusProgressStr = `(Locked)`;
    }

    const fullObjText = selectedQuest.status === "locked"
      ? `[🔒] ${selectedQuest.locked_reason || "Complete previous quest first to unlock"}`
      : `${statusPrefix}${objText} ${statusProgressStr}`;

    // Objective Card Wrapper Box
    const objBoxY = dy;
    const objWords = fullObjText.split(" ");
    const objLines = [];
    let objLine = "";
    const objMaxW = detailW - 24;
    for (const w of objWords) {
      const test = objLine ? objLine + " " + w : w;
      if (ctx.measureText(test).width > objMaxW) {
        if (objLine) objLines.push(objLine);
        objLine = w;
      } else {
        objLine = test;
      }
    }
    if (objLine) objLines.push(objLine);

    const objBoxH = Math.max(36, objLines.length * 18 + 14);

    drawRoundedRect(ctx, dx, objBoxY, detailW, objBoxH, 8);
    ctx.fillStyle = "rgba(56, 189, 248, 0.06)";
    ctx.fill();
    ctx.strokeStyle = "rgba(56, 189, 248, 0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Left accent bar on objective box
    drawRoundedRect(ctx, dx, objBoxY, 4, objBoxH, [8, 0, 0, 8]);
    ctx.fillStyle = statusColor;
    ctx.fill();

    ctx.fillStyle = statusColor;
    ctx.font = "12px monospace";
    let lineY = objBoxY + 8;
    for (const line of objLines) {
      ctx.fillText(line, dx + 12, lineY);
      lineY += 18;
    }
    dy += objBoxH + 16;

    // --- Quest Rewards Card Section ---
    ctx.fillStyle = "#f59e0b";
    ctx.font = "bold 12px monospace";
    ctx.fillText("🎁 Quest Rewards:", dx, dy);
    dy += 20;

    const rewardItems = [];
    if (selectedQuest.exp_reward > 0) {
      rewardItems.push({ text: `⚡ +${selectedQuest.exp_reward} EXP`, color: "#38bdf8" });
    }
    if (selectedQuest.gold_reward > 0) {
      rewardItems.push({ text: `🪙 +${selectedQuest.gold_reward}g Gold`, color: "#fde047" });
    }
    if (selectedQuest.passive_points_reward > 0) {
      rewardItems.push({ text: `✨ +${selectedQuest.passive_points_reward} Passive Points`, color: "#a7f3d0" });
    }
    if (selectedQuest.title_reward) {
      rewardItems.push({ text: `👑 Title${selectedQuest.status === "completed" ? " earned" : ""}: "${selectedQuest.title_reward}"`, color: "#c084fc" });
    }
    if (selectedQuest.item_reward) {
      rewardItems.push({ text: `🎁 Item: ${selectedQuest.item_reward}`, color: "#fda4af" });
    }
    if (selectedQuest.reputation_reward > 0) {
      rewardItems.push({ text: `🤝 +${selectedQuest.reputation_reward} standing`, color: "#86efac" });
    }

    const rewardBoxY = dy;
    const rewardBoxH = Math.max(36, rewardItems.length * 20 + 12);

    drawRoundedRect(ctx, dx, rewardBoxY, detailW, rewardBoxH, 8);
    ctx.fillStyle = "rgba(245, 158, 11, 0.06)";
    ctx.fill();
    ctx.strokeStyle = "rgba(245, 158, 11, 0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Left accent bar on rewards box
    drawRoundedRect(ctx, dx, rewardBoxY, 4, rewardBoxH, [8, 0, 0, 8]);
    ctx.fillStyle = "#f59e0b";
    ctx.fill();

    ctx.font = "12px monospace";
    let rY = rewardBoxY + 8;
    for (const rItem of rewardItems) {
      ctx.fillStyle = rItem.color;
      ctx.fillText(rItem.text, dx + 12, rY);
      rY += 20;
    }

    // --- Action Buttons & Banners ---
    if (layout.actionButtons && layout.actionButtons.length > 0) {
      for (const btn of layout.actionButtons) {
        if (btn.type === "banner" || btn.type === "banner_locked" || btn.type === "banner_in_progress") {
          drawRoundedRect(ctx, btn.x, btn.y, btn.w, btn.h, 8);
          ctx.fillStyle = btn.type === "banner"
            ? "rgba(34, 197, 94, 0.15)"
            : btn.type === "banner_in_progress"
              ? "rgba(56, 189, 248, 0.15)"
              : "rgba(71, 85, 105, 0.25)";
          ctx.fill();
          ctx.strokeStyle = btn.color;
          ctx.lineWidth = 1.2;
          ctx.stroke();

          ctx.fillStyle = btn.color;
          ctx.font = "bold 13px monospace";
          ctx.fillText(btn.text, btn.x + 16, btn.y + 13);
        } else if (btn.kind === "quest_toggle_track") {
          drawRoundedRect(ctx, btn.x, btn.y, btn.w, btn.h, 8);
          ctx.fillStyle = btn.isTracked ? "rgba(56, 189, 248, 0.2)" : "rgba(30, 41, 59, 0.6)";
          ctx.fill();
          ctx.strokeStyle = btn.color;
          ctx.lineWidth = 1.2;
          ctx.stroke();

          ctx.fillStyle = btn.color;
          ctx.font = "bold 11px monospace";
          ctx.fillText(btn.text, btn.x + 12, btn.y + 7);
        } else if (btn.kind === "quest_abandon") {
          drawRoundedRect(ctx, btn.x, btn.y, btn.w, btn.h, 6);
          ctx.fillStyle = "rgba(127, 29, 29, 0.35)";
          ctx.fill();
          ctx.strokeStyle = btn.color;
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.fillStyle = btn.color;
          ctx.font = "bold 11px monospace";
          ctx.fillText(btn.text, btn.x + 12, btn.y + 5);
        } else if (btn.kind === "quest_pick_choice") {
          drawRoundedRect(ctx, btn.x, btn.y, btn.w, btn.h, 6);
          ctx.fillStyle = btn.selected ? "rgba(34, 197, 94, 0.28)" : "rgba(15, 23, 42, 0.95)";
          ctx.fill();
          ctx.strokeStyle = btn.color;
          ctx.lineWidth = btn.selected ? 1.8 : 1;
          ctx.stroke();

          ctx.fillStyle = btn.color;
          ctx.font = "bold 11px monospace";
          ctx.fillText(truncateText(ctx, `${btn.selected ? "◉" : "○"} ${btn.title}`, btn.w - 16), btn.x + 8, btn.y + 4);
          if (btn.sub) {
            ctx.fillStyle = "#cbd5e1";
            ctx.font = "10px monospace";
            ctx.fillText(truncateText(ctx, btn.sub, btn.w - 24), btn.x + 20, btn.y + 17);
          }
        } else if (btn.kind === "quest_choice_city" || btn.kind === "quest_choice_surge") {
          drawRoundedRect(ctx, btn.x, btn.y, btn.w, btn.h, 8);
          ctx.fillStyle = btn.kind === "quest_choice_city" ? "rgba(56, 189, 248, 0.18)" : "rgba(245, 158, 11, 0.18)";
          ctx.fill();
          ctx.strokeStyle = btn.color;
          ctx.lineWidth = 1.2;
          ctx.stroke();

          ctx.fillStyle = btn.color;
          ctx.font = "bold 13px monospace";
          ctx.fillText(btn.title, btn.x + 12, btn.y + 10);
          ctx.fillStyle = "#cbd5e1";
          ctx.font = "11px monospace";
          ctx.fillText(btn.sub, btn.x + 12, btn.y + 32);
        } else {
          drawRoundedRect(ctx, btn.x, btn.y, btn.w, btn.h, 8);
          ctx.fillStyle = btn.disabled ? "rgba(71, 85, 105, 0.25)" : btn.kind === "quest_complete" ? "rgba(34, 197, 94, 0.25)" : "rgba(234, 179, 8, 0.25)";
          ctx.fill();
          ctx.strokeStyle = btn.color;
          ctx.lineWidth = 1.2;
          ctx.stroke();

          ctx.fillStyle = btn.disabled ? "#94a3b8" : "#ffffff";
          ctx.font = "bold 13px monospace";
          ctx.fillText(btn.text, btn.x + 16, btn.y + 13);
        }
      }
    }
  }

  ctx.restore();
}
