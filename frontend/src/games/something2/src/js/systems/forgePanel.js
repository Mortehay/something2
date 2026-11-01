// The blacksmith's enchanting menu.
//
// Opened by walking up to the smith in a village (E, or a click on him). It lists every weapon
// the player owns, shows what a scroll would do to the selected one -- the chance, whether a
// miss burns it, and the damage before and after -- sells scrolls for gold, and plays a short
// animation when the scroll is spent.
//
// SPLIT THE USUAL WAY: layoutForgePanel is pure (geometry, rows, the plan, the hit areas) and
// is what the tests hold; drawForgePanel only paints a layout. Neither talks to the server --
// Game turns a hit area into a message, and the server owns every rule and every die roll.

import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import {
  enchantPlan, enchantButtonLabel, enchantedDamage, damageBonusPercent, enchantedName,
  enchantLevelOf, scrollCount,
} from "./enchantUi.js";
import { drawWeaponGlow, glowParams } from "./weaponGlow.js";

export const FORGE_W = 800;
export const FORGE_H = 520;
export const ROWS_PER_PAGE = 7;
const PAD = 14;
const TITLE_H = 36;
const ROW_H = 46;
const LEFT_W = 300;

// How long the result animation plays.
export const FORGE_ANIM_MS = 1800;

// The quantities the Buy buttons offer.
export const BUY_QUANTITIES = [1, 5];

// Every weapon the player owns: the one in hand first, then the highest enchant, then by name.
// `inventory.types` is the catalog Map the join frame filled.
export function forgeWeapons(inventory) {
  if (!inventory || !Array.isArray(inventory.items)) return [];
  const heldId = inventory.equipment && inventory.equipment.main_hand;
  const rows = [];
  for (const item of inventory.items) {
    const type = inventory.types && inventory.types.get(item.typeId);
    if (!type || type.category !== "weapon") continue;
    rows.push({ item, type, level: enchantLevelOf(item), equipped: item.id === heldId });
  }
  rows.sort((a, b) => (b.equipped - a.equipped) || (b.level - a.level)
    || String(a.type.name).localeCompare(String(b.type.name)));
  return rows;
}

// What the panel shows for one selected weapon, or null.
export function forgeForecast(row, cfg, { blessed = false } = {}) {
  if (!row || !cfg) return null;
  const base = Number(row.type.damage) || 0;
  const level = row.level;
  const maxed = level >= cfg.maxLevel;
  const nextLevel = maxed ? level : level + 1;
  const chancePct = maxed ? 0 : Number(cfg.chances[nextLevel]) || 0;
  const danger = !maxed && nextLevel > cfg.safeMaxLevel;
  const now = enchantedDamage(base, level, cfg);
  const after = enchantedDamage(base, nextLevel, cfg);
  return {
    name: enchantedName(row.type.name, level),
    level, nextLevel, maxed, chancePct, danger,
    damageNow: now, damageAfter: after,
    damageGain: Math.round((after - now) * 100) / 100,
    bonusNowPct: damageBonusPercent(level, cfg),
    bonusAfterPct: damageBonusPercent(nextLevel, cfg),
    // The honest read of a miss: the weapon is lost, or only the scroll is.
    blessed: !maxed && danger && blessed,
    failure: maxed ? "" : (danger ? (blessed ? `drops back to +${cfg.safeMaxLevel}` : "burns the weapon") : "only the scroll is lost"),
  };
}

// Pure animation state: where in its life the last result is, or null when there is none or it
// has finished. `result` is { outcome, level, at } (at = the clock reading when it arrived).
export function forgeAnimation(result, now, durationMs = FORGE_ANIM_MS) {
  if (!result || !Number.isFinite(result.at)) return null;
  const t = (now - result.at) / durationMs;
  if (!(t >= 0) || t >= 1) return null;
  return { kind: result.outcome, t, level: result.level };
}

