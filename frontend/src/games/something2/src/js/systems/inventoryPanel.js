// Layout for the canvas inventory window. PURE: this module computes rects
// and never touches a canvas, which is what makes the grid maths, the tab
// filter and the paging testable without a rendering context. drawInventory
// paints exactly what this returns and decides nothing itself.
import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import { SLOTS, typeOf, canEquipClient } from "../core/inventory.js";
import { rarityBorderColor, affixModifier } from "./itemDisplay.js";
import { layoutCharacterTab, drawCharacterTab, formatModifier, STAT_ABBR } from "./characterTab.js";

export const STAT_NAMES = {
  strength: "Strength",
  dexterity: "Dexterity",
  constitution: "Constitution",
  intelligence: "Intelligence",
  wisdom: "Wisdom",
  charisma: "Charisma",
};

const RESIST_COLORS = {
  physical: "#94a3b8",
  fire: "#f87171",
  ice: "#38bdf8",
  lightning: "#facc15",
  arcane: "#c084fc",
};

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
// `pane: "character"` marks the one tab that is NOT an item filter: it replaces
// the grid entirely (SOMET-483, spec §10.2), so it must feed the grid an empty
// list rather than inherit `categories: null`'s "show everything".
export const TABS = [
  { key: "all", label: "All", categories: null },
  { key: "equip", label: "Equip", categories: ["weapon", "armor"] },
  { key: "supply", label: "Supply", categories: ["ammo", "consumable"] },
  { key: "stones", label: "Stones", categories: ["stone"] },
  { key: "character", label: "Character", categories: null, pane: "character" },
];

