// Pure layouts for the Account Chest and village merchant windows that sit
// beside the full inventory. Geometry and hit areas only: no drawing, no
// input. Drawing and Game's hit handling consume the shapes returned here.

import { CELL, GUTTER, PANEL_H } from "./inventoryPanel.js";
import { buildShopRows, priceParts, bannerText } from "./shopReputation.js";
import { t } from "../i18n/i18n.js";

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
