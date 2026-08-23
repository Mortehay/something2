// Layout for the canvas inventory window. PURE: this module computes rects
// and never touches a canvas, which is what makes the grid maths, the tab
// filter and the paging testable without a rendering context. drawInventory
// paints exactly what this returns and decides nothing itself.
import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import { SLOTS, typeOf, canEquipClient } from "../core/inventory.js";

export const PANEL_W = 820;
export const PANEL_H = 580;
export const GRID_COLS = 8;
export const GRID_ROWS = 6;
export const CELL = 44;
export const GUTTER = 4;
export const CELLS_PER_PAGE = GRID_COLS * GRID_ROWS;

const TITLE_H = 30;
const PAD = 14;
const LEFT_W = 250;
const PREVIEW_H = 190;
const SLOT_W = 122;   // two columns of these plus one 6px gap == LEFT_W
const SLOT_H = 30;
const FOOTER_H = 40;

// A stack of gold is a wallet number, never a grid cell — see the footer.
const HIDDEN_CATEGORIES = new Set(["currency"]);

export function capacityOf(inventory) {
  const c = Number(inventory && inventory.capacity);
  return Number.isInteger(c) && c > 0 ? c : CELLS_PER_PAGE;
}

// Counts STACKS, mirroring the server rule in authority/items.js usedSlots.
// An item whose type is unknown to this client still occupies a slot: the
// server counted it, and a client that quietly skipped it would render a
// used count lower than the one the server enforces against.
export function usedSlotsClient(inventory) {
  const items = (inventory && inventory.items) || [];
  const types = (inventory && inventory.types) || new Map();
  let n = 0;
  for (const it of items) {
    const t = types.get(it.typeId);
    if (t && HIDDEN_CATEGORIES.has(t.category)) continue;
    n += 1;
  }
  return n;
}

// `categories: null` means "everything not hidden" — an item whose category
// is new server-side lands under All rather than becoming invisible.
export const TABS = [
  { key: "all", label: "All", categories: null },
  { key: "equip", label: "Equip", categories: ["weapon", "armor"] },
  { key: "supply", label: "Supply", categories: ["ammo", "consumable"] },
  { key: "stones", label: "Stones", categories: ["stone"] },
];

export function visibleItems(inventory, tabKey) {
  const tab = TABS.find((t) => t.key === tabKey) || TABS[0];
  const types = (inventory && inventory.types) || new Map();
  return ((inventory && inventory.items) || []).filter((it) => {
    const t = types.get(it.typeId);
    const category = t ? t.category : null;
    if (category != null && HIDDEN_CATEGORIES.has(category)) return false;
    if (tab.categories === null) return true;
    return category != null && tab.categories.includes(category);
  });
}

