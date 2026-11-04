// Layouts and drawing for the Account Chest and village merchant windows that
// sit beside the full inventory. The layout functions are pure geometry and hit
// areas; the draw functions below paint exactly what they return and decide
// nothing. Game's hit handling consumes the layouts.

import {
  CELL, GUTTER, PANEL_H, drawItemCell, drawDragGhost, drawTooltipBox, formatItemTooltipLines, inside,
} from "./inventoryPanel.js";
import { buildShopRows, priceParts, bannerText, lockedRowText } from "./shopReputation.js";
import { comparisonSlot, compareLines } from "./itemCompare.js";
import { rarityBorderColor, clipToWidth } from "./itemDisplay.js";
import { t } from "../i18n/i18n.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";

export const WINDOW_W = 408;
export const WINDOW_X = 23;
export const INVENTORY_X = 437;
export const WINDOW_Y = 120;
export const WINDOW_CELLS = 40;

const COLS = 8;
const TITLE_H = 30;
const PAD = 14;
const TAB_H = 24;
const BANNER_H = 18;

function frame() {
  const panel = { x: WINDOW_X, y: WINDOW_Y, w: WINDOW_W, h: PANEL_H };
  const title = { x: WINDOW_X, y: WINDOW_Y, w: WINDOW_W, h: TITLE_H };
  const close = { x: WINDOW_X + WINDOW_W - 8 - 20, y: WINDOW_Y + 5, w: 20, h: 20 };
  return { panel, title, close, hitAreas: [{ ...close, kind: "winclose", id: null }] };
}

function cellRect(gridTop, i) {
  return {
    x: WINDOW_X + PAD + (i % COLS) * (CELL + GUTTER),
    y: gridTop + Math.floor(i / COLS) * (CELL + GUTTER),
    w: CELL, h: CELL,
  };
}

function emptyCells(gridTop) {
  return Array.from({ length: WINDOW_CELLS }, (_, i) => ({ ...cellRect(gridTop, i), item: null, type: null }));
}

export function layoutChestWindow({ bank, types }) {
  const { panel, title, close, hitAreas } = frame();
  const items = (bank && bank.items) || [];
  const typeMap = types || new Map();
  const tabsY = WINDOW_Y + TITLE_H + PAD;
  // Same grid top as the merchant window (no banner), so the two line up.
  const gridTop = tabsY + TAB_H + 10;
  const cells = emptyCells(gridTop);

  // Rows sit in their stored slot; a row with a missing/out-of-range/duplicate
  // slot takes the first free cell so it is never dropped from the layout.
  const overflow = [];
  for (const row of items) {
    const s = row.slot;
    if (Number.isInteger(s) && s >= 0 && s < WINDOW_CELLS && !cells[s].item) cells[s].item = { ...row };
    else overflow.push(row);
  }
  for (const row of overflow) {
    const free = cells.find((c) => !c.item);
    if (free) free.item = { ...row };
  }
  for (const c of cells) {
    if (!c.item) continue;
    c.type = typeMap.get(c.item.typeId) || null;
    hitAreas.push({ x: c.x, y: c.y, w: c.w, h: c.h, kind: "chestitem", id: c.item.id, typeId: c.item.typeId });
  }

  const used = items.length;
  const capacity = Number.isFinite(bank && bank.capacity) ? bank.capacity : WINDOW_CELLS;
  return {
    kind: "chest",
    panel, title, close,
    stored: { x: WINDOW_X + PAD, y: tabsY, w: WINDOW_W - 2 * PAD, h: TAB_H },
    cells,
    occupancy: { used, capacity, full: used >= capacity },
    hitAreas,
  };
}

