// Layout and drawing for the player-to-player trade window, which sits at the
// paired-window position beside the full inventory (the Account Chest's slot).
// layoutTradeWindow is pure geometry and hit areas; drawTradeWindow paints exactly
// what it returns and decides nothing. Game turns the hit areas into frames and
// the server is the authority on every rule.
//
// Frame shapes: see the "final frame shapes" of the trade work (tradeState,
// tradeEnded). `trade` here is the last tradeState with `receivedAtMs` added by
// Game, which is what makes `confirmOpensInMs` a deadline instead of a number.

import { CELL, GUTTER, PANEL_H, drawItemCell } from "./inventoryPanel.js";
import { clipToWidth } from "./itemDisplay.js";
import { WINDOW_W, WINDOW_X, WINDOW_Y } from "./storageWindows.js";
import { t } from "../i18n/i18n.js";

export const TRADE_CELLS = 16;
const COLS = 8;
const PAD = 14;
const TITLE_H = 30;
const GREEN = "#4ade80";
const AMBER = "#caa24a";

const HEAD_H = 14;
const THEIR_HEAD_Y = 40;
const THEIR_GRID_Y = 58;
const THEIR_GOLD_Y = 158;
const MY_HEAD_Y = 190;
const MY_GRID_Y = 208;
const GOLD_Y = 312;
const GOLD_H = 26;
const GOLD_LABEL_W = 96;
const STATUS_Y = 352;
const BTN_Y = 420;
const BTN_H = 40;
const BTN_W = (WINDOW_W - 2 * PAD - 8) / 2;

// Every string the window can show that is not built from a name, so a test can
// hold the Ukrainian dictionary to it.
export const TRADE_STRINGS = [
  "Trade with {name}", "Offer from {name}", "Your offer", "Your gold", "Gold: {n}", "OK", "Confirm",
  "Waiting for {name}", "Completing the trade...", "Abort", "Editing", "Locked", "Confirmed",
  "Drag items from your bag to offer them", "Locked. Waiting for {name}.", "Both locked. Review, then confirm.",
  "Trade complete",
];

// Every plain message the server can end a trade with or refuse a frame with (see
// tradeHandlers.js and tradeSettlement.js). They reach t() as sent; the ones that
// carry a name are in NAMED_REASONS.
export const TRADE_MESSAGES = [
  "you cancelled the trade", "you left", "you died", "you moved too far apart", "trade declined",
  "invite expired", "invite cancelled", "trade failed", "a player is no longer available", "invalid gold",
  "not enough gold",
  "finish the trade first", "that player cannot trade right now", "you are already trading", "player is busy",
  "too fast", "cannot trade with yourself", "no invite", "not trading", "already locked", "settling",
  "not ready", "too soon", "already confirmed", "nothing to trade", "trade is full", "item not offered",
  "invalid item", "you do not own that item", "unequip it first", "stones cannot be traded",
  "unsocket the stone first", "starting gear cannot be traded", "currency cannot be traded",
];

// Reasons the server sends with a name already filled in. Matched by shape and
// translated through the template; the plain ones go straight through t().
export const NAMED_REASON_TEMPLATES = [
  "{name} cancelled the trade", "{name} no longer has an offered item", "{name} cannot hold that much gold",
  "{name} is no longer available", "{name} has no room", "{name} left", "{name} died",
];
const NAMED_REASONS = [
  [/^(.+) cancelled the trade$/, "{name} cancelled the trade"],
  [/^(.+) no longer has an offered item$/, "{name} no longer has an offered item"],
  [/^(.+) cannot hold that much gold$/, "{name} cannot hold that much gold"],
  [/^(.+) is no longer available$/, "{name} is no longer available"],
  [/^(.+) has no room$/, "{name} has no room"],
  [/^(.+) left$/, "{name} left"],
  [/^(.+) died$/, "{name} died"],
];

