// frontend/src/games/something2/src/js/systems/questLogPanel.js
//
// Pure layout and Canvas 2D renderer for the Quest Log window (hotkey 'J').

import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";

export const QUEST_PANEL_W = 760;
export const QUEST_PANEL_H = 520;
const TITLE_H = 34;

export function layoutQuestLog(state = {}) {
  const {
    quests = [],
    legacyChoice = null,
    activeQuestKey = null,
  } = state;

  const px = (GAME_WIDTH - QUEST_PANEL_W) / 2;
  const py = (GAME_HEIGHT - QUEST_PANEL_H) / 2;

  const panel = { x: px, y: py, w: QUEST_PANEL_W, h: QUEST_PANEL_H };
  const title = { x: px, y: py, w: QUEST_PANEL_W, h: TITLE_H };
  const close = { x: px + QUEST_PANEL_W - 28, y: py + 6, w: 22, h: 22 };

  const hitAreas = [{ ...close, kind: "questclose", id: null }];

  const listArea = { x: px + 12, y: py + TITLE_H + 12, w: 260, h: QUEST_PANEL_H - TITLE_H - 24 };
  const detailArea = { x: px + 284, y: py + TITLE_H + 12, w: QUEST_PANEL_W - 296, h: QUEST_PANEL_H - TITLE_H - 24 };

  const questItems = [];
  let itemY = listArea.y;
  for (const q of quests) {
    const itemRect = { x: listArea.x, y: itemY, w: listArea.w, h: 42 };
    questItems.push({ ...q, ...itemRect });
    hitAreas.push({ ...itemRect, kind: "selectquest", key: q.key });
    itemY += 46;
  }

  const selectedQuest = quests.find(q => q.key === activeQuestKey) || quests[0] || null;

  let actionButtons = [];
  if (selectedQuest) {
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
    } else if (selectedQuest.status === "active") {
      if (selectedQuest.act === 4 && (!legacyChoice || selectedQuest.key === "act4_new_dawn" || selectedQuest.key === "act4_primordial_core")) {
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
          sub: "+15% MF / +20% Yield (Primal Might)",
          color: "#f59e0b",
        };
        actionButtons.push(cityBtn, surgeBtn);
        hitAreas.push(cityBtn, surgeBtn);
      } else {
        const completeBtn = {
          kind: "quest_complete",
          questId: selectedQuest.id,
          questKey: selectedQuest.key,
          x: detailArea.x + 14,
          y: btnY,
          w: detailArea.w - 28,
          h: 42,
          text: "✔ Complete Quest & Claim Rewards",
          color: "#22c55e",
        };
        actionButtons.push(completeBtn);
        hitAreas.push(completeBtn);
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
    quests: questItems, selectedQuest, legacyChoice, actionButtons,
    header: {
      titleText: "📜 Quest Log (Hotkey 'J')",
      choiceText: legacyChoice === "city_restoration"
        ? "✨ Legacy: City Restoration (-15% Vendor Prices)"
        : legacyChoice === "elemental_surge"
          ? "⚡ Legacy: Elemental Surge (+15% MF / +20% Yield)"
          : "⏳ Unchosen Legacy (Act IV)",
    },
  };
}

