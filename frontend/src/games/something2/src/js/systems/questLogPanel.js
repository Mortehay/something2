// frontend/src/games/something2/src/js/systems/questLogPanel.js
//
// Pure layout and Canvas 2D renderer for the Quest Log window (hotkey 'J').

import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";

export const QUEST_PANEL_W = 760;
export const QUEST_PANEL_H = 520;
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

export function layoutQuestLog(state = {}) {
  const {
    quests = [],
    legacyChoice = null,
    activeQuestKey = null,
    questScroll = 0,
  } = state;

  const px = (GAME_WIDTH - QUEST_PANEL_W) / 2;
  const py = (GAME_HEIGHT - QUEST_PANEL_H) / 2;

  const panel = { x: px, y: py, w: QUEST_PANEL_W, h: QUEST_PANEL_H };
  const title = { x: px, y: py, w: QUEST_PANEL_W, h: TITLE_H };
  const close = { x: px + QUEST_PANEL_W - 32, y: py + 8, w: 24, h: 24 };

  const hitAreas = [{ ...close, kind: "questclose", id: null }];

  const listArea = { x: px + 14, y: py + TITLE_H + 12, w: 260, h: QUEST_PANEL_H - TITLE_H - 26 };
  const detailArea = { x: px + 288, y: py + TITLE_H + 12, w: QUEST_PANEL_W - 302, h: QUEST_PANEL_H - TITLE_H - 26 };

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

  const trackedQuestKey = state.trackedQuestKey || (quests.find(q => q.status === "active")?.key || activeQuestKey);
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
        text: "🔒 Locked: Complete previous quest first.",
        color: "#64748b",
      });
    } else if (selectedQuest.status === "active") {
      const progCnt = selectedQuest.progress_count || 0;
      const targetCnt = selectedQuest.target_count || 1;
      const isObjectiveComplete = progCnt >= targetCnt;

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
    totalH, maxScroll, scrollY,
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
    ctx.fillText(isCompleted ? "✔ Completed" : isActive ? "⚙ Active" : isLocked ? "🔒 Locked" : "✦ Available", q.x + 10, q.y + 25);
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
    dy += 22;

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
      statusProgressStr = `(${progCnt}/${targetCnt})`;
    } else if (selectedQuest.status === "locked") {
      statusPrefix = "[🔒] ";
      statusColor = "#64748b";
      statusProgressStr = `(Locked)`;
    }

    const fullObjText = selectedQuest.status === "locked"
      ? "[🔒] Complete previous quest first to unlock"
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
      rewardItems.push({ text: `👑 Title: "${selectedQuest.title_reward}"`, color: "#c084fc" });
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
          ctx.fillStyle = btn.kind === "quest_complete" ? "rgba(34, 197, 94, 0.25)" : "rgba(234, 179, 8, 0.25)";
          ctx.fill();
          ctx.strokeStyle = btn.color;
          ctx.lineWidth = 1.2;
          ctx.stroke();

          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 13px monospace";
          ctx.fillText(btn.text, btn.x + 16, btn.y + 13);
        }
      }
    }
  }

  ctx.restore();
}
