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

export function layoutInventory(state) {
  const {
    inventory,
    selectedItemId = null,
    gold = 0,
    autoLoot = false,
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
    tabs: [],
    cells: [],
    pages: { count: 1, page: 0, prev: null, next: null },
    footer: { gold, autoLoot: autoLootRect, autoLootOn: autoLoot === true, drop },
    used: usedSlotsClient(inventory),
    capacity: capacityOf(inventory),
    hitAreas,
  };
}