export function layoutForgePanel(state) {
  const {
    inventory = null, enchantCfg = null, gold = 0,
    selectedItemId = null, page = 0, armedItemId = null, blessed = false,
  } = state;

  const px = Math.round((GAME_WIDTH - FORGE_W) / 2);
  const py = Math.round((GAME_HEIGHT - FORGE_H) / 2);
  const panel = { x: px, y: py, w: FORGE_W, h: FORGE_H };
  const close = { x: px + FORGE_W - 32, y: py + 6, w: 24, h: 24 };
  const hitAreas = [{ kind: "forge_close", box: close }];

  // ---- the weapon list (left) ----
  const all = forgeWeapons(inventory);
  const pageCount = Math.max(1, Math.ceil(all.length / ROWS_PER_PAGE));
  const pageIdx = Math.max(0, Math.min(pageCount - 1, Math.floor(Number(page) || 0)));
  const listTop = py + TITLE_H + 34;
  const rows = all.slice(pageIdx * ROWS_PER_PAGE, (pageIdx + 1) * ROWS_PER_PAGE).map((r, i) => {
    const box = { x: px + PAD, y: listTop + i * (ROW_H + 4), w: LEFT_W, h: ROW_H };
    return { ...r, box, selected: r.item.id === selectedItemId };
  });
  for (const r of rows) hitAreas.push({ kind: "forge_weapon", id: r.item.id, box: r.box });

  const pagerY = listTop + ROWS_PER_PAGE * (ROW_H + 4) + 2;
  const prev = pageIdx > 0 ? { x: px + PAD, y: pagerY, w: 70, h: 24 } : null;
  const next = pageIdx < pageCount - 1 ? { x: px + PAD + LEFT_W - 70, y: pagerY, w: 70, h: 24 } : null;
  if (prev) hitAreas.push({ kind: "forge_page", delta: -1, box: prev });
  if (next) hitAreas.push({ kind: "forge_page", delta: 1, box: next });

  // ---- the selected weapon (right) ----
  const selected = all.find((r) => r.item.id === selectedItemId) || null;
  const forecast = forgeForecast(selected, enchantCfg, { blessed });
  const plan = selected ? enchantPlan(inventory, selected.item.id, enchantCfg, { blessed }) : null;
  const scrolls = enchantCfg ? scrollCount(inventory, enchantCfg) : 0;

  const rx = px + PAD + LEFT_W + 22;
  const rw = FORGE_W - (rx - px) - PAD;
  const card = { x: rx, y: py + TITLE_H + 12, w: rw, h: 150 };
  const stage = { x: rx, y: card.y + card.h + 10, w: rw, h: 110 };
  const shopY = stage.y + stage.h + 10;

  // ---- scrolls for sale: one row per kind (standard first, then the cheap safe-zone scroll) ----
  const maxBuy = enchantCfg ? Number(enchantCfg.maxScrollPurchase) || 1 : 1;
  const priceOf = (kind) => {
    if (!enchantCfg) return 0;
    return Number(kind === "blessed" ? enchantCfg.blessedScrollPrice : enchantCfg.scrollPrice) || 0;
  };
  const kinds = enchantCfg && enchantCfg.blessedScrollItemName ? ["standard", "blessed"] : ["standard"];
  const SHOP_ROW_H = 34;
  const buyButtons = [];
  const shopRows = kinds.map((kind, row) => {
    const y = shopY + row * SHOP_ROW_H;
    const price = priceOf(kind);
    BUY_QUANTITIES.filter((q) => q <= maxBuy).forEach((q, i) => {
      const cost = q * price;
      const box = { x: rx + 150 + i * 150, y, w: 142, h: 28 };
      buyButtons.push({ kind, quantity: q, cost, box, canAfford: gold >= cost });
    });
    return { kind, y, price, count: enchantCfg ? scrollCount(inventory, enchantCfg, kind) : 0 };
  });
  for (const b of buyButtons) hitAreas.push({ kind: "forge_buy", scroll: b.kind, quantity: b.quantity, box: b.box });
  const price = priceOf("standard");

  // ---- the blessed toggle: only where a miss would burn the weapon and the player owns a blessed scroll ----
  const blessedCount = enchantCfg ? scrollCount(inventory, enchantCfg, "blessed") : 0;
  const blessedToggle = forecast && forecast.danger && blessedCount > 0
    ? { box: { x: card.x + card.w - 196, y: card.y + 34, w: 182, h: 26 }, on: !!blessed, count: blessedCount }
    : null;
  if (blessedToggle) hitAreas.push({ kind: "forge_blessed", box: blessedToggle.box });

  // ---- the Enchant button ----
  const armed = !!selected && armedItemId != null && armedItemId === selected.item.id;
  const enchantBox = { x: rx, y: shopY + kinds.length * SHOP_ROW_H + 4, w: rw, h: 44 };
  const enchant = {
    box: enchantBox, plan, armed,
    label: plan ? enchantButtonLabel(plan, armed) : "Select a weapon",
    // A disabled button is drawn but has no hit area, so a click on it does nothing.
    enabled: !!(plan && plan.ok),
  };
  if (enchant.enabled) hitAreas.push({ kind: "forge_enchant", id: selected.item.id, box: enchantBox });

  return {
    panel, close, title: { x: px, y: py, w: FORGE_W, h: TITLE_H },
    rows, total: all.length, pages: { count: pageCount, page: pageIdx, prev, next, y: pagerY },
    selected, forecast, plan, scrolls, price, blessedToggle,
    card, stage, shop: { y: shopY, buttons: buyButtons, rows: shopRows, price }, enchant,
    hitAreas,
  };
}

