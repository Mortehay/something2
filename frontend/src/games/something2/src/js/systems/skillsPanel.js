// frontend/src/games/something2/src/js/systems/skillsPanel.js
// Universal layout and rendering for the in-game Skills Panel (Ability Book).
// Supports all 300 skills across all 6 classes, category filters, class filters, and form indicators.

import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import { getSkillsForClass, getRequiredForm, isTransformationSkill, SKILLS } from "../core/skillsData.js";

export const PANEL_W = 760;
export const PANEL_H = 510;
const PAD = 14;
const TITLE_H = 32;
const CLASS_TAB_H = 24;
const CAT_TAB_H = 24;
const ITEM_H = 62;
const ITEMS_PER_PAGE = 5;

export const CLASS_TABS = [
  { key: "all", label: "All Classes" },
  { key: "Warrior", label: "Warrior" },
  { key: "Mage", label: "Mage" },
  { key: "Monk", label: "Monk" },
  { key: "Cultist", label: "Cultist" },
  { key: "Archer", label: "Archer" },
  { key: "Druid", label: "Druid" },
];

export const SKILL_TABS = [
  { key: "all", label: "All Types" },
  { key: "melee", label: "Melee" },
  { key: "magic", label: "Magic" },
  { key: "buff", label: "Buffs" },
  { key: "debuff", label: "Debuffs" },
];