export function layoutMerchantWindow({ shop, view, gold = 0, types }) {
  const { panel, title, close, hitAreas } = frame();
  const typeMap = types || new Map();
  const catalog = (shop && shop.catalog) || [];
  const buyback = (shop && shop.buyback) || [];
  const isBuyback = !!(view && view.tab === "buyback");

  const bannerStr = bannerText(shop && shop.reputation);
  const banner = bannerStr ? bannerStr : null;
  const bannerY = WINDOW_Y + TITLE_H + 6;
  const tabsY = WINDOW_Y + TITLE_H + PAD + (banner ? BANNER_H : 0);

  const tabW = 150, tabGap = 8;
  const tabs = [
    { id: "catalog", label: t("Catalog ({n})", { n: catalog.length }), count: catalog.length, active: !isBuyback },
    { id: "buyback", label: t("Buyback ({n})", { n: buyback.length }), count: buyback.length, active: isBuyback },
  ].map((tab, i) => ({ ...tab, x: WINDOW_X + PAD + i * (tabW + tabGap), y: tabsY, w: tabW, h: TAB_H }));
  for (const tab of tabs) hitAreas.push({ x: tab.x, y: tab.y, w: tab.w, h: tab.h, kind: "shoptab", id: tab.id });

  // The header row is a drawing artefact of the old list; a grid has no use for it.
  const rows = isBuyback ? buyback : buildShopRows(catalog, shop && shop.lockedCatalog).filter((r) => !r.header);
  const pageCount = Math.max(1, Math.ceil(rows.length / WINDOW_CELLS));
  const rawPage = view && Number.isFinite(view.page) ? Math.floor(view.page) : 0;
  const pageIdx = Math.min(Math.max(rawPage, 0), pageCount - 1);

  const gridTop = tabsY + TAB_H + 10;
  const cells = emptyCells(gridTop);
  rows.slice(pageIdx * WINDOW_CELLS, (pageIdx + 1) * WINDOW_CELLS).forEach((row, i) => {
    const c = cells[i];
    const price = priceParts(row).price;
    c.item = { ...row, typeId: row.itemTypeId };
    c.type = typeMap.get(row.itemTypeId) || null;
    c.price = price;
    if (row.locked) {
      c.locked = true;
      hitAreas.push({ x: c.x, y: c.y, w: c.w, h: c.h, kind: "lockedware", row });
    } else {
      hitAreas.push({ x: c.x, y: c.y, w: c.w, h: c.h, kind: "stockitem", id: row.id, typeId: row.itemTypeId, price });
    }
  });

  const arrowY = gridTop + Math.ceil(WINDOW_CELLS / COLS) * (CELL + GUTTER) + 8;
  const left = WINDOW_X + PAD;
  const prev = pageIdx > 0 ? { x: left, y: arrowY, w: 32, h: 24 } : null;
  const next = pageIdx < pageCount - 1 ? { x: left + 40, y: arrowY, w: 32, h: 24 } : null;
  if (prev) hitAreas.push({ ...prev, kind: "shoppage", id: pageIdx - 1 });
  if (next) hitAreas.push({ ...next, kind: "shoppage", id: pageIdx + 1 });

  return {
    kind: "merchant",
    panel, title, close,
    banner,
    bannerPos: { x: left, y: bannerY },
    tabs, cells,
    pages: { index: pageIdx, count: pageCount, prev, next },
    gold,
    hitAreas,
  };
}

// ---------------------------------------------------------------- drawing

const AMBER = "#caa24a";
const GREEN = "#4ade80";
const PRICE_FONT_PX = 10;

// A price must fit a 44 px cell at 10 px monospace (7 characters at best).
// 10000 and above is abbreviated ("10k", "1.2M"); clipToWidth is the backstop.
export function priceLabel(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  let text;
  if (v >= 1000000) text = `${Math.floor(v / 100000) / 10}M`;
  else if (v >= 10000) text = `${Math.floor(v / 1000)}k`;
  else text = String(v);
  return clipToWidth(text, CELL - 4, PRICE_FONT_PX);
}

function drawButtonLabel(ctx, rect, label) {
  ctx.fillStyle = "rgba(40,40,60,0.85)";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = "#4a9eff";
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText(label, rect.x + 12, rect.y + 6);
}

function isDraggedCell(cell, drag) {
  if (!drag || !drag.from || !cell.item) return false;
  const k = drag.from.kind;
  return (k === "chestitem" || k === "stockitem") && drag.from.id === cell.item.id;
}

