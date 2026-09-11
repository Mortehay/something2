// frontend/src/games/something2/src/js/systems/skillsPanel.js
// Universal layout and rendering for the in-game Skills Panel (Ability Book).
// Supports all 300 skills across all 6 classes, category filters, class filters, and form indicators.

import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import {
  getSkillsForClass,
  getRequiredForm,
  isTransformationSkill,
  getSkillPrice,
  getSkillTier,
  getSkillTierName,
  getSkillTierNameUk,
  getSkillLevelReq,
  resolveSkillDamage,
  SKILLS,
} from "../core/skillsData.js";

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
    playerGold = 0,
    playerLevel = 1,
    unlockedSkills = null,
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
    gold: typeof playerGold === "number" ? playerGold : (typeof state.gold === "number" ? state.gold : 0),
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
  const currentGold = typeof playerGold === "number" ? playerGold : (typeof state.gold === "number" ? state.gold : 0);
  const currentLevel = typeof playerLevel === "number" ? playerLevel : 1;

  for (let i = 0; i < visible.length; i++) {
    const s = visible[i];
    const ry = listY + i * (ITEM_H + 6);
    const isUnlocked = unlockedSkills instanceof Set
      ? unlockedSkills.has(s.id)
      : (Array.isArray(unlockedSkills) ? unlockedSkills.includes(s.id) : (unlockedSkills === null ? true : false));
    const price = s.price || getSkillPrice(s);
    const tier = s.tier || getSkillTier(s);
    const tierName = getSkillTierName(tier);
    const levelReq = s.levelReq || getSkillLevelReq(s);
    const damageInfo = s.damageInfo || resolveSkillDamage(s);
    const canAfford = currentGold >= price;
    const meetsLevel = currentLevel >= levelReq;

    const btnW = 126;
    const btnH = 26;
    const btnX = px + PANEL_W - PAD - btnW - 6;
    const btnY = ry + Math.round((ITEM_H - btnH) / 2);

    const buyBtn = !isUnlocked ? {
      x: btnX,
      y: btnY,
      w: btnW,
      h: btnH,
      price,
      canAfford,
      meetsLevel,
      skillId: s.id,
    } : null;

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
      isUnlocked,
      price,
      tier,
      tierName,
      levelReq,
      damageInfo,
      buyBtn,
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
    ...rows.map(r => ({ kind: "skills_item", skillId: r.skill.id, skill: r.skill, isUnlocked: r.isUnlocked, box: r })),
    ...rows.filter(r => r.buyBtn).map(r => ({ kind: "skills_buy", skillId: r.skill.id, skill: r.skill, price: r.price, levelReq: r.levelReq, box: r.buyBtn })),
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
    playerGold: currentGold,
    playerLevel: currentLevel,
  };
}