export function layoutSkillsPanel(state) {
  const {
    className = "Druid",
    classFilter = "all",
    tab = "all",
    page = 0,
    selectedSkillId = null,
    drag = null,
  } = state;

  const effectiveClass = classFilter || "all";

  const px = Math.round((GAME_WIDTH - PANEL_W) / 2);
  const py = Math.round((GAME_HEIGHT - PANEL_H) / 2);
  const panel = { x: px, y: py, w: PANEL_W, h: PANEL_H };

  const title = {
    x: px,
    y: py,
    w: PANEL_W,
    h: TITLE_H,
    label: `Ability Book & Skills — ${effectiveClass === "all" ? "All Classes (300 Skills)" : effectiveClass}`,
  };

  const close = {
    x: px + PANEL_W - 28,
    y: py + 4,
    w: 24,
    h: 24,
  };

  // 1. Class Filter Tabs (Top row)
  const classTabs = [];
  const cTabW = Math.round((PANEL_W - PAD * 2 - (CLASS_TABS.length - 1) * 4) / CLASS_TABS.length);
  let cx = px + PAD;
  const cy = py + TITLE_H + 6;
  for (const c of CLASS_TABS) {
    classTabs.push({
      key: c.key,
      label: c.label,
      x: cx,
      y: cy,
      w: cTabW,
      h: CLASS_TAB_H,
      active: effectiveClass === c.key,
    });
    cx += cTabW + 4;
  }

  // 2. Category Filter Tabs (Second row)
  const tabs = [];
  const catTabW = Math.round((PANEL_W - PAD * 2 - (SKILL_TABS.length - 1) * 6) / SKILL_TABS.length);
  let tx = px + PAD;
  const ty = cy + CLASS_TAB_H + 5;
  for (const t of SKILL_TABS) {
    tabs.push({
      key: t.key,
      label: t.label,
      x: tx,
      y: ty,
      w: catTabW,
      h: CAT_TAB_H,
      active: tab === t.key,
    });
    tx += catTabW + 6;
  }

  // Filter skills
  let pool = effectiveClass === "all" ? SKILLS : getSkillsForClass(effectiveClass);
  if (tab !== "all") {
    pool = pool.filter(s => s.type === tab);
  }

  const totalPages = Math.max(1, Math.ceil(pool.length / ITEMS_PER_PAGE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = currentPage * ITEMS_PER_PAGE;
  const visible = pool.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  // Skill rows (5 items per page)
  const listY = ty + CAT_TAB_H + 8;
  const rows = [];
  for (let i = 0; i < visible.length; i++) {
    const s = visible[i];
    const ry = listY + i * (ITEM_H + 6);
    rows.push({
      skill: s,
      x: px + PAD,
      y: ry,
      w: PANEL_W - PAD * 2,
      h: ITEM_H,
      selected: selectedSkillId === s.id,
      dragged: drag && drag.skillId === s.id,
      reqForm: getRequiredForm(s),
      isTransform: isTransformationSkill(s),
    });
  }

  // Footer area
  const footerY = py + PANEL_H - 42;
  const prevBtn = currentPage > 0
    ? { x: px + PAD, y: footerY + 8, w: 90, h: 26, label: "◀ Prev" }
    : null;
  const nextBtn = currentPage < totalPages - 1
    ? { x: px + PANEL_W - PAD - 90, y: footerY + 8, w: 90, h: 26, label: "Next ▶" }
    : null;

  const hitAreas = [
    { kind: "skills_close", box: close },
    ...classTabs.map(c => ({ kind: "skills_class_filter", key: c.key, box: c })),
    ...tabs.map(t => ({ kind: "skills_tab", key: t.key, box: t })),
    ...rows.map(r => ({ kind: "skills_item", skillId: r.skill.id, skill: r.skill, box: r })),
  ];
  if (prevBtn) hitAreas.push({ kind: "skills_page_prev", box: prevBtn });
  if (nextBtn) hitAreas.push({ kind: "skills_page_next", box: nextBtn });

  return {
    panel,
    title,
    close,
    classTabs,
    tabs,
    rows,
    prevBtn,
    nextBtn,
    footerY,
    currentPage,
    totalPages,
    totalCount: pool.length,
    hitAreas,
  };
}

export function drawSkillsPanel(ctx, layout, state) {
  const {
    panel, title, close, classTabs, tabs, rows,
    prevBtn, nextBtn, footerY, currentPage, totalPages, totalCount,
  } = layout;

  ctx.save();

  // 1. Panel Background Frame
  ctx.fillStyle = "rgba(10, 8, 20, 0.96)";
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  ctx.strokeStyle = "#581c87";
  ctx.lineWidth = 2;
  ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);

  // 2. Title Bar
  const titleGrad = ctx.createLinearGradient(title.x, title.y, title.x, title.y + title.h);
  titleGrad.addColorStop(0, "rgba(59, 7, 100, 0.95)");
  titleGrad.addColorStop(1, "rgba(30, 6, 52, 0.95)");
  ctx.fillStyle = titleGrad;
  ctx.fillRect(title.x, title.y, title.w, title.h);

  ctx.fillStyle = "#f3e8ff";
  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(title.label, title.x + 12, title.y + title.h / 2);

  // Close Button
  ctx.fillStyle = "rgba(185, 28, 28, 0.85)";
  ctx.fillRect(close.x, close.y, close.w, close.h);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("✕", close.x + close.w / 2, close.y + close.h / 2);

  // 3. Class Filter Tabs (Row 1)
  ctx.font = "bold 10px sans-serif";
  for (const c of classTabs) {
    if (c.active) {
      ctx.fillStyle = "rgba(147, 51, 234, 0.9)";
      ctx.strokeStyle = "#e9d5ff";
      ctx.lineWidth = 1.5;
    } else {
      ctx.fillStyle = "rgba(30, 20, 48, 0.75)";
      ctx.strokeStyle = "rgba(126, 34, 206, 0.6)";
      ctx.lineWidth = 1;
    }
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.strokeRect(c.x, c.y, c.w, c.h);

    ctx.fillStyle = c.active ? "#ffffff" : "#c4b5fd";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(c.label, c.x + c.w / 2, c.y + c.h / 2);
  }

  // 4. Category Tabs (Row 2)
  ctx.font = "bold 10px sans-serif";
  for (const t of tabs) {
    if (t.active) {
      ctx.fillStyle = "rgba(88, 28, 135, 0.95)";
      ctx.strokeStyle = "#c084fc";
      ctx.lineWidth = 1.5;
    } else {
      ctx.fillStyle = "rgba(22, 14, 38, 0.75)";
      ctx.strokeStyle = "rgba(88, 28, 135, 0.5)";
      ctx.lineWidth = 1;
    }
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.strokeRect(t.x, t.y, t.w, t.h);

    ctx.fillStyle = t.active ? "#f5d0fe" : "#a855f7";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(t.label, t.x + t.w / 2, t.y + t.h / 2);
  }

  // 5. Skill Rows (Clean English display, class & form tags, non-overlapping)
  for (const r of rows) {
    const s = r.skill;
    ctx.save();
    if (r.dragged) ctx.globalAlpha = 0.35;

    // Row backdrop
    const rowGrad = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
    if (r.selected) {
      rowGrad.addColorStop(0, "rgba(88, 28, 135, 0.9)");
      rowGrad.addColorStop(1, "rgba(49, 10, 80, 0.95)");
      ctx.strokeStyle = "#e879f9";
      ctx.lineWidth = 1.5;
    } else {
      rowGrad.addColorStop(0, "rgba(20, 14, 36, 0.88)");
      rowGrad.addColorStop(1, "rgba(12, 8, 24, 0.96)");
      ctx.strokeStyle = "rgba(88, 28, 135, 0.55)";
      ctx.lineWidth = 1;
    }
    ctx.fillStyle = rowGrad;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // Skill Icon Box
    const iconBoxX = r.x + 8;
    const iconBoxY = r.y + 7;
    const iconBoxS = 48;
    ctx.fillStyle = "rgba(8, 5, 15, 0.95)";
    ctx.fillRect(iconBoxX, iconBoxY, iconBoxS, iconBoxS);
    ctx.strokeStyle = s.iconColor || "#a855f7";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(iconBoxX, iconBoxY, iconBoxS, iconBoxS);

    ctx.font = "24px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.icon || "⚔️", iconBoxX + iconBoxS / 2, iconBoxY + iconBoxS / 2 + 1);

    // Text details
    const textX = iconBoxX + iconBoxS + 12;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    // Line 1: Skill Name + Class Tag + Type Tag + Form Requirement Badge
    ctx.font = "bold 13px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(s.nameEn || s.nameUk, textX, r.y + 6);
    const nameWidth = ctx.measureText(s.nameEn || s.nameUk).width;

    // Badges
    let badgeX = textX + nameWidth + 8;
    ctx.font = "bold 9px monospace";

    // Class badge
    ctx.fillStyle = "#facc15";
    ctx.fillText(`[${(s.class || "ALL").toUpperCase()}]`, badgeX, r.y + 7);
    badgeX += ctx.measureText(`[${(s.class || "ALL").toUpperCase()}]`).width + 6;

    // Type badge
    ctx.fillStyle = s.type === "melee" ? "#f87171" : (s.type === "magic" ? "#60a5fa" : (s.type === "buff" ? "#4ade80" : "#c084fc"));
    ctx.fillText(`[${(s.type || "skill").toUpperCase()}]`, badgeX, r.y + 7);
    badgeX += ctx.measureText(`[${(s.type || "skill").toUpperCase()}]`).width + 6;

    // Form badge
    if (r.isTransform) {
      ctx.fillStyle = "#38bdf8";
      ctx.fillText("[TRANSFORMATION]", badgeX, r.y + 7);
      badgeX += ctx.measureText("[TRANSFORMATION]").width + 6;
      ctx.fillStyle = "#34d399";
      ctx.fillText("[DRUID ONLY]", badgeX, r.y + 7);
    } else if (r.reqForm) {
      ctx.fillStyle = "#fb923c";
      ctx.fillText(`[REQUIRES ${r.reqForm.toUpperCase()} FORM]`, badgeX, r.y + 7);
      badgeX += ctx.measureText(`[REQUIRES ${r.reqForm.toUpperCase()} FORM]`).width + 6;
      ctx.fillStyle = "#34d399";
      ctx.fillText("[DRUID ONLY]", badgeX, r.y + 7);
    }

    // Line 2: Cost, Cooldown, Range
    ctx.font = "11px monospace";
    const costText = `${s.cost} ${s.costType.toUpperCase()}`;
    const cdText = `${s.cooldown}s CD`;
    const rangeText = s.range > 60 ? `Ranged (${s.range}px)` : `Melee (${s.range}px)`;
    ctx.fillStyle = s.costType === "hp" ? "#fca5a5" : (s.costType === "mana" ? "#93c5fd" : "#fde047");
    ctx.fillText(`${costText}  ·  ${cdText}  ·  ${rangeText}`, textX, r.y + 24);

    // Line 3: Description (English)
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#cbd5e1";
    const maxDescW = r.w - (textX - r.x) - 12;
    ctx.fillText(s.descEn || s.descUk, textX, r.y + 41, maxDescW);

    ctx.restore();
  }

  // 6. Footer
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#c084fc";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const hintText = "💡 Drag & Drop onto hotbar slots 1–9 or select and press 1–9";
  ctx.fillText(hintText, panel.x + panel.w / 2, footerY - 12);

  // Page info
  ctx.font = "bold 11px monospace";
  ctx.fillStyle = "#94a3b8";
  ctx.fillText(`Page ${currentPage + 1} of ${totalPages} (${totalCount} skills)`, panel.x + panel.w / 2, footerY + 14);

  // Pagination Buttons
  if (prevBtn) {
    ctx.fillStyle = "rgba(59, 7, 100, 0.85)";
    ctx.fillRect(prevBtn.x, prevBtn.y, prevBtn.w, prevBtn.h);
    ctx.strokeStyle = "#a855f7";
    ctx.strokeRect(prevBtn.x, prevBtn.y, prevBtn.w, prevBtn.h);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(prevBtn.label, prevBtn.x + prevBtn.w / 2, prevBtn.y + prevBtn.h / 2);
  }
  if (nextBtn) {
    ctx.fillStyle = "rgba(59, 7, 100, 0.85)";
    ctx.fillRect(nextBtn.x, nextBtn.y, nextBtn.w, nextBtn.h);
    ctx.strokeStyle = "#a855f7";
    ctx.strokeRect(nextBtn.x, nextBtn.y, nextBtn.w, nextBtn.h);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(nextBtn.label, nextBtn.x + nextBtn.w / 2, nextBtn.y + nextBtn.h / 2);
  }

  ctx.restore();
}
