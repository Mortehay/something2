// frontend/src/games/something2/src/js/systems/gemShopPanel.js
// Dedicated Skill Gem Merchant Shop in settlements (Поселення).
// Allows players to purchase PoE-style Skill Gems for gold, inspect Level/Attribute requirements, and weapon requirements.

import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import { getSkillsForClass, SKILLS, checkGemRequirements, getWeaponRequirementName } from "../core/skillsData.js";

export const GEM_SHOP_W = 780;
export const GEM_SHOP_H = 530;
const PAD = 14;
const TITLE_H = 34;
const FILTER_TAB_H = 24;
const ITEM_H = 68;
const ITEMS_PER_PAGE = 5;

export const GEM_COLOR_TABS = [
  { key: "all", label: "All Attributes" },
  { key: "str", label: "🔴 STR" },
  { key: "dex", label: "🟢 DEX" },
  { key: "con", label: "🛡️ CON" },
  { key: "int", label: "🔵 INT" },
  { key: "wis", label: "✨ WIS" },
  { key: "cha", label: "🔮 CHA" },
];

export const CLASS_TABS = [
  { key: "all", label: "All" },
  { key: "Warrior", label: "Warrior" },
  { key: "Archer", label: "Archer" },
  { key: "Mage", label: "Mage" },
  { key: "Monk", label: "Monk" },
  { key: "Cultist", label: "Cultist" },
  { key: "Druid", label: "Druid" },
];