export function drawSkillsPanel(ctx, layout, state) {
  const {
    panel, title, close, classTabs, tabs, rows,
    prevBtn, nextBtn, footerY, currentPage, totalPages, totalCount, playerGold,
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

  // Player Gold Display in Title Bar
  const goldText = `💰 ${typeof playerGold === "number" ? playerGold.toLocaleString() : 0} Gold`;
  ctx.font = "bold 12px monospace";
  ctx.textAlign = "right";
  ctx.fillStyle = "#facc15";
  ctx.fillText(goldText, close.x - 14, title.y + title.h / 2);

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

  // 5. Skill Rows (With Stats, Tier, Damage, Price & Buy Button)
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

    // Border color based on Tier
    const tierBorderColors = ["#4ade80", "#60a5fa", "#c084fc", "#facc15", "#f43f5e"];
    ctx.strokeStyle = tierBorderColors[(r.tier || 1) - 1] || (s.iconColor || "#a855f7");
    ctx.lineWidth = 1.5;
    ctx.strokeRect(iconBoxX, iconBoxY, iconBoxS, iconBoxS);

    ctx.font = "24px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.icon || "⚔️", iconBoxX + iconBoxS / 2, iconBoxY + iconBoxS / 2 + 1);

    // Text details
    const textX = iconBoxX + iconBoxS + 10;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    // Line 1: Skill Name + Class Tag + Type Tag + Tier Badge + Req Level
    ctx.font = "bold 13px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(s.nameEn || s.nameUk, textX, r.y + 5);
    const nameWidth = ctx.measureText(s.nameEn || s.nameUk).width;

    // Badges
    let badgeX = textX + nameWidth + 8;
    ctx.font = "bold 9px monospace";

    // Tier badge
    const tierColors = ["#4ade80", "#60a5fa", "#c084fc", "#facc15", "#f43f5e"];
    ctx.fillStyle = tierColors[(r.tier || 1) - 1] || "#c084fc";
    const tierLabel = `[T${r.tier || 1} ${r.tierName || "NOVICE"}]`;
    ctx.fillText(tierLabel, badgeX, r.y + 6);
    badgeX += ctx.measureText(tierLabel).width + 5;

    // Level requirement badge
    ctx.fillStyle = r.levelReq > 1 ? "#38bdf8" : "#94a3b8";
    const lvlLabel = `[LVL ${r.levelReq || 1}]`;
    ctx.fillText(lvlLabel, badgeX, r.y + 6);
    badgeX += ctx.measureText(lvlLabel).width + 5;

    // Class badge
    ctx.fillStyle = "#facc15";
    ctx.fillText(`[${(s.class || "ALL").toUpperCase()}]`, badgeX, r.y + 6);
    badgeX += ctx.measureText(`[${(s.class || "ALL").toUpperCase()}]`).width + 5;

    // Form badge
    if (r.isTransform) {
      ctx.fillStyle = "#38bdf8";
      ctx.fillText("[TRANSFORMATION]", badgeX, r.y + 6);
      badgeX += ctx.measureText("[TRANSFORMATION]").width + 5;
    } else if (r.reqForm) {
      ctx.fillStyle = "#fb923c";
      ctx.fillText(`[${r.reqForm.toUpperCase()} FORM]`, badgeX, r.y + 6);
      badgeX += ctx.measureText(`[${r.reqForm.toUpperCase()} FORM]`).width + 5;
    }

    // Line 2: Damage/Power, Cost, Cooldown, Range
    ctx.font = "11px monospace";
    const dmgText = r.damageInfo ? `⚡ ${r.damageInfo.text}` : "";
    const costText = `${s.cost} ${s.costType.toUpperCase()}`;
    const cdText = `${s.cooldown}s CD`;
    const rangeText = s.range > 60 ? `Range ${s.range}px` : `Melee ${s.range}px`;
    ctx.fillStyle = "#a5f3fc";
    ctx.fillText(`${dmgText}  ·  ${costText}  ·  ${cdText}  ·  ${rangeText}`, textX, r.y + 23);

    // Line 3: Description
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#cbd5e1";
    const maxDescW = r.w - (textX - r.x) - 145;
    ctx.fillText(s.descEn || s.descUk, textX, r.y + 41, maxDescW);

    // Right Action: Unlocked badge or Buy button
    if (r.isUnlocked) {
      // Unlocked indicator
      const unlX = r.x + r.w - 135;
      const unlY = r.y + Math.round((ITEM_H - 24) / 2);
      ctx.fillStyle = "rgba(22, 101, 52, 0.4)";
      ctx.fillRect(unlX, unlY, 126, 24);
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 1;
      ctx.strokeRect(unlX, unlY, 126, 24);

      ctx.fillStyle = "#4ade80";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("✓ LEARNED", unlX + 63, unlY + 12);
    } else if (r.buyBtn) {
      const b = r.buyBtn;
      ctx.save();
      if (!b.meetsLevel) {
        ctx.fillStyle = "rgba(127, 29, 29, 0.75)";
        ctx.strokeStyle = "#ef4444";
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.fillStyle = "#fca5a5";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`🔒 Requires Lvl ${r.levelReq}`, b.x + b.w / 2, b.y + b.h / 2);
      } else if (!b.canAfford) {
        ctx.fillStyle = "rgba(120, 53, 15, 0.8)";
        ctx.strokeStyle = "#f59e0b";
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.fillStyle = "#fde68a";
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`🪙 ${b.price.toLocaleString()}g (Need Gold)`, b.x + b.w / 2, b.y + b.h / 2);
      } else {
        const btnGrad = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
        btnGrad.addColorStop(0, "rgba(217, 119, 6, 0.95)");
        btnGrad.addColorStop(1, "rgba(146, 64, 14, 0.95)");
        ctx.fillStyle = btnGrad;
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 11px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`🪙 Buy: ${b.price.toLocaleString()}g`, b.x + b.w / 2, b.y + b.h / 2);
      }
      ctx.restore();
    }

    ctx.restore();
  }

  // 6. Footer
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#c084fc";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const hintText = "💡 Purchase abilities from Skill Trainer and drag learned skills onto slots 1–9";
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
