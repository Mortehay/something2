// Layout for the canvas inventory window. PURE: this module computes rects
// and never touches a canvas, which is what makes the grid maths, the tab
// filter and the paging testable without a rendering context. drawInventory
// paints exactly what this returns and decides nothing itself.
import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import { SLOTS, typeOf, canEquipClient } from "../core/inventory.js";

export const PANEL_W = 820;
// Sized to its content, not to the old list panel: title 30 + preview 190 +
// four rows of paperdoll ends at ~388, and six grid rows end at ~366, so 480
// leaves one footer row and no dead space. Measured in the browser.
export const PANEL_H = 480;
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

// Category tints. A cell has no artwork to draw (item_types carries no icon),
// so the tint plus the name's initials is the whole "icon" today.
const CATEGORY_TINT = {
  weapon: "#7f1d1d",
  armor: "#1e3a5f",
  ammo: "#78350f",
  consumable: "#14532d",
  stone: "#4c1d95",
};

function initials(name) {
  return String(name || "?").trim().slice(0, 2).toUpperCase();
}

export function statLine(type) {
  if (!type) return "";
  if (type.category === "weapon") {
    return `dmg ${type.damage}  cd ${type.cooldown}s${type.two_handed ? "  (2H)" : ""}`;
  }
  const res = Object.entries(type.resistances || {});
  return `def ${type.defense ?? 0}${res.length ? "  " + res.map(([el, v]) => `${el} ${v}`).join(", ") : ""}`;
}