// `state`: { drag, enchantCfg }. `art` is the GameArt lookup, null draws initials.
export function drawItemWindow(ctx, layout, state, art = null) {
  const { drag = null, enchantCfg = null } = state || {};
  const { panel, title, close } = layout;
  const merchant = layout.kind === "merchant";

  ctx.save();
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(12,12,20,0.94)";
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  ctx.strokeStyle = "#3a3a4e";
  ctx.lineWidth = 2;
  ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);

  ctx.fillStyle = "rgba(30,30,45,0.95)";
  ctx.fillRect(title.x, title.y, title.w, title.h);
  ctx.font = "14px monospace";
  if (merchant) {
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(t("Merchant"), title.x + 12, title.y + 8);
    ctx.fillStyle = "#fde68a";
    ctx.textAlign = "right";
    ctx.fillText(t("Gold: {n}", { n: layout.gold ?? 0 }), close.x - 10, title.y + 8);
    ctx.textAlign = "left";
  } else {
    const occ = layout.occupancy;
    // Amber at the cap, so a full chest is visible before a deposit is refused.
    ctx.fillStyle = occ.full ? AMBER : "#e5e7eb";
    ctx.fillText(t("Account Chest ({used}/{cap})", { used: occ.used, cap: occ.capacity }), title.x + 12, title.y + 8);
  }
  ctx.fillStyle = "rgba(120,40,40,0.9)";
  ctx.fillRect(close.x, close.y, close.w, close.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "14px monospace";
  ctx.fillText("X", close.x + 6, close.y + 3);

  ctx.font = "12px monospace";
  if (merchant) {
    if (layout.banner) {
      ctx.fillStyle = "#fde68a";
      ctx.fillText(layout.banner, layout.bannerPos.x, layout.bannerPos.y);
    }
    for (const tab of layout.tabs) {
      const amber = tab.id === "buyback";
      ctx.fillStyle = tab.active ? (amber ? "rgba(202,162,74,0.28)" : "rgba(74,158,255,0.28)") : "rgba(40,40,60,0.85)";
      ctx.fillRect(tab.x, tab.y, tab.w, tab.h);
      ctx.strokeStyle = tab.active ? (amber ? AMBER : "#4a9eff") : "#3a3a4e";
      ctx.strokeRect(tab.x, tab.y, tab.w, tab.h);
      ctx.fillStyle = "#e5e7eb";
      ctx.fillText(tab.label, tab.x + 8, tab.y + 6);
    }
  } else {
    const st = layout.stored;
    ctx.fillStyle = "rgba(202,162,74,0.28)";
    ctx.fillRect(st.x, st.y, st.w, st.h);
    ctx.strokeStyle = AMBER;
    ctx.strokeRect(st.x, st.y, st.w, st.h);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(t("Stored ({n})", { n: layout.occupancy.used }), st.x + 8, st.y + 6);
  }

  const buybackTab = merchant && layout.tabs.some((x) => x.id === "buyback" && x.active);
  let any = false;
  for (const c of layout.cells) {
    if (c.item) any = true;
    drawItemCell(ctx, c, art, {
      dimmed: isDraggedCell(c, drag), enchantCfg, alpha: c.locked ? 0.55 : 1,
    });
    if (!c.item) continue;
    if (buybackTab && !rarityBorderColor(c.item.rarity, null)) {
      ctx.strokeStyle = AMBER;
      ctx.strokeRect(c.x, c.y, c.w, c.h);
    }
    if (!merchant && c.item.soulbound === true) {
      ctx.font = "9px monospace";
      ctx.fillStyle = AMBER;
      ctx.fillText(t("bound"), c.x + 3, c.y + 3);
    }
    if (c.locked) {
      ctx.font = "16px monospace";
      ctx.fillStyle = "#e5e7eb";
      ctx.fillText("\u{1F512}", c.x + c.w / 2 - 8, c.y + 8);
    }
    if (merchant && typeof c.price === "number") {
      ctx.fillStyle = "rgba(10,10,18,0.85)";
      ctx.fillRect(c.x + 1, c.y + c.h - 12, c.w - 2, 11);
      ctx.font = `${PRICE_FONT_PX}px monospace`;
      ctx.fillStyle = "#fde68a";
      ctx.fillText(priceLabel(c.price), c.x + 3, c.y + c.h - 11);
    }
  }

  if (!any) {
    const first = layout.cells[0];
    ctx.font = "12px monospace";
    ctx.fillStyle = "#6b7280";
    const msg = !merchant ? t("Your chest is empty.") : buybackTab ? t("No buyback stock.") : t("Nothing for sale.");
    ctx.fillText(msg, first.x + 4, first.y + 20);
  }

  if (merchant) {
    ctx.font = "12px monospace";
    if (layout.pages.prev) drawButtonLabel(ctx, layout.pages.prev, "<");
    if (layout.pages.next) drawButtonLabel(ctx, layout.pages.next, ">");
    if (layout.pages.count > 1) {
      ctx.fillStyle = "#9ca3af";
      const arrow = layout.pages.prev || layout.pages.next;
      ctx.fillText(t("page {n}/{total}", { n: layout.pages.index + 1, total: layout.pages.count }), panel.x + 14 + 84, arrow.y + 6);
    }
  }
  ctx.restore();
}