// ---------------------------------------------------------------- drawing

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

function chanceColor(pct) {
  if (pct >= 100) return "#4ade80";
  if (pct >= 40) return "#facc15";
  if (pct >= 10) return "#fb923c";
  return "#f87171";
}

export function drawForgePanel(ctx, layout, state, now = 0) {
  const { enchantCfg = null, gold = 0 } = state;
  const { panel, forecast } = layout;

  ctx.save();
  // Window
  const g = ctx.createLinearGradient(panel.x, panel.y, panel.x, panel.y + panel.h);
  g.addColorStop(0, "rgba(40, 22, 14, 0.97)");
  g.addColorStop(1, "rgba(18, 10, 8, 0.98)");
  ctx.fillStyle = g;
  rr(ctx, panel.x, panel.y, panel.w, panel.h, 8);
  ctx.fill();
  ctx.strokeStyle = "#f97316";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Title bar + purse
  ctx.fillStyle = "rgba(249, 115, 22, 0.16)";
  ctx.fillRect(panel.x + 1, panel.y + 1, panel.w - 2, TITLE_H);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = "bold 15px sans-serif";
  ctx.fillStyle = "#fed7aa";
  ctx.fillText("🔨 Village Blacksmith — Weapon Enchanting", panel.x + PAD, panel.y + TITLE_H / 2 + 1);
  ctx.textAlign = "right";
  ctx.font = "bold 13px sans-serif";
  ctx.fillStyle = "#fde68a";
  ctx.fillText(`Your Purse: 🪙 ${Number(gold).toLocaleString()} Gold`, layout.close.x - 12, panel.y + TITLE_H / 2 + 1);
  ctx.fillStyle = "#b91c1c";
  ctx.fillRect(layout.close.x, layout.close.y, layout.close.w, layout.close.h);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.fillText("✕", layout.close.x + layout.close.w / 2, layout.close.y + layout.close.h / 2 + 1);

  // ---- the weapon list ----
  ctx.textAlign = "left";
  ctx.font = "bold 12px sans-serif";
  ctx.fillStyle = "#fdba74";
  ctx.fillText(`Your weapons (${layout.total})`, panel.x + PAD, panel.y + TITLE_H + 20);

  if (layout.rows.length === 0) {
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "#a8a29e";
    ctx.fillText("You carry no weapons to enchant.", panel.x + PAD, panel.y + TITLE_H + 60);
  }
  for (const r of layout.rows) {
    const b = r.box;
    ctx.fillStyle = r.selected ? "rgba(249, 115, 22, 0.28)" : "rgba(30, 20, 16, 0.9)";
    rr(ctx, b.x, b.y, b.w, b.h, 5);
    ctx.fill();
    ctx.strokeStyle = r.selected ? "#fb923c" : "rgba(120, 90, 70, 0.6)";
    ctx.lineWidth = r.selected ? 2 : 1;
    ctx.stroke();
    const fire = enchantCfg && r.level >= (enchantCfg.glowFireLevel || 10);
    ctx.font = "bold 13px sans-serif";
    ctx.fillStyle = r.level > 0 ? (fire ? "#f87171" : "#67e8f9") : "#e7e5e4";
    ctx.fillText(enchantedName(r.type.name, r.level), b.x + 10, b.y + 17, b.w - 80);
    ctx.font = "11px monospace";
    ctx.fillStyle = "#a8a29e";
    const dmg = enchantCfg ? enchantedDamage(r.type.damage, r.level, enchantCfg) : r.type.damage;
    ctx.fillText(`dmg ${dmg}  cd ${r.type.cooldown}s`, b.x + 10, b.y + 34);
    if (r.equipped) {
      ctx.textAlign = "right";
      ctx.font = "bold 10px sans-serif";
      ctx.fillStyle = "#4ade80";
      ctx.fillText("IN HAND", b.x + b.w - 8, b.y + 17);
      ctx.textAlign = "left";
    }
  }
  const pg = layout.pages;
  ctx.font = "bold 12px sans-serif";
  for (const [btn, label] of [[pg.prev, "◀ Prev"], [pg.next, "Next ▶"]]) {
    if (!btn) continue;
    ctx.fillStyle = "rgba(154, 52, 18, 0.9)";
    ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(label, btn.x + btn.w / 2, btn.y + btn.h / 2 + 1);
  }
  ctx.textAlign = "left";
  if (pg.count > 1) {
    ctx.fillStyle = "#a8a29e";
    ctx.font = "11px monospace";
    ctx.fillText(`page ${pg.page + 1}/${pg.count}`, panel.x + PAD + 112, pg.y + 13);
  }

  // ---- the forecast card ----
  const c = layout.card;
  ctx.fillStyle = "rgba(24, 16, 12, 0.9)";
  rr(ctx, c.x, c.y, c.w, c.h, 6);
  ctx.fill();
  ctx.strokeStyle = "rgba(120, 90, 70, 0.7)";
  ctx.lineWidth = 1;
  ctx.stroke();
  if (!forecast) {
    ctx.font = "14px sans-serif";
    ctx.fillStyle = "#a8a29e";
    ctx.fillText("Choose a weapon from the list.", c.x + 14, c.y + 36);
  } else {
    ctx.font = "bold 17px sans-serif";
    ctx.fillStyle = "#fff7ed";
    ctx.fillText(forecast.name, c.x + 14, c.y + 24, c.w - 28);
    if (forecast.maxed) {
      ctx.font = "bold 14px sans-serif";
      ctx.fillStyle = "#f87171";
      ctx.fillText(`Maximum enchantment reached (+${forecast.level}).`, c.x + 14, c.y + 56);
      ctx.font = "12px sans-serif";
      ctx.fillStyle = "#a8a29e";
      ctx.fillText(`Damage ${forecast.damageNow}  (+${forecast.bonusNowPct}%)`, c.x + 14, c.y + 80);
    } else {
      ctx.font = "13px sans-serif";
      ctx.fillStyle = "#d6d3d1";
      ctx.fillText(`Next level: +${forecast.nextLevel}`, c.x + 14, c.y + 48);

      // The chance, as a number and a bar.
      ctx.font = "bold 22px sans-serif";
      ctx.fillStyle = chanceColor(forecast.chancePct);
      ctx.fillText(`${forecast.chancePct}%`, c.x + 14, c.y + 78);
      ctx.font = "12px sans-serif";
      ctx.fillStyle = "#a8a29e";
      ctx.fillText("chance of success", c.x + 78, c.y + 78);
      const barX = c.x + 14; const barY = c.y + 90; const barW = c.w - 28;
      ctx.fillStyle = "rgba(60, 45, 38, 0.9)";
      ctx.fillRect(barX, barY, barW, 8);
      ctx.fillStyle = chanceColor(forecast.chancePct);
      ctx.fillRect(barX, barY, Math.max(2, barW * (forecast.chancePct / 100)), 8);

      // The risk, in plain words.
      ctx.font = "bold 12px sans-serif";
      ctx.fillStyle = forecast.danger ? "#f87171" : "#4ade80";
      ctx.fillText(
        forecast.danger ? `⚠ If it fails the scroll is spent and the weapon ${forecast.failure}.` : "✔ Safe: a failure could only cost the scroll.",
        c.x + 14, c.y + 114, c.w - 28,
      );

      // The damage, before and after.
      ctx.font = "12px monospace";
      ctx.fillStyle = "#e7e5e4";
      ctx.fillText(`Damage  ${forecast.damageNow}  →  ${forecast.damageAfter}`, c.x + 14, c.y + 134);
      ctx.fillStyle = "#86efac";
      ctx.fillText(`+${forecast.damageGain}  (${forecast.bonusNowPct}% → ${forecast.bonusAfterPct}%)`, c.x + 230, c.y + 134);
    }
  }

  // ---- the stage: the weapon's aura, and the result animation ----
  drawStage(ctx, layout, enchantCfg, now, state.result);

  // ---- scrolls ----
  ctx.textAlign = "left";
  for (const row of layout.shop.rows) {
    ctx.font = "bold 12px sans-serif";
    ctx.fillStyle = "#fde68a";
    const label = row.kind === "blessed" ? `🛡 Blessed: ${row.count}` : `📜 Standard: ${row.count}`;
    ctx.fillText(label, layout.card.x, row.y + 18, 146);
  }
  for (const b of layout.shop.buttons) {
    ctx.fillStyle = b.canAfford ? "rgba(21, 128, 61, 0.92)" : "rgba(87, 83, 78, 0.85)";
    rr(ctx, b.box.x, b.box.y, b.box.w, b.box.h, 4);
    ctx.fill();
    ctx.strokeStyle = b.canAfford ? "#4ade80" : "#78716c";
    ctx.stroke();
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = b.canAfford ? "#f0fdf4" : "#a8a29e";
    ctx.fillText(`Buy ${b.quantity} · ${b.cost.toLocaleString()}g`, b.box.x + b.box.w / 2, b.box.y + b.box.h / 2 + 1, b.box.w - 8);
  }

  // ---- the blessed toggle ----
  const bt = layout.blessedToggle;
  if (bt) {
    ctx.fillStyle = bt.on ? "rgba(30, 64, 175, 0.92)" : "rgba(41, 37, 36, 0.92)";
    rr(ctx, bt.box.x, bt.box.y, bt.box.w, bt.box.h, 4);
    ctx.fill();
    ctx.strokeStyle = bt.on ? "#93c5fd" : "#78716c";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = bt.on ? "#eff6ff" : "#d6d3d1";
    ctx.fillText(`🛡 Blessed scroll: ${bt.on ? "ON" : "off"} (${bt.count})`, bt.box.x + bt.box.w / 2, bt.box.y + bt.box.h / 2 + 1, bt.box.w - 8);
    ctx.textAlign = "left";
  }

  // ---- the Enchant button ----
  const e = layout.enchant;
  const plan = e.plan;
  const fill = !e.enabled ? "rgba(68, 64, 60, 0.9)" : e.armed ? "rgba(185, 28, 28, 0.95)" : (plan && plan.danger ? "rgba(194, 65, 12, 0.95)" : "rgba(21, 128, 61, 0.95)");
  const edge = !e.enabled ? "#78716c" : e.armed ? "#fecaca" : (plan && plan.danger ? "#fdba74" : "#4ade80");
  ctx.fillStyle = fill;
  rr(ctx, e.box.x, e.box.y, e.box.w, e.box.h, 6);
  ctx.fill();
  ctx.strokeStyle = edge;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = "bold 15px sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = e.enabled ? "#fff" : "#a8a29e";
  ctx.fillText(`🔨 ${e.label}`, e.box.x + e.box.w / 2, e.box.y + e.box.h / 2 + 1, e.box.w - 16);

  ctx.restore();
}

