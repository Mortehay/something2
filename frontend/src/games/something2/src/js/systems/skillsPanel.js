// frontend/src/games/something2/src/js/systems/skillsPanel.js
// Skill Gem Socketing Board (Hotbar Sockets 1–9) & Inventory Gems.
// Replaces the old static ability book with an interactive 9-slot PoE-style socketing board.

import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import {
  getSkillsForClass, getSkillById, SKILLS, checkGemRequirements, getWeaponRequirementName,
} from "../core/skillsData.js";

export const PANEL_W = 840;
export const PANEL_H = 550;
const PAD = 14;
const TITLE_H = 34;
const TAB_H = 24;

export const GEM_FILTER_TABS = [
  { key: "inventory", label: "🎒 In Inventory" },
  { key: "all", label: "All Catalog (300)" },
  { key: "str", label: "🔴 STR" },
  { key: "dex", label: "🟢 DEX" },
  { key: "con", label: "🛡️ CON" },
  { key: "int", label: "🔵 INT" },
  { key: "wis", label: "✨ WIS" },
  { key: "cha", label: "🔮 CHA" },
];

export function layoutSkillsPanel(state) {
  const {
    tab = "inventory",
    page = 0,
    selectedSkillId = null,
    drag = null,
    playerStats = null,
    equippedWeapon = null,
    hotbarSkills = new Map(),
    inventoryGems = [],
  } = state;

  const px = Math.round((GAME_WIDTH - PANEL_W) / 2);
  const py = Math.round((GAME_HEIGHT - PANEL_H) / 2);
  const panel = { x: px, y: py, w: PANEL_W, h: PANEL_H };

  const title = {
    x: px,
    y: py,
    w: PANEL_W,
    h: TITLE_H,
    label: "💎 Skill Gem Sockets (Hotbar 1–9) — Socket Board",
  };

  const close = {
    x: px + PANEL_W - 28,
    y: py + 5,
    w: 24,
    h: 24,
  };

  // -------------------------------------------------------------------------
  // 1. Top Section: 9 Hotbar Sockets (3 columns x 3 rows)
  // -------------------------------------------------------------------------
  const socketCols = 3;
  const socketRows = 3;
  const socketGapX = 10;
  const socketGapY = 8;
  const socketStartY = py + TITLE_H + 8;
  const socketW = Math.round((PANEL_W - PAD * 2 - (socketCols - 1) * socketGapX) / socketCols);
  const socketH = 64;

  const sockets = [];
  const socketHitAreas = [];

  for (let i = 1; i <= 9; i++) {
    const colIdx = (i - 1) % socketCols;
    const rowIdx = Math.floor((i - 1) / socketCols);
    const sx = px + PAD + colIdx * (socketW + socketGapX);
    const sy = socketStartY + rowIdx * (socketH + socketGapY);

    const socketBox = { x: sx, y: sy, w: socketW, h: socketH };
    const gem = (hotbarSkills && hotbarSkills.get(i)) || null;
    const req = gem ? checkGemRequirements(gem, playerStats, equippedWeapon) : null;

    const unsocketBtn = gem ? {
      x: sx + socketW - 24,
      y: sy + 4,
      w: 20,
      h: 20,
      slot: i,
    } : null;

    sockets.push({
      slot: i,
      box: socketBox,
      gem,
      req,
      unsocketBtn,
    });

    if (unsocketBtn) {
      socketHitAreas.push({ kind: "skills_unsocket", slot: i, box: unsocketBtn });
    }
    socketHitAreas.push({ kind: "skills_socket_target", slot: i, box: socketBox });
  }

  // -------------------------------------------------------------------------
  // 2. Bottom Section: Inventory & Catalog Skill Gems
  // -------------------------------------------------------------------------
  const listStartY = socketStartY + socketRows * (socketH + socketGapY) + 6;
  
  // Filter Tabs
  const tabs = [];
  const tabW = Math.round((PANEL_W - PAD * 2 - (GEM_FILTER_TABS.length - 1) * 4) / GEM_FILTER_TABS.length);
  let tx = px + PAD;
  for (const t of GEM_FILTER_TABS) {
    tabs.push({
      key: t.key,
      label: t.label,
      x: tx,
      y: listStartY,
      w: tabW,
      h: TAB_H,
      active: (tab || "inventory") === t.key,
    });
    tx += tabW + 4;
  }

  // Gem pool resolution
  let pool = [];
  if (tab === "inventory") {
    pool = (inventoryGems && inventoryGems.length > 0)
      ? inventoryGems
      : [];
  } else if (tab === "all") {
    pool = SKILLS;
  } else if (tab === "str") {
    pool = SKILLS.filter(s => s.reqStr > 0);
  } else if (tab === "dex") {
    pool = SKILLS.filter(s => s.reqDex > 0);
  } else if (tab === "con") {
    pool = SKILLS.filter(s => s.reqCon > 0);
  } else if (tab === "int") {
    pool = SKILLS.filter(s => s.reqInt > 0);
  } else if (tab === "wis") {
    pool = SKILLS.filter(s => s.reqWis > 0);
  } else if (tab === "cha") {
    pool = SKILLS.filter(s => s.reqCha > 0);
  } else {
    pool = SKILLS;
  }

  const itemsPerPage = 3;
  const totalPages = Math.max(1, Math.ceil(pool.length / itemsPerPage));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = currentPage * itemsPerPage;
  const visible = pool.slice(startIdx, startIdx + itemsPerPage);

  const gemRowH = 50;
  const gemRowStartY = listStartY + TAB_H + 6;
  const gemRows = [];
  const gemHitAreas = [];

  for (let i = 0; i < visible.length; i++) {
    const gem = visible[i];
    const gy = gemRowStartY + i * (gemRowH + 5);
    const rowBox = {
      x: px + PAD,
      y: gy,
      w: PANEL_W - PAD * 2,
      h: gemRowH,
    };

    const req = checkGemRequirements(gem, playerStats, equippedWeapon);

    // Find which socket(s) currently hold this gem
    let socketedInSlot = null;
    if (hotbarSkills) {
      for (const [sNum, sGem] of hotbarSkills.entries()) {
        if (sGem && sGem.id === gem.id) {
          socketedInSlot = sNum;
          break;
        }
      }
    }

    const isOwned = (inventoryGems && inventoryGems.some(g => g.id === gem.id)) || (socketedInSlot != null);

    // Quick socket buttons for slots 1-9 (only for owned inventory gems)
    const quickButtons = [];
    if (isOwned) {
      const btnW = 18;
      const btnH = 20;
      const btnsStartX = rowBox.x + rowBox.w - 9 * (btnW + 2) - 4;
      for (let s = 1; s <= 9; s++) {
        const qBtn = {
          x: btnsStartX + (s - 1) * (btnW + 2),
          y: gy + 15,
          w: btnW,
          h: btnH,
          slot: s,
          active: socketedInSlot === s,
        };
        quickButtons.push(qBtn);
        gemHitAreas.push({ kind: "skills_quick_socket", slot: s, gemId: gem.id, gem, box: qBtn });
      }
    }

    gemRows.push({
      gem,
      box: rowBox,
      req,
      isOwned,
      socketedInSlot,
      quickButtons,
      selected: selectedSkillId === gem.id,
    });

    gemHitAreas.push({ kind: "skills_item", skillId: gem.id, skill: gem, isOwned, box: rowBox });
  }

  // Footer pagination
  const footerY = py + PANEL_H - 32;
  const prevBtn = currentPage > 0
    ? { x: px + PAD, y: footerY, w: 80, h: 24, label: "◀ Prev" }
    : null;
  const nextBtn = currentPage < totalPages - 1
    ? { x: px + PANEL_W - PAD - 80, y: footerY, w: 80, h: 24, label: "Next ▶" }
    : null;

  const hitAreas = [
    { kind: "skills_close", box: close },
    ...tabs.map(t => ({ kind: "skills_tab", key: t.key, box: t })),
    ...socketHitAreas,
    ...gemHitAreas,
  ];
  if (prevBtn) hitAreas.push({ kind: "skills_page_prev", box: prevBtn });
  if (nextBtn) hitAreas.push({ kind: "skills_page_next", box: nextBtn });

  return {
    panel,
    title,
    close,
    sockets,
    tabs,
    gemRows,
    prevBtn,
    nextBtn,
    footerY,
    currentPage,
    totalPages,
    totalCount: pool.length,
    hitAreas,
    selectedSkillId,
  };
}