function windowTooltipLines(cell, layout, invLayout, enchantCfg) {
  const lines = formatItemTooltipLines(cell.item, cell.type, enchantCfg);
  if (lines.length === 0) return lines;
  const slotName = cell.type ? comparisonSlot(cell.type) : null;
  if (slotName) {
    const slot = invLayout && invLayout.slots ? invLayout.slots.find((s) => s.slot === slotName) : null;
    lines.push(...compareLines(cell.item, cell.type, slot ? slot.equippedItem : null, slot ? slot.equippedType : null));
  }
  if (layout.kind === "merchant") {
    if (cell.locked) lines.push({ text: lockedRowText(cell.item), color: "#f87171", font: "10px monospace" });
    else if (typeof cell.price === "number") lines.push({ text: t("{n} g", { n: cell.price }), color: "#fde68a", font: "11px monospace" });
  }
  return lines;
}

// Everything that rides above BOTH windows: the window's tooltip, the drag
// ghost, the green target outline and the hint beside the cursor. `drop` is the
// resolvePairedDrop result for this frame; `types` is inventory.types.
export function drawPairedOverlay(ctx, params, art = null) {
  const { winLayout, invLayout, drag = null, hover = null, drop = null, enchantCfg = null, types = null } = params || {};
  if (!winLayout) return;

  ctx.save();
  ctx.textBaseline = "top";

  if (!drag && hover && hover.x != null && hover.y != null) {
    const cell = winLayout.cells.find((c) => c.item && c.type && inside(c, hover.x, hover.y));
    if (cell) {
      drawTooltipBox(ctx, windowTooltipLines(cell, winLayout, invLayout, enchantCfg), hover.x, hover.y, cell.item.rarity);
    }
  }

  if (drop && drop.hint && drag && drag.armed) {
    const target = drop.target === "window" ? winLayout.panel : (invLayout && invLayout.panel);
    if (target) {
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 2;
      ctx.strokeRect(target.x, target.y, target.w, target.h);
    }
  }

  if (drag && drag.armed) {
    let type = null;
    const fromWindow = drag.from && (drag.from.kind === "chestitem" || drag.from.kind === "stockitem");
    if (fromWindow) {
      type = (types && types.get ? types.get(drag.typeId) : null)
        || (winLayout.cells.find((c) => c.item && c.item.id === drag.from.id) || {}).type || null;
    } else if (drag.itemId != null && invLayout) {
      const src = invLayout.cells.find((c) => c.item && c.item.id === drag.itemId);
      const slot = src ? null : (invLayout.slots || []).find((s) => s.equippedItem && s.equippedItem.id === drag.itemId);
      type = src ? src.type : slot ? slot.equippedType : null;
    }
    if (fromWindow || drag.itemId != null) drawDragGhost(ctx, drag.x, drag.y, type, art);

    if (drop && drop.hint) {
      ctx.font = "12px monospace";
      const w = Math.ceil(ctx.measureText(drop.hint).width) + 12;
      const hx = Math.min(Math.max(4, drag.x + 16), GAME_WIDTH - w - 4);
      const hy = Math.min(Math.max(4, drag.y + 22), GAME_HEIGHT - 24);
      ctx.fillStyle = "rgba(10,10,18,0.96)";
      ctx.fillRect(hx, hy, w, 20);
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 1;
      ctx.strokeRect(hx, hy, w, 20);
      ctx.fillStyle = GREEN;
      ctx.fillText(drop.hint, hx + 6, hy + 4);
    }
  }
  ctx.restore();
}