export function layoutInventory(state) {
  const {
    inventory,
    selectedItemId = null,
    gold = 0,
    autoLoot = false,
    tab = "all",
    page = 0,
  } = state;

  const px = (GAME_WIDTH - PANEL_W) / 2;
  const py = (GAME_HEIGHT - PANEL_H) / 2;
  const panel = { x: px, y: py, w: PANEL_W, h: PANEL_H };
  const title = { x: px, y: py, w: PANEL_W, h: TITLE_H };
  const close = { x: px + PANEL_W - 8 - 20, y: py + 5, w: 20, h: 20 };

  const hitAreas = [{ ...close, kind: "invclose", id: null }];

  // Left column: the character preview on top, the eight paperdoll boxes in
  // two columns of four beneath it. Flanking the preview with the boxes (the
  // arrangement the reference screenshot uses) does not fit: two 112px boxes
  // plus gutters leave the sprite 14px of the 250px column.
  const colX = px + PAD;
  const colTop = py + TITLE_H + PAD;
  const preview = { x: colX, y: colTop, w: LEFT_W, h: PREVIEW_H };
  const slotsTop = colTop + PREVIEW_H + 10;
  const slots = SLOTS.map((slot, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = colX + col * (SLOT_W + 6);
    const y = slotsTop + row * (SLOT_H + 6);
    const equippedId = inventory.equipment[slot];
    const equippedType = equippedId != null ? typeOf(inventory, equippedId) : null;
    const disabled = selectedItemId != null && !canEquipClient(inventory, selectedItemId, slot);
    return {
      slot, x, y, w: SLOT_W, h: SLOT_H,
      equippedName: equippedType ? equippedType.name : null,
      disabled,
    };
  });
  for (const s of slots) hitAreas.push({ x: s.x, y: s.y, w: s.w, h: s.h, kind: "slot", id: s.slot });

  const rightX = px + PAD + LEFT_W + PAD;
  const tabsY = py + TITLE_H + PAD;
  const tabW = 84, tabH = 24;
  const activeTab = TABS.some((x) => x.key === tab) ? tab : "all";
  const tabs = TABS.map((t, i) => ({
    key: t.key, label: t.label,
    x: rightX + i * (tabW + 6), y: tabsY, w: tabW, h: tabH,
    active: t.key === activeTab,
  }));
  for (const t of tabs) hitAreas.push({ x: t.x, y: t.y, w: t.w, h: t.h, kind: "invtab", id: t.key });

  const shown = visibleItems(inventory, activeTab);
  const pageCount = Math.max(1, Math.ceil(shown.length / CELLS_PER_PAGE));
  // Clamped rather than trusted: the page survives a tab switch and an item
  // list that shrank under it (sold, dropped, stored), and an unclamped index
  // would render a blank grid the player cannot page back out of.
  const pageIdx = Math.min(Math.max(0, Math.floor(Number(page) || 0)), pageCount - 1);
  const gridTop = tabsY + tabH + 10;
  const cells = [];
  for (let i = 0; i < CELLS_PER_PAGE; i += 1) {
    const col = i % GRID_COLS;
    const row = Math.floor(i / GRID_COLS);
    const item = shown[pageIdx * CELLS_PER_PAGE + i] || null;
    const type = item ? inventory.types.get(item.typeId) || null : null;
    const cell = {
      x: rightX + col * (CELL + GUTTER),
      y: gridTop + row * (CELL + GUTTER),
      w: CELL, h: CELL,
      item, type,
      selected: item != null && item.id === selectedItemId,
    };
    cells.push(cell);
    if (item) hitAreas.push({ x: cell.x, y: cell.y, w: cell.w, h: cell.h, kind: "item", id: item.id });
  }

  const arrowY = gridTop + GRID_ROWS * (CELL + GUTTER) + 8;
  const prev = pageIdx > 0 ? { x: rightX, y: arrowY, w: 32, h: 24 } : null;
  const next = pageIdx < pageCount - 1 ? { x: rightX + 40, y: arrowY, w: 32, h: 24 } : null;
  if (prev) hitAreas.push({ ...prev, kind: "invpage", id: pageIdx - 1 });
  if (next) hitAreas.push({ ...next, kind: "invpage", id: pageIdx + 1 });

  const footerY = py + PANEL_H - PAD - FOOTER_H;
  const autoLootRect = { x: colX, y: footerY, w: 150, h: 26 };
  hitAreas.push({ ...autoLootRect, kind: "autoloot", id: null });
  let drop = null;
  if (selectedItemId != null) {
    drop = { x: colX + 160, y: footerY, w: 150, h: 26 };
    hitAreas.push({ ...drop, kind: "drop", id: selectedItemId });
  }

  return {
    panel, title, close, preview, slots,
    tabs,
    cells,
    pages: { count: pageCount, page: pageIdx, prev, next, arrowY, x: rightX },
    footer: { gold, autoLoot: autoLootRect, autoLootOn: autoLoot === true, drop },
    used: usedSlotsClient(inventory),
    capacity: capacityOf(inventory),
    hitAreas,
  };
}