export function layoutGemShopPanel(state) {
  const {
    colorFilter = "all",
    classFilter = "all",
    page = 0,
    playerGold = 0,
    playerStats = null,
    equippedWeapon = null,
    selectedGemId = null,
  } = state;

  const px = Math.round((GAME_WIDTH - GEM_SHOP_W) / 2);
  const py = Math.round((GAME_HEIGHT - GEM_SHOP_H) / 2);
  const panel = { x: px, y: py, w: GEM_SHOP_W, h: GEM_SHOP_H };

  const title = {
    x: px,
    y: py,
    w: GEM_SHOP_W,
    h: TITLE_H,
    label: `💎 Skill Gem Merchant — Gemcutter & Jeweller`,
  };

  const close = {
    x: px + GEM_SHOP_W - 28,
    y: py + 5,
    w: 24,
    h: 24,
  };

  // 1. Color / Attribute Filter Tabs (Row 1)
  const colorTabs = [];
  const cTabW = Math.round((GEM_SHOP_W - PAD * 2 - (GEM_COLOR_TABS.length - 1) * 6) / GEM_COLOR_TABS.length);
  let cx = px + PAD;
  const cy = py + TITLE_H + 6;
  for (const c of GEM_COLOR_TABS) {
    colorTabs.push({
      key: c.key,
      label: c.label,
      x: cx,
      y: cy,
      w: cTabW,
      h: FILTER_TAB_H,
      active: colorFilter === c.key,
    });
    cx += cTabW + 6;
  }

  // 2. Class Filter Tabs (Row 2)
  const classTabs = [];
  const clTabW = Math.round((GEM_SHOP_W - PAD * 2 - (CLASS_TABS.length - 1) * 4) / CLASS_TABS.length);
  let clx = px + PAD;
  const cly = cy + FILTER_TAB_H + 5;
  for (const cl of CLASS_TABS) {
    classTabs.push({
      key: cl.key,
      label: cl.label,
      x: clx,
      y: cly,
      w: clTabW,
      h: FILTER_TAB_H,
      active: classFilter === cl.key,
    });
    clx += clTabW + 4;
  }

  // Filter skills
  let pool = classFilter === "all" ? SKILLS : getSkillsForClass(classFilter);
  if (colorFilter !== "all") {
    if (colorFilter === "str") pool = pool.filter(s => s.reqStr > 0);
    else if (colorFilter === "dex") pool = pool.filter(s => s.reqDex > 0);
    else if (colorFilter === "con") pool = pool.filter(s => s.reqCon > 0);
    else if (colorFilter === "int") pool = pool.filter(s => s.reqInt > 0);
    else if (colorFilter === "wis") pool = pool.filter(s => s.reqWis > 0);
    else if (colorFilter === "cha") pool = pool.filter(s => s.reqCha > 0);
    else pool = pool.filter(s => s.gemColor === colorFilter);
  }

  const totalPages = Math.max(1, Math.ceil(pool.length / ITEMS_PER_PAGE));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = currentPage * ITEMS_PER_PAGE;
  const visible = pool.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  // Rows of Skill Gems for purchase
  const listY = cly + FILTER_TAB_H + 8;
  const rows = [];
  for (let i = 0; i < visible.length; i++) {
    const gem = visible[i];
    const ry = listY + i * (ITEM_H + 6);
    const price = gem.gemPrice || 35;
    const canAfford = playerGold >= price;
    const req = checkGemRequirements(gem, playerStats, equippedWeapon);

    const buyBtn = {
      x: px + GEM_SHOP_W - PAD - 110,
      y: ry + 16,
      w: 100,
      h: 36,
      label: `Buy 🪙${price}`,
      canAfford,
      gemId: gem.id,
    };

    rows.push({
      gem,
      x: px + PAD,
      y: ry,
      w: GEM_SHOP_W - PAD * 2,
      h: ITEM_H,
      price,
      canAfford,
      req,
      buyBtn,
      selected: selectedGemId === gem.id,
    });
  }

  // Footer area
  const footerY = py + GEM_SHOP_H - 42;
  const prevBtn = currentPage > 0
    ? { x: px + PAD, y: footerY + 8, w: 90, h: 26, label: "◀ Prev" }
    : null;
  const nextBtn = currentPage < totalPages - 1
    ? { x: px + GEM_SHOP_W - PAD - 90, y: footerY + 8, w: 90, h: 26, label: "Next ▶" }
    : null;

  const hitAreas = [
    { kind: "gem_shop_close", box: close },
    ...colorTabs.map(c => ({ kind: "gem_shop_color_filter", key: c.key, box: c })),
    ...classTabs.map(c => ({ kind: "gem_shop_class_filter", key: c.key, box: c })),
    ...rows.map(r => ({ kind: "gem_shop_buy", gemId: r.gem.id, gem: r.gem, price: r.price, canAfford: r.canAfford, box: r.buyBtn })),
    ...rows.map(r => ({ kind: "gem_shop_item", gemId: r.gem.id, gem: r.gem, box: r })),
  ];
  if (prevBtn) hitAreas.push({ kind: "gem_shop_page_prev", box: prevBtn });
  if (nextBtn) hitAreas.push({ kind: "gem_shop_page_next", box: nextBtn });

  return {
    panel,
    title,
    close,
    colorTabs,
    classTabs,
    rows,
    prevBtn,
    nextBtn,
    footerY,
    currentPage,
    totalPages,
    totalCount: pool.length,
    playerGold,
    hitAreas,
  };
}