export function drawSkillsPanel(ctx, layout, state) {
  const {
    panel, title, close, sockets, tabs, gemRows,
    prevBtn, nextBtn, footerY, currentPage, totalPages, totalCount,
  } = layout;

  ctx.save();

  // 1. Panel Frame
  ctx.fillStyle = "rgba(10, 14, 26, 0.98)";
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  ctx.strokeStyle = "#0ea5e9";
  ctx.lineWidth = 2;
  ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);

  // 2. Title Bar
  const titleGrad = ctx.createLinearGradient(title.x, title.y, title.x, title.y + title.h);
  titleGrad.addColorStop(0, "rgba(14, 116, 144, 0.95)");
  titleGrad.addColorStop(1, "rgba(8, 51, 68, 0.95)");
  ctx.fillStyle = titleGrad;
  ctx.fillRect(title.x, title.y, title.w, title.h);

  ctx.fillStyle = "#ecfeff";
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

  // -------------------------------------------------------------------------
  // 3. Draw 9 Hotbar Sockets
  // -------------------------------------------------------------------------
  for (const sk of sockets) {
    const b = sk.box;
    const g = sk.gem;

    ctx.save();
    if (g) {
      // Filled Socket Box
      const gemColorCode = g.gemColor === 'red' ? '#ef4444' : (g.gemColor === 'green' ? '#22c55e' : (g.gemColor === 'blue' ? '#3b82f6' : (g.gemColor === 'purple' ? '#a855f7' : '#f59e0b')));
      
      const sGrad = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
      sGrad.addColorStop(0, "rgba(15, 23, 42, 0.95)");
      sGrad.addColorStop(1, "rgba(10, 15, 28, 0.98)");
      ctx.fillStyle = sGrad;
      ctx.fillRect(b.x, b.y, b.w, b.h);

      ctx.strokeStyle = gemColorCode;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(b.x, b.y, b.w, b.h);

      // Gem Socket Icon (Left)
      const iconS = 44;
      const iconX = b.x + 8;
      const iconY = b.y + 10;
      ctx.fillStyle = "rgba(5, 5, 10, 0.95)";
      ctx.fillRect(iconX, iconY, iconS, iconS);
      ctx.strokeStyle = gemColorCode;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(iconX, iconY, iconS, iconS);

      // Inner diamond
      ctx.fillStyle = gemColorCode;
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.moveTo(iconX + iconS / 2, iconY + 3);
      ctx.lineTo(iconX + iconS - 3, iconY + iconS / 2);
      ctx.lineTo(iconX + iconS / 2, iconY + iconS - 3);
      ctx.lineTo(iconX + 3, iconY + iconS / 2);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1.0;

      ctx.font = "20px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(g.icon || "💎", iconX + iconS / 2, iconY + iconS / 2 + 1);

      // Text Info
      const textX = iconX + iconS + 8;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";

      // Line 1: Slot Badge + Gem Name
      ctx.font = "bold 10px monospace";
      ctx.fillStyle = "#38bdf8";
      ctx.fillText(`[SLOT ${sk.slot} · KEY ${sk.slot}]`, textX, b.y + 6);

      ctx.font = "bold 12px sans-serif";
      ctx.fillStyle = "#ffffff";
      const nameW = b.w - (textX - b.x) - 30;
      ctx.fillText(g.nameEn || g.nameUk, textX, b.y + 20, nameW);

      // Line 2: Requirement Status
      ctx.font = "10px monospace";
      if (sk.req && sk.req.ok) {
        ctx.fillStyle = "#34d399";
        ctx.fillText("✓ Ready to Cast", textX, b.y + 42);
      } else {
        ctx.fillStyle = "#fb7185";
        ctx.fillText("⚠ Missing Stats / Weapon", textX, b.y + 42);
      }

      // Unsocket button
      if (sk.unsocketBtn) {
        const u = sk.unsocketBtn;
        ctx.fillStyle = "rgba(220, 38, 38, 0.85)";
        ctx.fillRect(u.x, u.y, u.w, u.h);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("✕", u.x + u.w / 2, u.y + u.h / 2);
      }
    } else {
      // Empty Socket Box
      ctx.fillStyle = "rgba(15, 23, 42, 0.6)";
      ctx.fillRect(b.x, b.y, b.w, b.h);

      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(56, 189, 248, 0.4)";
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.setLineDash([]);

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "bold 11px monospace";
      ctx.fillStyle = "#38bdf8";
      ctx.fillText(`[SLOT ${sk.slot} · KEY ${sk.slot}] — Empty Socket`, b.x + b.w / 2, b.y + 22);

      ctx.font = "10px sans-serif";
      ctx.fillStyle = "#64748b";
      ctx.fillText("Click or drag a gem from below to socket", b.x + b.w / 2, b.y + 42);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // 4. Draw Filter Tabs
  // -------------------------------------------------------------------------
  ctx.font = "bold 10px sans-serif";
  for (const t of tabs) {
    if (t.active) {
      ctx.fillStyle = "rgba(6, 182, 212, 0.9)";
      ctx.strokeStyle = "#a5f3fc";
      ctx.lineWidth = 1.5;
    } else {
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.strokeStyle = "rgba(14, 116, 144, 0.5)";
      ctx.lineWidth = 1;
    }
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.strokeRect(t.x, t.y, t.w, t.h);

    ctx.fillStyle = t.active ? "#ffffff" : "#cffafe";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(t.label, t.x + t.w / 2, t.y + t.h / 2);
  }

  // -------------------------------------------------------------------------
  // 5. Draw Inventory Gem Rows
  // -------------------------------------------------------------------------
  if (gemRows.length === 0) {
    ctx.fillStyle = "#94a3b8";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No Skill Gems found in this tab. Buy gems from the Skill Gem Merchant in town or select 'All Catalog'!", panel.x + panel.w / 2, panel.y + panel.h - 90);
  }

  for (const r of gemRows) {
    const s = r.gem;
    const b = r.box;
    const gemColorCode = s.gemColor === 'red' ? '#ef4444' : (s.gemColor === 'green' ? '#22c55e' : (s.gemColor === 'blue' ? '#3b82f6' : (s.gemColor === 'purple' ? '#a855f7' : '#f59e0b')));

    ctx.save();
    const rowGrad = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    rowGrad.addColorStop(0, "rgba(15, 23, 42, 0.9)");
    rowGrad.addColorStop(1, "rgba(10, 15, 28, 0.96)");
    ctx.fillStyle = rowGrad;
    ctx.fillRect(b.x, b.y, b.w, b.h);

    ctx.strokeStyle = r.selected ? "#38bdf8" : "rgba(6, 182, 212, 0.4)";
    ctx.lineWidth = r.selected ? 2 : 1;
    ctx.strokeRect(b.x, b.y, b.w, b.h);

    // Gem Icon Box
    const iconS = 38;
    const iconX = b.x + 6;
    const iconY = b.y + 6;
    ctx.fillStyle = "rgba(5, 5, 10, 0.95)";
    ctx.fillRect(iconX, iconY, iconS, iconS);
    ctx.strokeStyle = gemColorCode;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(iconX, iconY, iconS, iconS);

    ctx.font = "18px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.icon || "💎", iconX + iconS / 2, iconY + iconS / 2 + 1);

    // Info
    const textX = iconX + iconS + 10;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    // Line 1: Gem Name + Tags
    ctx.font = "bold 12px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(s.nameEn || s.nameUk, textX, b.y + 6);
    const nW = ctx.measureText(s.nameEn || s.nameUk).width;

    let badgeX = textX + nW + 6;
    ctx.font = "bold 9px monospace";
    ctx.fillStyle = gemColorCode;
    const colorLabel = `[${s.gemColor.toUpperCase()} GEM]`;
    ctx.fillText(colorLabel, badgeX, b.y + 7);
    badgeX += ctx.measureText(colorLabel).width + 6;

    if (r.socketedInSlot) {
      ctx.fillStyle = "#38bdf8";
      ctx.fillText(`[SOCKETED IN SLOT ${r.socketedInSlot}]`, badgeX, b.y + 7);
    }

    // Line 2: Requirements
    ctx.font = "10px monospace";
    let reqString = `Req: Lv ${s.reqLvl || 1}`;
    if (s.reqStr > 0) reqString += ` · ${s.reqStr} STR`;
    if (s.reqDex > 0) reqString += ` · ${s.reqDex} DEX`;
    if (s.reqCon > 0) reqString += ` · ${s.reqCon} CON`;
    if (s.reqInt > 0) reqString += ` · ${s.reqInt} INT`;
    if (s.reqWis > 0) reqString += ` · ${s.reqWis} WIS`;
    if (s.reqCha > 0) reqString += ` · ${s.reqCha} CHA`;
    reqString += ` · ${getWeaponRequirementName(s.reqWeapon || 'any')}`;

    ctx.fillStyle = r.req.ok ? "#34d399" : "#fb7185";
    ctx.fillText(reqString, textX, b.y + 26);

    if (r.isOwned) {
      // Quick Socket Buttons [1..9]
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      for (const q of r.quickButtons) {
        if (q.active) {
          ctx.fillStyle = "#0284c7";
          ctx.strokeStyle = "#38bdf8";
        } else {
          ctx.fillStyle = "rgba(30, 41, 59, 0.85)";
          ctx.strokeStyle = "rgba(100, 116, 139, 0.6)";
        }
        ctx.fillRect(q.x, q.y, q.w, q.h);
        ctx.strokeRect(q.x, q.y, q.w, q.h);

        ctx.fillStyle = q.active ? "#ffffff" : "#cbd5e1";
        ctx.fillText(String(q.slot), q.x + q.w / 2, q.y + q.h / 2);
      }
    } else {
      // Unowned catalog gem indicator
      const tagW = 190;
      const tagH = 22;
      const tagX = b.x + b.w - tagW - 8;
      const tagY = b.y + 14;
      ctx.fillStyle = "rgba(245, 158, 11, 0.12)";
      ctx.fillRect(tagX, tagY, tagW, tagH);
      ctx.strokeStyle = "rgba(245, 158, 11, 0.5)";
      ctx.lineWidth = 1;
      ctx.strokeRect(tagX, tagY, tagW, tagH);

      ctx.font = "bold 10px monospace";
      ctx.fillStyle = "#fde68a";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("🛒 Buy at Gem Merchant (35g)", tagX + tagW / 2, tagY + tagH / 2);
    }

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // 6. Pagination Footer
  // -------------------------------------------------------------------------
  if (prevBtn) {
    ctx.fillStyle = "rgba(14, 116, 144, 0.85)";
    ctx.fillRect(prevBtn.x, prevBtn.y, prevBtn.w, prevBtn.h);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(prevBtn.label, prevBtn.x + prevBtn.w / 2, prevBtn.y + prevBtn.h / 2);
  }

  if (nextBtn) {
    ctx.fillStyle = "rgba(14, 116, 144, 0.85)";
    ctx.fillRect(nextBtn.x, nextBtn.y, nextBtn.w, nextBtn.h);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(nextBtn.label, nextBtn.x + nextBtn.w / 2, nextBtn.y + nextBtn.h / 2);
  }

  if (totalPages > 1) {
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`Page ${currentPage + 1} / ${totalPages} (${totalCount} Gems)`, panel.x + panel.w / 2, footerY + 12);
  }

  ctx.restore();
}