// The little stage under the forecast. Idle it shows the glow the weapon will have; for
// FORGE_ANIM_MS after a result it plays that result.
function drawStage(ctx, layout, cfg, now, result) {
  const s = layout.stage;
  ctx.save();
  ctx.beginPath();
  ctx.rect(s.x, s.y, s.w, s.h);
  ctx.clip();
  ctx.fillStyle = "rgba(14, 8, 6, 0.95)";
  ctx.fillRect(s.x, s.y, s.w, s.h);
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;

  // A forge-coal glow at the bottom, always.
  const pulse = 0.5 + 0.5 * Math.sin(now / 420);
  const coal = ctx.createRadialGradient(cx, s.y + s.h + 10, 4, cx, s.y + s.h + 10, s.w * 0.55);
  coal.addColorStop(0, `rgba(249, 115, 22, ${0.35 + 0.15 * pulse})`);
  coal.addColorStop(1, "rgba(249, 115, 22, 0)");
  ctx.fillStyle = coal;
  ctx.fillRect(s.x, s.y, s.w, s.h);

  const anim = forgeAnimation(result, now);
  const fireLevel = cfg ? cfg.glowFireLevel : 10;
  if (!anim) {
    // Idle: the aura the weapon has now (or will have after the next scroll).
    const sel = layout.selected;
    const level = sel ? sel.level : 0;
    if (cfg && level > 0 && glowParams(level, { minLevel: cfg.glowMinLevel, fireLevel, maxLevel: cfg.maxLevel })) {
      drawWeaponGlow(ctx, cx, cy, level, now, { minLevel: cfg.glowMinLevel, fireLevel, maxLevel: cfg.maxLevel, zoom: 2.2 });
    }
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#78716c";
    ctx.fillText(sel ? "The anvil is ready." : "Choose a weapon.", cx, s.y + s.h - 12);
  } else {
    drawResult(ctx, anim, cx, cy, s, fireLevel, cfg, now);
  }
  ctx.restore();
}