export function drawQuestLog(ctx, layout) {
  if (!layout) return;

  const { panel, title, close, listArea, detailArea, quests, selectedQuest, header } = layout;

  ctx.save();
  ctx.textBaseline = "top";

  // Main Background
  ctx.fillStyle = "rgba(12, 10, 8, 0.96)";
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  ctx.strokeStyle = "#4a3c2c";
  ctx.lineWidth = 2;
  ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);

  // Title Bar
  ctx.fillStyle = "rgba(24, 18, 14, 0.98)";
  ctx.fillRect(title.x, title.y, title.w, title.h);
  ctx.fillStyle = "#fde68a";
  ctx.font = "bold 14px monospace";
  ctx.fillText(header.titleText, title.x + 12, title.y + 8);

  ctx.fillStyle = "#a7f3d0";
  ctx.font = "12px monospace";
  ctx.fillText(header.choiceText, title.x + 360, title.y + 9);

  // Close Button
  ctx.fillStyle = "rgba(140, 35, 35, 0.9)";
  ctx.fillRect(close.x, close.y, close.w, close.h);
  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 13px monospace";
  ctx.fillText("✕", close.x + 6, close.y + 4);

  // Left List Area Box
  ctx.fillStyle = "rgba(18, 15, 12, 0.9)";
  ctx.fillRect(listArea.x, listArea.y, listArea.w, listArea.h);
  ctx.strokeStyle = "#382e21";
  ctx.strokeRect(listArea.x, listArea.y, listArea.w, listArea.h);

  // Right Detail Box
  ctx.fillStyle = "rgba(18, 15, 12, 0.9)";
  ctx.fillRect(detailArea.x, detailArea.y, detailArea.w, detailArea.h);
  ctx.strokeStyle = "#382e21";
  ctx.strokeRect(detailArea.x, detailArea.y, detailArea.w, detailArea.h);

  // Draw Quest List
  for (const q of quests) {
    const isSelected = selectedQuest && selectedQuest.key === q.key;
    ctx.fillStyle = isSelected ? "rgba(45, 35, 20, 0.95)" : "rgba(25, 20, 16, 0.6)";
    ctx.fillRect(q.x, q.y, q.w, q.h);
    ctx.strokeStyle = isSelected ? "#f59e0b" : "#2d2419";
    ctx.strokeRect(q.x, q.y, q.w, q.h);

    const isCompleted = q.status === "completed";
    const isActive = q.status === "active";

    ctx.fillStyle = isCompleted ? "#4ade80" : isActive ? "#60a5fa" : "#e2e8f0";
    ctx.font = "bold 12px monospace";
    ctx.fillText(`Act ${q.act}: ${q.title}`, q.x + 8, q.y + 6);

    ctx.fillStyle = isCompleted ? "#86efac" : isActive ? "#93c5fd" : "#94a3b8";
    ctx.font = "11px monospace";
    ctx.fillText(isCompleted ? "✔ Completed" : isActive ? "⚙ Active" : "✦ Available", q.x + 8, q.y + 24);
  }

  // Draw Selected Quest Detail
  if (selectedQuest) {
    let dy = detailArea.y + 12;
    const dx = detailArea.x + 14;

    ctx.fillStyle = "#fde047";
    ctx.font = "bold 16px monospace";
    ctx.fillText(`[Act ${selectedQuest.act}] ${selectedQuest.title}`, dx, dy);
    dy += 24;

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "12px monospace";
    const descWords = selectedQuest.description.split(" ");
    let line = "";
    for (const w of descWords) {
      if (ctx.measureText(line + w).width > detailArea.w - 30) {
        ctx.fillText(line, dx, dy);
        dy += 18;
        line = "";
      }
      line += w + " ";
    }
    if (line) {
      ctx.fillText(line, dx, dy);
      dy += 24;
    }

    // Quest Meta
    dy += 10;
    ctx.fillStyle = "#94a3b8";
    ctx.font = "12px monospace";
    ctx.fillText(`Required Level: ${selectedQuest.required_level}`, dx, dy);
    dy += 18;

    // Rewards Header
    dy += 10;
    ctx.fillStyle = "#f59e0b";
    ctx.font = "bold 13px monospace";
    ctx.fillText("🎁 Quest Rewards:", dx, dy);
    dy += 20;

    ctx.fillStyle = "#38bdf8";
    ctx.font = "12px monospace";
    if (selectedQuest.exp_reward > 0) {
      ctx.fillText(`• Experience: +${selectedQuest.exp_reward} EXP`, dx + 8, dy);
      dy += 18;
    }
    if (selectedQuest.gold_reward > 0) {
      ctx.fillStyle = "#fde047";
      ctx.fillText(`• Gold: +${selectedQuest.gold_reward}g`, dx + 8, dy);
      dy += 18;
    }
    if (selectedQuest.passive_points_reward > 0) {
      ctx.fillStyle = "#a7f3d0";
      ctx.fillText(`• Passive Points: +${selectedQuest.passive_points_reward} pt`, dx + 8, dy);
      dy += 18;
    }
    if (selectedQuest.title_reward) {
      ctx.fillStyle = "#c084fc";
      ctx.fillText(`• Title: "${selectedQuest.title_reward}"`, dx + 8, dy);
      dy += 18;
    }

    // Action buttons & legacy choices
    if (layout.actionButtons && layout.actionButtons.length > 0) {
      for (const btn of layout.actionButtons) {
        if (btn.type === "banner") {
          ctx.fillStyle = "rgba(34, 197, 94, 0.15)";
          ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
          ctx.strokeStyle = "#22c55e";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(btn.x, btn.y, btn.w, btn.h);
          ctx.fillStyle = "#4ade80";
          ctx.font = "bold 13px monospace";
          ctx.fillText(btn.text, btn.x + 14, btn.y + 14);
        } else if (btn.kind === "quest_choice_city" || btn.kind === "quest_choice_surge") {
          ctx.fillStyle = btn.kind === "quest_choice_city" ? "rgba(56, 189, 248, 0.2)" : "rgba(245, 158, 11, 0.2)";
          ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
          ctx.strokeStyle = btn.color;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(btn.x, btn.y, btn.w, btn.h);
          ctx.fillStyle = btn.color;
          ctx.font = "bold 13px monospace";
          ctx.fillText(btn.title, btn.x + 10, btn.y + 10);
          ctx.fillStyle = "#cbd5e1";
          ctx.font = "11px monospace";
          ctx.fillText(btn.sub, btn.x + 10, btn.y + 32);
        } else {
          ctx.fillStyle = btn.kind === "quest_complete" ? "rgba(34, 197, 94, 0.25)" : "rgba(234, 179, 8, 0.25)";
          ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
          ctx.strokeStyle = btn.color;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(btn.x, btn.y, btn.w, btn.h);
          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 13px monospace";
          ctx.fillText(btn.text, btn.x + 16, btn.y + 14);
        }
      }
    }
  }

  ctx.restore();
}