export function visibleItems(inventory, tabKey) {
  const tab = TABS.find((t) => t.key === tabKey) || TABS[0];
  if (tab.pane === "character") return [];
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
    tab = "all",
    page = 0,
    drag = null,
    character = null,
    modPage = 0,
  } = state;

  // What the paperdoll's greying answers "can THIS go here?" about. An ARMED
  // drag wins over a click-selection: it is the item under the cursor right
  // now, and the affordance has to describe where the player can actually
  // drop. An un-armed candidate is still just a click, so it changes nothing.
  const candidateItemId = (drag && drag.armed && drag.itemId != null)
    ? drag.itemId : selectedItemId;

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
    const equippedItem = equippedId != null
      ? (inventory.items || []).find((it) => it.id === equippedId) || { id: equippedId, typeId: equippedType ? equippedType.id : null }
      : null;
    const disabled = candidateItemId != null && !canEquipClient(inventory, candidateItemId, slot);
    return {
      slot, x, y, w: SLOT_W, h: SLOT_H,
      equippedId,
      equippedName: equippedType ? equippedType.name : null,
      equippedType,
      equippedItem,
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

  // SOMET-493: the auto-loot toggle used to sit here, at colX. It moved to
  // the Settings panel (GameSettings.jsx) because it is a preference, not an
  // inventory operation, and burying a preference behind `i` made it something
  // players had to be told about. "Drop selected" inherits its slot rather
  // than leaving a hole where it was.
  const footerY = py + PANEL_H - PAD - FOOTER_H;
  let drop = null;
  if (selectedItemId != null) {
    drop = { x: colX, y: footerY, w: 150, h: 26 };
    hitAreas.push({ ...drop, kind: "drop", id: selectedItemId });
  }

  // The Character pane (SOMET-483, spec §10.2) occupies exactly the rectangle
  // the item grid and its page arrows would have. Built here rather than in the
  // draw so its geometry and its strings are testable without a context, and so
  // its page arrows can be hoisted into the same hitAreas list every other
  // control uses. `shown` is empty on this tab (see visibleItems), so the grid
  // loop above has already produced 48 empty cells and no item hit areas.
  const characterPane = TABS.find((t) => t.key === activeTab).pane === "character"
    ? layoutCharacterTab({
      character,
      x: rightX,
      y: gridTop,
      w: PANEL_W - (rightX - px) - PAD,
      h: footerY - gridTop - 8,
      modPage,
    })
    : null;
  if (characterPane) for (const a of characterPane.hitAreas) hitAreas.push(a);

  return {
    panel, title, close, preview, slots,
    tabs,
    cells,
    character: characterPane,
    pages: { count: pageCount, page: pageIdx, prev, next, arrowY, x: rightX },
    footer: { gold, y: footerY, drop },
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

export function formatItemTooltipLines(item, type) {
  if (!type) return [];
  const lines = [];

  // 1. Name
  const name = type.name || "Unknown Item";
  lines.push({
    text: name,
    color: rarityBorderColor(item ? item.rarity : null, "#e5e7eb"),
    font: "bold 13px monospace",
  });

  // 2. Category / Subtype / Slot
  let catText = "";
  if (type.category === "weapon") {
    catText = `${type.two_handed ? "Two-Handed " : ""}${type.kind === "projectile" ? "Ranged" : "Melee"} Weapon · Main Hand${type.tier ? " (Tier " + type.tier + ")" : ""}`;
  } else if (type.category === "armor") {
    catText = `${(type.slot ? type.slot.replace("_", " ") : "Armor").toUpperCase()}${type.tier ? " (Tier " + type.tier + ")" : ""}`;
  } else if (type.category === "stone") {
    catText = `Magic Stone${type.stone_mode ? " (" + type.stone_mode + ")" : ""}`;
  } else if (type.category === "consumable") {
    catText = "Consumable";
  } else if (type.category === "ammo") {
    catText = "Ammunition";
  }
  if (catText) {
    lines.push({ text: catText, color: "#9ca3af", font: "11px monospace" });
  }

  // 3. Core Combat / Defense Stats
  if (type.category === "weapon") {
    const dps = (type.damage > 0 && type.cooldown > 0) ? ` (${(type.damage / type.cooldown).toFixed(1)} DPS)` : "";
    lines.push({
      text: `dmg ${type.damage}  cd ${type.cooldown}s${type.two_handed ? "  (2H)" : ""}${dps}`,
      color: "#e5e7eb",
      font: "11px monospace",
    });
    if (type.element && type.element !== "physical") {
      lines.push({ text: `Element: ${type.element}`, color: RESIST_COLORS[type.element] || "#e5e7eb", font: "11px monospace" });
    }
    if (type.range) lines.push({ text: `Range: ${type.range}`, color: "#9ca3af", font: "11px monospace" });
    if (type.reach) lines.push({ text: `Reach: ${type.reach}`, color: "#9ca3af", font: "11px monospace" });
    if (type.stamina_cost > 0) lines.push({ text: `Stamina Cost: ${type.stamina_cost}`, color: "#fbbf24", font: "11px monospace" });
    if (type.mana_cost > 0) lines.push({ text: `Mana Cost: ${type.mana_cost}`, color: "#60a5fa", font: "11px monospace" });
    if (type.bonus_damage > 0) lines.push({ text: `+${type.bonus_damage} Bonus Damage`, color: "#f87171", font: "11px monospace" });
    if (type.knockback > 0) lines.push({ text: `Knockback: ${type.knockback}`, color: "#9ca3af", font: "11px monospace" });
  } else if (type.category === "armor") {
    if (type.defense != null && type.defense > 0) {
      lines.push({ text: `def ${type.defense}`, color: "#60a5fa", font: "11px monospace" });
    }
    if (type.resistances && typeof type.resistances === "object") {
      for (const [el, val] of Object.entries(type.resistances)) {
        if (val && Number(val) !== 0) {
          lines.push({
            text: `+${val}% ${el} resistance`,
            color: RESIST_COLORS[el] || "#9ca3af",
            font: "11px monospace",
          });
        }
      }
    }
  }

  // 4. Inherent Stat Bonus (e.g. +2 to Charisma)
  if (type.stat_bonus_stat && type.stat_bonus_amount != null) {
    const sName = STAT_NAMES[type.stat_bonus_stat] || type.stat_bonus_stat;
    lines.push({
      text: `+${type.stat_bonus_amount} to ${sName}`,
      color: "#4ade80",
      font: "bold 11px monospace",
    });
  }

  // 5. Rolled Affixes
  if (item && Array.isArray(item.affixes) && item.affixes.length > 0) {
    for (const a of item.affixes) {
      const mod = affixModifier(a);
      const formatted = formatModifier(mod);
      if (formatted) {
        lines.push({ text: formatted, color: "#86efac", font: "11px monospace" });
      }
    }
  }

  // 6. Requirements
  const reqs = [];
  if (type.req_level && type.req_level > 1) {
    reqs.push(`Level ${type.req_level}`);
  }
  for (const s of ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"]) {
    const rVal = type[`req_${s}`];
    if (rVal && rVal > 0) {
      reqs.push(`${rVal} ${STAT_ABBR[s] || s.toUpperCase()}`);
    }
  }
  if (reqs.length > 0) {
    lines.push({
      text: `Requires: ${reqs.join(", ")}`,
      color: "#94a3b8",
      font: "10px monospace",
    });
  }

  // 7. Soulbound
  if (item && item.soulbound) {
    lines.push({ text: "Soulbound", color: "#a78bfa", font: "10px monospace" });
  }

  return lines;
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
  if (playerImage) {
    ctx.drawImage(playerImage, p.x + 8, p.y + 8, p.w - 16, p.h - 16);
  } else {
    // The sprite sheet loads asynchronously and can also fail outright
    // (ImageManager.get returns null in both cases). An empty frame reads as a
    // broken panel, so the box says "no portrait yet" rather than nothing.
    ctx.fillStyle = "#4b5563";
    ctx.font = "48px monospace";
    ctx.fillText("?", p.x + p.w / 2 - 14, p.y + p.h / 2 - 26);
  }

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

  // Grid, or the Character pane in its place (SOMET-483). `layout.character`
  // is non-null only on the Character tab, and on that tab `layout.cells` is
  // already all empty and both page arrows are already null -- the branch is
  // here so a reader does not have to derive that, not because the loops
  // would misbehave.
  if (layout.character) {
    drawCharacterTab(ctx, layout.character);
  } else {
    // Grid.
    for (const c of layout.cells) {
      const dragged = drag && c.item && drag.itemId === c.item.id;
      ctx.fillStyle = c.item ? (CATEGORY_TINT[c.type && c.type.category] || "rgba(55,55,70,0.9)") : "rgba(25,25,38,0.9)";
      ctx.globalAlpha = dragged ? 0.3 : 1;
      ctx.fillRect(c.x, c.y, c.w, c.h);
      // SOMET-490: a graded item's cell is bordered in its rarity colour.
      // SOMET-500/502 moved that one line into systems/itemDisplay.js so the
      // merchant's buyback shelf and the account chest resolve a grade the same
      // way this grid does -- their third acceptance criterion is literally
      // "the colour matches what the same instance shows in the inventory
      // grid", and two implementations is how that stops being true.
      //
      // Selection still wins -- the player needs to know what they clicked more
      // than they need to be re-told the grade -- and a white/absent grade
      // keeps the original neutral border, so a pre-rarity item looks exactly
      // as it did.
      ctx.strokeStyle = c.selected
        ? "#4a9eff"
        : rarityBorderColor(c.item ? c.item.rarity : null, "#2a2a3a");
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
  }

  // Footer.
  const f = layout.footer;
  if (f.drop) {
    ctx.fillStyle = "rgba(120,40,40,0.85)";
    ctx.fillRect(f.drop.x, f.drop.y, f.drop.w, f.drop.h);
    ctx.strokeStyle = "#ef4444";
    ctx.strokeRect(f.drop.x, f.drop.y, f.drop.w, f.drop.h);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText("Drop selected", f.drop.x + 8, f.drop.y + 7);
  }
  ctx.fillStyle = "#fde68a";
  ctx.fillText(`Gold: ${f.gold ?? 0}`, layout.panel.x + layout.panel.w - 200, f.y + 7);

  // Tooltip last, so nothing paints over it. Suppressed mid-drag: the ghost is
  // already following the cursor and two floating boxes read as a glitch.
  if (!drag && hoverX != null && hoverY != null) {
    let hoveredItem = null;
    let hoveredType = null;

    const cell = layout.cells.find((c) => c.item && inside(c, hoverX, hoverY));
    if (cell) {
      hoveredItem = cell.item;
      hoveredType = cell.type;
    } else {
      const slot = layout.slots.find((s) => s.equippedType && inside(s, hoverX, hoverY));
      if (slot) {
        hoveredItem = slot.equippedItem;
        hoveredType = slot.equippedType;
      }
    }

    if (hoveredType) {
      const lines = formatItemTooltipLines(hoveredItem, hoveredType);
      if (lines.length > 0) {
        let maxW = 120;
        for (const line of lines) {
          ctx.font = line.font || "11px monospace";
          const w = ctx.measureText(line.text).width;
          if (w > maxW) maxW = w;
        }
        const boxW = Math.max(160, Math.ceil(maxW) + 20);
        const lineH = 15;
        const padV = 8;
        const boxH = padV * 2 + lines.length * lineH;

        // Clamped to the canvas:
        const tx = Math.min(Math.max(4, hoverX + 12), GAME_WIDTH - boxW - 4);
        const ty = Math.min(Math.max(4, hoverY + 12), GAME_HEIGHT - boxH - 4);

        ctx.fillStyle = "rgba(10,10,18,0.96)";
        ctx.fillRect(tx, ty, boxW, boxH);
        ctx.strokeStyle = rarityBorderColor(hoveredItem ? hoveredItem.rarity : null, "#4a9eff");
        ctx.lineWidth = 1.5;
        ctx.strokeRect(tx, ty, boxW, boxH);

        let curY = ty + padV;
        for (const line of lines) {
          ctx.font = line.font || "11px monospace";
          ctx.fillStyle = line.color || "#e5e7eb";
          ctx.fillText(line.text, tx + 10, curY);
          curY += lineH;
        }
      }
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