export function tradeReasonText(reason) {
  if (reason == null || reason === "") return null;
  const text = String(reason);
  // "you left" also has the shape of "{name} left": the plain messages win.
  if (TRADE_MESSAGES.includes(text)) return t(text);
  for (const [re, key] of NAMED_REASONS) {
    const m = re.exec(text);
    if (m) return t(key, { name: m[1] });
  }
  return t(text);
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const nameOf = (trade) => (trade && trade.partnerName != null ? String(trade.partnerName) : "");
const sideOf = (s) => ({
  items: s && Array.isArray(s.items) ? s.items.filter((i) => i && i.id != null) : [],
  gold: Math.max(0, Math.floor(num(s && s.gold))),
  locked: !!(s && s.locked),
  confirmed: !!(s && s.confirmed),
});

// -> { label, enabled }. One button walks OK -> Waiting -> Confirm -> Waiting.
export function tradeButtonState(trade, nowMs) {
  const name = nameOf(trade);
  const waiting = { label: t("Waiting for {name}", { name }), enabled: false };
  if (!trade) return waiting;
  const mine = sideOf(trade.mine);
  if (trade.phase === "settling") return { label: t("Completing the trade..."), enabled: false };
  if (trade.phase === "both_locked") {
    if (mine.confirmed) return waiting;
    const left = Number(trade.confirmOpensInMs);
    const at = Number(trade.receivedAtMs);
    // A timer that is absent or not a number is "already open": the server refuses
    // a too-early Confirm anyway, and a button stuck disabled strands the player.
    const opensAt = Number.isFinite(left) && left > 0 ? (Number.isFinite(at) ? at : num(nowMs)) + left : 0;
    return { label: t("Confirm"), enabled: num(nowMs) >= opensAt };
  }
  if (mine.locked) return waiting;
  return { label: t("OK"), enabled: true };
}

function sideStatus(side) {
  if (side.confirmed) return t("Confirmed");
  if (side.locked) return t("Locked");
  return t("Editing");
}

function cellRect(gridTop, i) {
  return {
    x: WINDOW_X + PAD + (i % COLS) * (CELL + GUTTER),
    y: gridTop + Math.floor(i / COLS) * (CELL + GUTTER),
    w: CELL, h: CELL,
  };
}

function stash(gridTop, items, types) {
  const typeMap = types || new Map();
  const cells = Array.from({ length: TRADE_CELLS }, (_, i) => ({ ...cellRect(gridTop, i), item: null, type: null }));
  items.slice(0, TRADE_CELLS).forEach((row, i) => {
    cells[i].item = { ...row };
    // The partner's type rides the frame; the viewer's own catalogue is the fallback.
    cells[i].type = row.type || typeMap.get(row.typeId) || null;
  });
  return cells;
}

export function layoutTradeWindow({ trade, types, goldField = null, nowMs = 0, theirFlashUntilMs = 0 }) {
  const name = nameOf(trade);
  const mine = sideOf(trade && trade.mine);
  const theirs = sideOf(trade && trade.theirs);
  const settling = !!trade && trade.phase === "settling";
  const panel = { x: WINDOW_X, y: WINDOW_Y, w: WINDOW_W, h: PANEL_H };
  const title = { x: WINDOW_X, y: WINDOW_Y, w: WINDOW_W, h: TITLE_H };
  const close = { x: WINDOW_X + WINDOW_W - 8 - 20, y: WINDOW_Y + 5, w: 20, h: 20 };
  const hitAreas = [{ ...close, kind: "winclose", id: null }];

  const theirCells = stash(WINDOW_Y + THEIR_GRID_Y, theirs.items, types);
  const myCells = stash(WINDOW_Y + MY_GRID_Y, mine.items, types);
  // Only my own unlocked cells can be dragged; a partner's item is read-only.
  if (!mine.locked && !settling) {
    for (const c of myCells) {
      if (c.item) hitAreas.push({ x: c.x, y: c.y, w: c.w, h: c.h, kind: "tradeitem", id: c.item.id, typeId: c.item.typeId });
    }
  }

  const goldRect = { x: WINDOW_X + PAD + GOLD_LABEL_W, y: WINDOW_Y + GOLD_Y, w: 170, h: GOLD_H };
  if (!mine.locked && !settling) hitAreas.push({ ...goldRect, kind: "tradegold", id: null });

  const okButton = { x: WINDOW_X + PAD, y: WINDOW_Y + BTN_Y, w: BTN_W, h: BTN_H };
  const abortButton = { x: WINDOW_X + PAD + BTN_W + 8, y: WINDOW_Y + BTN_Y, w: BTN_W, h: BTN_H };
  const button = tradeButtonState(trade, nowMs);
  hitAreas.push({ ...okButton, kind: "tradeok", id: null, enabled: button.enabled });
  // Settling is committed; the server refuses an abort, so the button is inert.
  if (!settling) hitAreas.push({ ...abortButton, kind: "tradeabort", id: null });

  const typed = goldField && goldField.focused ? String(goldField.text == null ? "" : goldField.text) : null;
  const status = settling ? t("Completing the trade...")
    : trade && trade.phase === "both_locked" ? t("Both locked. Review, then confirm.")
    : mine.locked ? t("Locked. Waiting for {name}.", { name })
    : t("Drag items from your bag to offer them");

  return {
    kind: "trade",
    panel, title, close,
    titleText: t("Trade with {name}", { name }),
    partnerName: name,
    theirHead: { x: WINDOW_X + PAD, y: WINDOW_Y + THEIR_HEAD_Y, w: WINDOW_W - 2 * PAD, h: HEAD_H },
    myHead: { x: WINDOW_X + PAD, y: WINDOW_Y + MY_HEAD_Y, w: WINDOW_W - 2 * PAD, h: HEAD_H },
    theirGoldPos: { x: WINDOW_X + PAD, y: WINDOW_Y + THEIR_GOLD_Y },
    goldLabelPos: { x: WINDOW_X + PAD, y: WINDOW_Y + GOLD_Y + 6 },
    statusPos: { x: WINDOW_X + PAD, y: WINDOW_Y + STATUS_Y },
    theirCells, myCells,
    cells: [...theirCells, ...myCells],
    theirGold: theirs.gold,
    myGold: mine.gold,
    goldRect,
    goldText: typed != null ? typed : String(mine.gold),
    goldFocused: typed != null,
    okButton, abortButton, button,
    abortEnabled: !settling,
    status,
    theirStatus: sideStatus(theirs),
    myStatus: sideStatus(mine),
    theirLocked: theirs.locked,
    myLocked: mine.locked,
    settling,
    theirFlash: num(theirFlashUntilMs) > num(nowMs),
    // The ids on my side, so a drop of something already offered is not offered twice.
    offeredIds: mine.items.map((i) => i.id),
    hitAreas,
  };
}

// ---------------------------------------------------------------- drawing

function drawStash(ctx, cells, art, { locked, flash, enchantCfg, drag }) {
  for (const c of cells) {
    const dimmed = !!(drag && drag.from && drag.from.kind === "tradeitem" && c.item && drag.from.id === c.item.id);
    drawItemCell(ctx, c, art, { dimmed, enchantCfg });
  }
  const first = cells[0];
  const last = cells[cells.length - 1];
  const box = { x: first.x - 3, y: first.y - 3, w: last.x + last.w - first.x + 6, h: last.y + last.h - first.y + 6 };
  if (flash) {
    ctx.fillStyle = "rgba(253,230,138,0.18)";
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  ctx.strokeStyle = locked ? GREEN : "#3a3a4e";
  ctx.lineWidth = locked ? 2 : 1;
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.lineWidth = 1;
}

function drawHead(ctx, rect, left, right, color) {
  ctx.font = "12px monospace";
  const rightText = clipToWidth(right, 100, 12);
  const rightW = rightText.length * 12 * 0.6;
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText(clipToWidth(left, rect.w - rightW - 10, 12), rect.x, rect.y);
  ctx.fillStyle = color;
  ctx.textAlign = "right";
  ctx.fillText(rightText, rect.x + rect.w, rect.y);
  ctx.textAlign = "left";
}

function statusColor(locked, status, confirmedWord) {
  if (status === confirmedWord) return GREEN;
  return locked ? GREEN : AMBER;
}

function drawButton(ctx, rect, label, enabled, accent) {
  ctx.fillStyle = enabled ? "rgba(40,60,50,0.95)" : "rgba(30,30,40,0.9)";
  if (accent === "danger") ctx.fillStyle = "rgba(90,35,35,0.9)";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = accent === "danger" ? "#b04040" : enabled ? GREEN : "#3a3a4e";
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.font = "14px monospace";
  ctx.fillStyle = enabled || accent === "danger" ? "#e5e7eb" : "#6b7280";
  const text = clipToWidth(label, rect.w - 16, 14);
  ctx.textAlign = "center";
  ctx.fillText(text, rect.x + rect.w / 2, rect.y + (rect.h - 14) / 2);
  ctx.textAlign = "left";
}

// `state`: { drag, enchantCfg, blink } -- blink alternates the field's caret.
export function drawTradeWindow(ctx, layout, state, art = null) {
  const { drag = null, enchantCfg = null, blink = true } = state || {};
  const { panel, title, close } = layout;

  ctx.save();
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(12,12,20,0.94)";
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  ctx.strokeStyle = "#3a3a4e";
  ctx.lineWidth = 2;
  ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);
  ctx.lineWidth = 1;

  ctx.fillStyle = "rgba(30,30,45,0.95)";
  ctx.fillRect(title.x, title.y, title.w, title.h);
  ctx.font = "14px monospace";
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText(clipToWidth(layout.titleText, close.x - title.x - 24, 14), title.x + 12, title.y + 8);
  ctx.fillStyle = "rgba(120,40,40,0.9)";
  ctx.fillRect(close.x, close.y, close.w, close.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText("X", close.x + 6, close.y + 3);

  drawHead(ctx, layout.theirHead, t("Offer from {name}", { name: layout.partnerName }), layout.theirStatus,
    statusColor(layout.theirLocked, layout.theirStatus, t("Confirmed")));
  drawStash(ctx, layout.theirCells, art, { locked: layout.theirLocked, flash: layout.theirFlash, enchantCfg, drag: null });
  ctx.font = "12px monospace";
  ctx.fillStyle = "#fde68a";
  ctx.fillText(clipToWidth(t("Gold: {n}", { n: layout.theirGold }), panel.w - 2 * PAD, 12), layout.theirGoldPos.x, layout.theirGoldPos.y);

  ctx.strokeStyle = "#2a2a3a";
  ctx.beginPath();
  ctx.moveTo(panel.x + PAD, layout.myHead.y - 8);
  ctx.lineTo(panel.x + panel.w - PAD, layout.myHead.y - 8);
  ctx.stroke();

  drawHead(ctx, layout.myHead, t("Your offer"), layout.myStatus,
    statusColor(layout.myLocked, layout.myStatus, t("Confirmed")));
  drawStash(ctx, layout.myCells, art, { locked: layout.myLocked, flash: false, enchantCfg, drag });

  ctx.font = "12px monospace";
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText(clipToWidth(t("Your gold"), GOLD_LABEL_W - 6, 12), layout.goldLabelPos.x, layout.goldLabelPos.y);
  const g = layout.goldRect;
  ctx.fillStyle = layout.myLocked ? "rgba(25,25,38,0.9)" : "rgba(20,20,32,0.95)";
  ctx.fillRect(g.x, g.y, g.w, g.h);
  ctx.strokeStyle = layout.goldFocused ? "#4a9eff" : "#3a3a4e";
  ctx.strokeRect(g.x, g.y, g.w, g.h);
  ctx.fillStyle = "#fde68a";
  ctx.font = "14px monospace";
  const shown = clipToWidth(layout.goldText + (layout.goldFocused && blink ? "|" : ""), g.w - 12, 14);
  ctx.fillText(shown, g.x + 6, g.y + 6);

  ctx.font = "12px monospace";
  ctx.fillStyle = "#9ca3af";
  ctx.fillText(clipToWidth(layout.status, panel.w - 2 * PAD, 12), layout.statusPos.x, layout.statusPos.y);

  drawButton(ctx, layout.okButton, layout.button.label, layout.button.enabled, null);
  drawButton(ctx, layout.abortButton, t("Abort"), layout.abortEnabled, layout.abortEnabled ? "danger" : null);
  ctx.restore();
}