export function drawGemShopPanel(ctx, layout, state) {
  const {
    panel, title, close, colorTabs, classTabs, rows,
    prevBtn, nextBtn, footerY, currentPage, totalPages, totalCount, playerGold,
  } = layout;

  ctx.save();

  // 1. Panel Background Frame
  ctx.fillStyle = "rgba(10, 15, 24, 0.97)";
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  ctx.strokeStyle = "#0891b2";
  ctx.lineWidth = 2;
  ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);

  // 2. Title Bar with Gold Display
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

  // Gold indicator in title
  ctx.textAlign = "right";
  ctx.font = "bold 13px sans-serif";
  ctx.fillStyle = "#facc15";
  ctx.fillText(`Your Purse: 🪙 ${playerGold != null ? playerGold : 0} Gold`, title.x + title.w - 40, title.y + title.h / 2);

  // Close Button
  ctx.fillStyle = "rgba(185, 28, 28, 0.85)";
  ctx.fillRect(close.x, close.y, close.w, close.h);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("✕", close.x + close.w / 2, close.y + close.h / 2);

  // 3. Color / Attribute Filter Tabs (Row 1)
  ctx.font = "bold 11px sans-serif";
  for (const c of colorTabs) {
    if (c.active) {
      ctx.fillStyle = "rgba(6, 182, 212, 0.9)";
      ctx.strokeStyle = "#a5f3fc";
      ctx.lineWidth = 1.5;
    } else {
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.strokeStyle = "rgba(14, 116, 144, 0.6)";
      ctx.lineWidth = 1;
    }
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.strokeRect(c.x, c.y, c.w, c.h);

    ctx.fillStyle = c.active ? "#ffffff" : "#cffafe";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(c.label, c.x + c.w / 2, c.y + c.h / 2);
  }

  // 4. Class Tabs (Row 2)
  ctx.font = "bold 10px sans-serif";
  for (const cl of classTabs) {
    if (cl.active) {
      ctx.fillStyle = "rgba(8, 145, 178, 0.95)";
      ctx.strokeStyle = "#67e8f9";
      ctx.lineWidth = 1.5;
    } else {
      ctx.fillStyle = "rgba(12, 18, 30, 0.75)";
      ctx.strokeStyle = "rgba(8, 145, 178, 0.4)";
      ctx.lineWidth = 1;
    }
    ctx.fillRect(cl.x, cl.y, cl.w, cl.h);
    ctx.strokeRect(cl.x, cl.y, cl.w, cl.h);

    ctx.fillStyle = cl.active ? "#ffffff" : "#94a3b8";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cl.label, cl.x + cl.w / 2, cl.y + cl.h / 2);
  }

  // 5. Skill Gem Rows
  for (const r of rows) {
    const s = r.gem;
    ctx.save();

    // Row backdrop
    const rowGrad = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
    if (r.selected) {
      rowGrad.addColorStop(0, "rgba(8, 145, 178, 0.85)");
      rowGrad.addColorStop(1, "rgba(14, 116, 144, 0.95)");
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1.5;
    } else {
      rowGrad.addColorStop(0, "rgba(15, 23, 42, 0.9)");
      rowGrad.addColorStop(1, "rgba(10, 15, 28, 0.96)");
      ctx.strokeStyle = "rgba(6, 182, 212, 0.4)";
      ctx.lineWidth = 1;
    }
    ctx.fillStyle = rowGrad;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // PoE Gem Socket Icon Box
    const iconBoxX = r.x + 8;
    const iconBoxY = r.y + 8;
    const iconBoxS = 52;

    // Gem socket background
    const gemColorCode = s.gemColor === 'red' ? '#ef4444' : (s.gemColor === 'green' ? '#22c55e' : (s.gemColor === 'blue' ? '#3b82f6' : '#a855f7'));
    ctx.fillStyle = "rgba(5, 5, 10, 0.95)";
    ctx.fillRect(iconBoxX, iconBoxY, iconBoxS, iconBoxS);
    ctx.strokeStyle = gemColorCode;
    ctx.lineWidth = 2;
    ctx.strokeRect(iconBoxX, iconBoxY, iconBoxS, iconBoxS);

    // Gem Diamond/Hexagon shape inside
    ctx.fillStyle = gemColorCode;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.moveTo(iconBoxX + iconBoxS / 2, iconBoxY + 4);
    ctx.lineTo(iconBoxX + iconBoxS - 4, iconBoxY + iconBoxS / 2);
    ctx.lineTo(iconBoxX + iconBoxS / 2, iconBoxY + iconBoxS - 4);
    ctx.lineTo(iconBoxX + 4, iconBoxY + iconBoxS / 2);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1.0;

    ctx.font = "24px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.icon || "💎", iconBoxX + iconBoxS / 2, iconBoxY + iconBoxS / 2 + 1);

    // Text details
    const textX = iconBoxX + iconBoxS + 12;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    // Line 1: Gem Name + Gem Color Tag + Class Tag
    ctx.font = "bold 13px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(s.nameEn || s.nameUk, textX, r.y + 6);
    const nameWidth = ctx.measureText(s.nameEn || s.nameUk).width;

    let badgeX = textX + nameWidth + 8;
    ctx.font = "bold 9px monospace";

    // Color tag
    ctx.fillStyle = gemColorCode;
    const colorLabel = `[${s.gemColor.toUpperCase()} GEM]`;
    ctx.fillText(colorLabel, badgeX, r.y + 7);
    badgeX += ctx.measureText(colorLabel).width + 6;

    // Class tag
    ctx.fillStyle = "#facc15";
    ctx.fillText(`[${(s.class || "ALL").toUpperCase()}]`, badgeX, r.y + 7);
    badgeX += ctx.measureText(`[${(s.class || "ALL").toUpperCase()}]`).width + 6;

    // Line 2: Requirements (Level, STR, DEX, CON, INT, WIS, CHA, Weapon)
    ctx.font = "11px monospace";
    let reqString = `Req: Lv ${s.reqLvl || 1}`;
    if (s.reqStr > 0) reqString += ` · ${s.reqStr} STR`;
    if (s.reqDex > 0) reqString += ` · ${s.reqDex} DEX`;
    if (s.reqCon > 0) reqString += ` · ${s.reqCon} CON`;
    if (s.reqInt > 0) reqString += ` · ${s.reqInt} INT`;
    if (s.reqWis > 0) reqString += ` · ${s.reqWis} WIS`;
    if (s.reqCha > 0) reqString += ` · ${s.reqCha} CHA`;
    reqString += ` · ${getWeaponRequirementName(s.reqWeapon || 'any')}`;

    ctx.fillStyle = r.req.ok ? "#34d399" : "#fb7185";
    ctx.fillText(reqString, textX, r.y + 25);

    // Line 3: Cost, Cooldown, Type & Description
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#94a3b8";
    const maxDescW = r.w - (textX - r.x) - 120;
    const costText = `${s.cost} ${s.costType.toUpperCase()}`;
    const cdText = `${s.cooldown}s CD`;
    ctx.fillText(`${costText} · ${cdText} — ${s.descEn || s.descUk}`, textX, r.y + 45, maxDescW);

    // Buy Button
    const b = r.buyBtn;
    if (b.canAfford) {
      const btnGrad = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
      btnGrad.addColorStop(0, "rgba(22, 101, 52, 0.95)");
      btnGrad.addColorStop(1, "rgba(20, 83, 45, 0.95)");
      ctx.fillStyle = btnGrad;
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 1.5;
    } else {
      ctx.fillStyle = "rgba(68, 64, 60, 0.75)";
      ctx.strokeStyle = "rgba(120, 113, 108, 0.5)";
      ctx.lineWidth = 1;
    }
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeRect(b.x, b.y, b.w, b.h);

    ctx.fillStyle = b.canAfford ? "#ffffff" : "#a8a29e";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2);

    ctx.restore();
  }

  // 6. Footer
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#67e8f9";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const hintText = "💡 Purchase gems to learn skills and socket them into your hotbar (Keys 1–9)";
  ctx.fillText(hintText, panel.x + panel.w / 2, footerY - 12);

  // Page info
  ctx.font = "bold 11px monospace";
  ctx.fillStyle = "#94a3b8";
  ctx.fillText(`Page ${currentPage + 1} of ${totalPages} (${totalCount} gems available)`, panel.x + panel.w / 2, footerY + 14);

  // Pagination Buttons
  if (prevBtn) {
    ctx.fillStyle = "rgba(14, 116, 144, 0.85)";
    ctx.fillRect(prevBtn.x, prevBtn.y, prevBtn.w, prevBtn.h);
    ctx.strokeStyle = "#38bdf8";
    ctx.strokeRect(prevBtn.x, prevBtn.y, prevBtn.w, prevBtn.h);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(prevBtn.label, prevBtn.x + prevBtn.w / 2, prevBtn.y + prevBtn.h / 2);
  }
  if (nextBtn) {
    ctx.fillStyle = "rgba(14, 116, 144, 0.85)";
    ctx.fillRect(nextBtn.x, nextBtn.y, nextBtn.w, nextBtn.h);
    ctx.strokeStyle = "#38bdf8";
    ctx.strokeRect(nextBtn.x, nextBtn.y, nextBtn.w, nextBtn.h);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(nextBtn.label, nextBtn.x + nextBtn.w / 2, nextBtn.y + nextBtn.h / 2);
  }

  ctx.restore();
}