function drawResult(ctx, anim, cx, cy, s, fireLevel, cfg, now) {
  const { kind, t, level } = anim;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (kind === "success") {
    const hot = level >= fireLevel;
    const core = hot ? "248, 113, 113" : "103, 232, 249";
    // Expanding ring and a burst of sparks.
    const ring = 18 + 90 * t;
    ctx.strokeStyle = `rgba(${core}, ${1 - t})`;
    ctx.lineWidth = 4 * (1 - t) + 1;
    ctx.beginPath();
    ctx.arc(cx, cy, ring, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `rgba(${core}, ${1 - t})`;
    for (let i = 0; i < 14; i += 1) {
      const a = (i / 14) * Math.PI * 2 + 0.3;
      const d = 24 + 80 * t * (0.6 + 0.4 * ((i * 7) % 5) / 4);
      ctx.fillRect(cx + Math.cos(a) * d - 2, cy + Math.sin(a) * d * 0.7 - 2, 4, 4);
    }
    if (cfg && glowParams(level, { minLevel: cfg.glowMinLevel, fireLevel, maxLevel: cfg.maxLevel })) {
      drawWeaponGlow(ctx, cx, cy, level, now, { minLevel: cfg.glowMinLevel, fireLevel, maxLevel: cfg.maxLevel, zoom: 1.5 + 1.5 * t });
    }
    ctx.font = `bold ${Math.round(26 + 12 * Math.sin(Math.PI * t))}px sans-serif`;
    ctx.fillStyle = `rgba(255, 247, 237, ${Math.min(1, 1.6 - t)})`;
    ctx.fillText(`+${level}!`, cx, cy);
  } else if (kind === "reset") {
    // A blessed scroll missed: a blue shield flares round the weapon, which falls back but lives.
    const a = Math.max(0, 1 - t);
    ctx.strokeStyle = `rgba(96, 165, 250, ${a})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, 24 + 40 * t, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = "bold 22px sans-serif";
    ctx.fillStyle = `rgba(191, 219, 254, ${Math.min(1, 1.7 - t)})`;
    ctx.fillText(`SAVED · back to +${level}`, cx, cy);
  } else if (kind === "destroyed") {
    // Flames climbing off a dying weapon, and a shaking caption.
    for (let i = 0; i < 18; i += 1) {
      const seed = (i * 37) % 11 / 11;
      const x = cx + (i - 9) * 11 + Math.sin(now / 90 + i) * 5;
      const rise = t * (60 + 60 * seed);
      const size = (16 - 12 * t) * (0.7 + seed * 0.6);
      const y = s.y + s.h - 6 - rise;
      ctx.fillStyle = `rgba(${239 - Math.round(60 * t)}, ${Math.round(110 - 80 * t * seed)}, 20, ${0.9 - 0.8 * t})`;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.5, size), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = "bold 24px sans-serif";
    ctx.fillStyle = `rgba(254, 202, 202, ${Math.min(1, 1.7 - t)})`;
    ctx.fillText("BURNED", cx + Math.sin(now / 30) * (6 * (1 - t)), cy - 6);
  } else {
    // safe_fail: a grey puff that drifts up and thins out.
    for (let i = 0; i < 6; i += 1) {
      const r = 10 + 14 * t + i * 3;
      ctx.fillStyle = `rgba(168, 162, 158, ${0.35 * (1 - t)})`;
      ctx.beginPath();
      ctx.arc(cx + (i - 3) * 14, cy + 10 - 40 * t - i * 4, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = "bold 18px sans-serif";
    ctx.fillStyle = `rgba(231, 229, 228, ${1 - t})`;
    ctx.fillText("The scroll fizzled.", cx, cy);
  }
}