function inside(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

export function drawInventory(ctx, layout, state) {
  const { playerImage = null, hoverX = null, hoverY = null, drag = null } = state || {};
  const { panel, title, close } = layout;

  ctx.save();
  ctx.textBaseline = "top";
  // Nearly opaque, unlike the old list panel's 0.55: a grid of small cells
  // over a moving, saturated world is unreadable at low alpha — verified in
  // the browser, where the terrain showed straight through the empty cells.
  ctx.fillStyle = "rgba(12,12,20,0.94)";
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  ctx.strokeStyle = "#3a3a4e";
  ctx.lineWidth = 2;
  ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);

  // Title bar.
  ctx.fillStyle = "rgba(30,30,45,0.95)";
  ctx.fillRect(title.x, title.y, title.w, title.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "14px monospace";
  ctx.fillText(`Inventory  (${layout.used}/${layout.capacity})`, title.x + 12, title.y + 8);
  ctx.fillStyle = "rgba(120,40,40,0.9)";
  ctx.fillRect(close.x, close.y, close.w, close.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText("X", close.x + 6, close.y + 3);

  // Character preview: the player sprite scaled into its box. No equipment
  // overlay — the sprite carries no gear, and faking it is a separate epic.
  const p = layout.preview;
  ctx.fillStyle = "rgba(20,20,32,0.9)";
  ctx.fillRect(p.x, p.y, p.w, p.h);
  ctx.strokeStyle = "#3a3a4e";
  ctx.strokeRect(p.x, p.y, p.w, p.h);
  if (playerImage) ctx.drawImage(playerImage, p.x + 8, p.y + 8, p.w - 16, p.h - 16);

  // Paperdoll.
  ctx.font = "11px monospace";
  for (const s of layout.slots) {
    ctx.fillStyle = s.disabled ? "rgba(60,60,70,0.5)" : "rgba(40,40,60,0.85)";
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeStyle = s.disabled ? "#3a3a3a" : "#4a9eff";
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = s.disabled ? "#6b7280" : "#e5e7eb";
    ctx.fillText(s.slot, s.x + 5, s.y + 4);
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(s.equippedName || "-", s.x + 5, s.y + 16);
  }

  // Tabs.
  ctx.font = "12px monospace";
  for (const t of layout.tabs) {
    ctx.fillStyle = t.active ? "rgba(74,158,255,0.32)" : "rgba(40,40,60,0.85)";
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.strokeStyle = t.active ? "#4a9eff" : "#3a3a4e";
    ctx.strokeRect(t.x, t.y, t.w, t.h);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(t.label, t.x + 8, t.y + 6);
  }

  // Grid.
  for (const c of layout.cells) {
    const dragged = drag && c.item && drag.itemId === c.item.id;
    ctx.fillStyle = c.item ? (CATEGORY_TINT[c.type && c.type.category] || "rgba(55,55,70,0.9)") : "rgba(25,25,38,0.9)";
    ctx.globalAlpha = dragged ? 0.3 : 1;
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.strokeStyle = c.selected ? "#4a9eff" : "#2a2a3a";
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    if (c.item) {
      ctx.fillStyle = "#e5e7eb";
      ctx.font = "14px monospace";
      ctx.fillText(initials(c.type && c.type.name), c.x + 8, c.y + 14);
      // Only a real STACK is badged: a "1" on every single item is noise, and
      // the reference screenshot badges the same way.
      if (c.item.quantity > 1) {
        ctx.font = "10px monospace";
        ctx.fillStyle = "#fde68a";
        ctx.fillText(String(c.item.quantity), c.x + c.w - 16, c.y + c.h - 12);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Page arrows.
  ctx.font = "12px monospace";
  for (const [rect, label] of [[layout.pages.prev, "<"], [layout.pages.next, ">"]]) {
    if (!rect) continue;
    ctx.fillStyle = "rgba(40,40,60,0.85)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = "#4a9eff";
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(label, rect.x + 12, rect.y + 6);
  }
  if (layout.pages.count > 1) {
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(`page ${layout.pages.page + 1}/${layout.pages.count}`, layout.pages.x + 84, layout.pages.arrowY + 6);
  }

  // Footer.
  const f = layout.footer;
  ctx.fillStyle = f.autoLootOn ? "rgba(74,158,255,0.28)" : "rgba(40,40,60,0.85)";
  ctx.fillRect(f.autoLoot.x, f.autoLoot.y, f.autoLoot.w, f.autoLoot.h);
  ctx.strokeStyle = "#4a9eff";
  ctx.strokeRect(f.autoLoot.x, f.autoLoot.y, f.autoLoot.w, f.autoLoot.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText(`Auto-loot: ${f.autoLootOn ? "ON" : "OFF"}`, f.autoLoot.x + 8, f.autoLoot.y + 7);
  if (f.drop) {
    ctx.fillStyle = "rgba(120,40,40,0.85)";
    ctx.fillRect(f.drop.x, f.drop.y, f.drop.w, f.drop.h);
    ctx.strokeStyle = "#ef4444";
    ctx.strokeRect(f.drop.x, f.drop.y, f.drop.w, f.drop.h);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText("Drop selected", f.drop.x + 8, f.drop.y + 7);
  }
  ctx.fillStyle = "#fde68a";
  ctx.fillText(`Gold: ${f.gold ?? 0}`, layout.panel.x + layout.panel.w - 200, f.autoLoot.y + 7);

  // Tooltip last, so nothing paints over it. Suppressed mid-drag: the ghost is
  // already following the cursor and two floating boxes read as a glitch.
  if (!drag && hoverX != null && hoverY != null) {
    const cell = layout.cells.find((c) => c.item && inside(c, hoverX, hoverY));
    if (cell) {
      const name = (cell.type && cell.type.name) || "unknown item";
      const stats = statLine(cell.type);
      const w = Math.max(ctx.measureText(name).width, ctx.measureText(stats).width) + 16;
      const h = 38;
      // Clamped to the canvas: a cell in the right-hand column would otherwise
      // push its tooltip off-screen, and the right-hand column is exactly
      // where the grid ends.
      const tx = Math.min(hoverX + 12, GAME_WIDTH - w - 4);
      const ty = Math.min(hoverY + 12, GAME_HEIGHT - h - 4);
      ctx.fillStyle = "rgba(10,10,18,0.95)";
      ctx.fillRect(tx, ty, w, h);
      ctx.strokeStyle = "#4a9eff";
      ctx.strokeRect(tx, ty, w, h);
      ctx.fillStyle = "#e5e7eb";
      ctx.fillText(name, tx + 8, ty + 5);
      ctx.fillStyle = "#9ca3af";
      ctx.fillText(stats, tx + 8, ty + 20);
    }
  }

  // Ghost last so it rides above every panel element it passes over. Drawn
  // only once ARMED: an un-armed candidate is still just a click.
  if (drag && drag.armed && drag.itemId != null) {
    const src = layout.cells.find((c) => c.item && c.item.id === drag.itemId);
    const label = src && src.type ? initials(src.type.name) : "??";
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = src && src.type ? (CATEGORY_TINT[src.type.category] || "rgba(55,55,70,0.9)") : "rgba(55,55,70,0.9)";
    ctx.fillRect(drag.x - CELL / 2, drag.y - CELL / 2, CELL, CELL);
    ctx.strokeStyle = "#4a9eff";
    ctx.strokeRect(drag.x - CELL / 2, drag.y - CELL / 2, CELL, CELL);
    ctx.fillStyle = "#e5e7eb";
    ctx.font = "14px monospace";
    ctx.fillText(label, drag.x - CELL / 2 + 8, drag.y - 8);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

// Resolve a finished drag against the layout it started on. PURE, so every
// outcome is a unit test rather than a mouse gesture. The caller (Game) turns
// the returned action into a wire message; nothing here talks to the server,
// and canEquipClient is used only to suppress a request the server would
// refuse anyway -- it authorizes nothing.
export function resolveDrop(layout, drag, point, inventory) {
  if (!drag || !drag.from) return { action: "none" };
  const { x, y } = point || {};
  if (typeof x !== "number" || typeof y !== "number") return { action: "none" };

  const onSlot = layout.slots.find((s) => inside(s, x, y)) || null;
  const onCell = layout.cells.find((c) => inside(c, x, y)) || null;
  const onPanel = inside(layout.panel, x, y);

  if (drag.from.kind === "item") {
    if (onSlot) {
      if (drag.itemId == null) return { action: "none" };
      if (!canEquipClient(inventory, drag.itemId, onSlot.slot)) return { action: "none" };
      return { action: "equip", itemId: drag.itemId, slot: onSlot.slot };
    }
    // Cell-to-cell is deliberately inert: player_items carries no slot index,
    // so a rearrangement would vanish on the next join. Refusing is honest;
    // animating a change the server forgets is not. Anywhere else INSIDE the
    // panel (tabs, title bar, footer) is equally inert -- only leaving the
    // panel entirely means "drop this on the ground".
    if (onCell || onPanel) return { action: "none" };
    return { action: "drop", itemId: drag.itemId };
  }

  if (drag.from.kind === "slot") {
    if (drag.itemId == null) return { action: "none" };  // dragging an empty slot
    if (onCell) return { action: "unequip", slot: drag.from.id };
    return { action: "none" };
  }

  return { action: "none" };
}
