// frontend/src/games/something2/src/js/systems/lootFilterPanel.js
//
// Pure layout and Canvas 2D renderer for the Loot Filter window (hotkey 'L'). Same shape as the
// other panels: layoutLootFilterPanel() returns the geometry AND the hit areas, the game maps a
// click on a hit area to an edit (core/lootFilterUi.js), drawLootFilterPanel() paints the layout.
//
// Everything is clickable (no hex typing on a canvas): colours are a swatch palette, numbers are
// steppers, and long lists (base items, affixes) are a searchable picker with a text field.

import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";
import { t as tr } from "../i18n/i18n.js";
import { activePreset, RARITIES } from "../core/lootFilter.js";
import { PALETTE, DEFAULT_FONT } from "../core/lootFilterEditor.js";
import { RARITY_COLORS } from "../core/rarityColors.js";

export const LF_W = 1040;
export const LF_H = 620;
const TITLE_H = 40;
const PAD = 12;
const LEFT_W = 300;
const ROW_H = 34;
const ROW_GAP = 4;
const CHIP_H = 24;
const SW = 22;            // colour swatch size
export const PICK_ROW_H = 24;

export const CATEGORIES = ["weapon", "armor", "consumable", "stone", "currency"];
export const ACTION_COLORS = { hide: "#ef4444", show: "#4ade80", emphasize: "#facc15" };
const ACTION_LABELS = { hide: "Hide", show: "Show", emphasize: "Emphasize" };

const CHAR_W = 6.6; // 11px monospace advance, close enough to size a chip without a context

function textW(s) { return String(s).length * CHAR_W; }

function btn(hitAreas, rect, extra) {
  const b = { ...rect, ...extra };
  hitAreas.push(b);
  return b;
}

// The name a base item / affix is shown under.
export function typeLabel(types, id) {
  const ty = types && types.get ? types.get(id) : null;
  return ty ? tr(ty.name) : `#${id}`;
}
export function affixLabel(affixes, id) {
  const a = (affixes || []).find((x) => x.id === id);
  return a ? tr(a.label || a.key) : `#${id}`;
}

// Entries the picker lists, filtered by its search text (and, for base items, by the rule's chosen
// categories so a "weapon" rule does not offer armour).
export function pickerEntries(kind, { types, affixes, rule, query }) {
  const q = String(query || "").trim().toLowerCase();
  let out = [];
  if (kind === "type") {
    const cats = rule && rule.conditions.categories.length ? rule.conditions.categories : null;
    for (const ty of (types ? types.values() : [])) {
      if (ty.category === "currency") continue;
      if (cats && !cats.includes(ty.category)) continue;
      out.push({ id: ty.id, label: tr(ty.name) });
    }
  } else {
    out = (affixes || []).map((a) => ({ id: a.id, label: tr(a.label || a.key) }));
  }
  if (q) out = out.filter((e) => e.label.toLowerCase().includes(q));
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function layoutLootFilterPanel(state = {}) {
  const { config, ui = {}, types = null, affixes = [] } = state;
  const px = Math.floor((GAME_WIDTH - LF_W) / 2);
  const py = Math.floor((GAME_HEIGHT - LF_H) / 2);
  const panel = { x: px, y: py, w: LF_W, h: LF_H };
  const hit = [];
  const preset = activePreset(config);
  const rules = preset ? preset.rules : [];
  const selected = rules.find((r) => r.id === ui.ruleId) || null;

  btn(hit, { x: px + LF_W - 32, y: py + 8, w: 24, h: 24 }, { kind: "lfclose" });

  // ---- preset bar -----------------------------------------------------------------------------
  const barY = py + TITLE_H + 8;
  const bar = { x: px + PAD, y: barY, w: LF_W - PAD * 2, h: 28 };
  let bx = bar.x;
  const prev = btn(hit, { x: bx, y: barY, w: 28, h: 28 }, { kind: "lfpreset", dir: -1, label: "◀" });
  bx += 32;
  const presetName = { x: bx, y: barY, w: 230, h: 28, text: ui.focus === "preset" ? (ui.draft || "") : (preset ? preset.name : ""), editing: ui.focus === "preset" };
  btn(hit, presetName, { kind: "lfpreset-rename" });
  bx += 234;
  const next = btn(hit, { x: bx, y: barY, w: 28, h: 28 }, { kind: "lfpreset", dir: 1, label: "▶" });
  bx += 36;
  const presetButtons = [];
  for (const [kind, label, w] of [["lfpreset-copy", tr("Copy"), 60], ["lfpreset-del", tr("Delete"), 70], ["lfpreset-starter", tr("Starter"), 74]]) {
    presetButtons.push(btn(hit, { x: bx, y: barY, w, h: 28 }, { kind, label }));
    bx += w + 6;
  }
  const autoloot = btn(hit, { x: bar.x + bar.w - 250, y: barY, w: 250, h: 28 }, {
    kind: "lfautoloot", label: tr("Auto-loot skips hidden"), on: !!(preset && preset.autolootSkipHidden),
  });

  // ---- rule list (left) -----------------------------------------------------------------------
  const bodyY = barY + 28 + 12;
  const bodyH = py + LF_H - PAD - bodyY;
  const listHeader = { x: px + PAD, y: bodyY, w: LEFT_W, h: 18, text: tr("Rules — the top one that matches wins") };
  const addBtn = btn(hit, { x: px + PAD, y: py + LF_H - PAD - 30, w: LEFT_W, h: 30 }, { kind: "lfrule-add", label: tr("+ New rule") });
  const listArea = { x: px + PAD, y: bodyY + 22, w: LEFT_W, h: addBtn.y - 6 - (bodyY + 22) };
  const totalH = rules.length ? rules.length * (ROW_H + ROW_GAP) - ROW_GAP : 0;
  const maxScroll = Math.max(0, totalH - listArea.h);
  const scrollY = Math.max(0, Math.min(maxScroll, Number(ui.scroll) || 0));
  const ruleRows = [];
  rules.forEach((rule, i) => {
    const y = listArea.y + i * (ROW_H + ROW_GAP) - scrollY;
    if (y + ROW_H < listArea.y || y > listArea.y + listArea.h) return;
    const row = { x: listArea.x, y, w: listArea.w - 8, h: ROW_H, rule, selected: !!selected && selected.id === rule.id, index: i };
    ruleRows.push(row);
    // Hit areas are clipped to the visible list so a half-hidden row cannot be hit outside it.
    const cy = Math.max(y, listArea.y);
    const ch = Math.min(y + ROW_H, listArea.y + listArea.h) - cy;
    if (ch <= 0) return;
    const clip = (r) => ({ ...r, y: Math.max(r.y, cy), h: Math.min(r.y + r.h, cy + ch) - Math.max(r.y, cy) });
    hit.push({ ...clip(row), kind: "lfrule-select", id: rule.id });
    row.toggle = { x: row.x + 6, y: y + 8, w: 18, h: 18 };
    row.up = { x: row.x + row.w - 70, y: y + 7, w: 20, h: 20 };
    row.down = { x: row.x + row.w - 48, y: y + 7, w: 20, h: 20 };
    row.del = { x: row.x + row.w - 26, y: y + 7, w: 20, h: 20 };
    for (const [k, r] of [["lfrule-toggle", row.toggle], ["lfrule-up", row.up], ["lfrule-down", row.down], ["lfrule-del", row.del]]) {
      if (r.y >= cy && r.y + r.h <= cy + ch) hit.push({ ...r, kind: k, id: rule.id });
    }
  });

  // ---- editor (right) -------------------------------------------------------------------------
  const ex = px + PAD + LEFT_W + 16;
  const ew = px + LF_W - PAD - ex;
  const editor = { x: ex, y: bodyY, w: ew, h: bodyH };
  const fields = [];
  let picker = null;

  if (selected) {
    const c = selected.conditions;
    const s = selected.style;
    const labelW = 96;
    const cx = ex + labelW;
    let y = bodyY;
    const label = (text, yy) => fields.push({ type: "label", x: ex, y: yy + 5, text });
    const swatchRow = (yy, kind, current, withNone) => {
      let sx = cx;
      const noneLabel = withNone;
      const cells = [{ color: null, label: noneLabel }, ...PALETTE.map((p) => ({ color: p, label: "" }))];
      for (const cell of cells) {
        const rect = { x: sx, y: yy + 1, w: SW, h: SW };
        fields.push({ type: "swatch", ...rect, color: cell.color, label: cell.label, selected: (current || null) === cell.color });
        btn(hit, rect, { kind, color: cell.color });
        sx += SW + 4;
      }
    };

    // Name + action
    const nameRect = { x: cx, y, w: 250, h: CHIP_H + 2 };
    fields.push({ type: "name", ...nameRect, text: ui.focus === "rule" ? (ui.draft || "") : selected.name, editing: ui.focus === "rule" });
    btn(hit, nameRect, { kind: "lfrule-rename" });
    label(tr("Rule"), y);
    let ax = cx + 262;
    for (const a of ["hide", "show", "emphasize"]) {
      const rect = { x: ax, y, w: 96, h: CHIP_H + 2 };
      fields.push({ type: "chip", ...rect, text: tr(ACTION_LABELS[a]), selected: selected.action === a, color: ACTION_COLORS[a] });
      btn(hit, rect, { kind: "lfaction", action: a });
      ax += 102;
    }
    y += 40;

    // Rarity
    label(tr("Rarity"), y);
    let rx = cx;
    for (const r of RARITIES) {
      const rect = { x: rx, y, w: 92, h: CHIP_H };
      fields.push({ type: "chip", ...rect, text: tr(r === "foxy" ? "unique" : r), selected: c.rarities.includes(r), color: RARITY_COLORS[r] });
      btn(hit, rect, { kind: "lfrarity", rarity: r });
      rx += 98;
    }
    fields.push({ type: "hint", x: rx + 6, y: y + 6, text: c.rarities.length ? "" : tr("any rarity") });
    y += 34;

    // Category
    label(tr("Type"), y);
    let kx = cx;
    for (const cat of CATEGORIES) {
      const rect = { x: kx, y, w: 96, h: CHIP_H };
      fields.push({ type: "chip", ...rect, text: tr(cat), selected: c.categories.includes(cat), color: "#94a3b8" });
      btn(hit, rect, { kind: "lfcat", category: cat });
      kx += 102;
    }
    y += 34;

    // Base items
    label(tr("Base item"), y);
    let bx2 = cx;
    const shownTypes = c.typeIds.slice(0, 4);
    for (const id of shownTypes) {
      const text = typeLabel(types, id);
      const w = Math.min(150, textW(text) + 34);
      const rect = { x: bx2, y, w, h: CHIP_H };
      fields.push({ type: "chip", ...rect, text: `${text} ✕`, selected: true, color: "#94a3b8" });
      btn(hit, rect, { kind: "lfchip-remove", what: "type", id });
      bx2 += w + 6;
    }
    if (c.typeIds.length > shownTypes.length) {
      fields.push({ type: "hint", x: bx2, y: y + 6, text: `+${c.typeIds.length - shownTypes.length}` });
      bx2 += 34;
    }
    const pickType = { x: bx2, y, w: 110, h: CHIP_H };
    fields.push({ type: "chip", ...pickType, text: tr("+ Pick base"), selected: ui.picker === "type", color: "#38bdf8" });
    btn(hit, pickType, { kind: "lfpick-open", pick: "type" });
    if (!c.typeIds.length) fields.push({ type: "hint", x: pickType.x + 120, y: y + 6, text: tr("any base") });
    y += 34;

    // Level
    label(tr("Item level"), y);
    let lx = cx;
    for (const which of ["minLevel", "maxLevel"]) {
      fields.push({ type: "hint", x: lx, y: y + 6, text: which === "minLevel" ? tr("from") : tr("to") });
      lx += 40;
      for (const [d, text] of [[-10, "«"], [-1, "‹"]]) {
        const rect = { x: lx, y, w: 24, h: CHIP_H };
        fields.push({ type: "chip", ...rect, text, selected: false, color: "#94a3b8" });
        btn(hit, rect, { kind: "lflevel", which, delta: d });
        lx += 28;
      }
      const v = c[which];
      fields.push({ type: "value", x: lx, y, w: 46, h: CHIP_H, text: v === null || v === undefined ? tr("any") : String(v) });
      lx += 50;
      for (const [d, text] of [[1, "›"], [10, "»"]]) {
        const rect = { x: lx, y, w: 24, h: CHIP_H };
        fields.push({ type: "chip", ...rect, text, selected: false, color: "#94a3b8" });
        btn(hit, rect, { kind: "lflevel", which, delta: d });
        lx += 28;
      }
      lx += 20;
    }
    y += 34;

    // Affixes
    label(tr("Affix"), y);
    let fx = cx;
    for (const mode of ["any", "all"]) {
      const rect = { x: fx, y, w: 44, h: CHIP_H };
      fields.push({ type: "chip", ...rect, text: tr(mode), selected: c.affixMode === mode, color: "#94a3b8" });
      btn(hit, rect, { kind: "lfaffixmode", mode });
      fx += 48;
    }
    fx += 6;
    const shownAffixes = c.affixIds.slice(0, 3);
    for (const id of shownAffixes) {
      const text = affixLabel(affixes, id);
      const w = Math.min(130, textW(text) + 34);
      const rect = { x: fx, y, w, h: CHIP_H };
      fields.push({ type: "chip", ...rect, text: `${text} ✕`, selected: true, color: "#c084fc" });
      btn(hit, rect, { kind: "lfchip-remove", what: "affix", id });
      fx += w + 6;
    }
    if (c.affixIds.length > shownAffixes.length) {
      fields.push({ type: "hint", x: fx, y: y + 6, text: `+${c.affixIds.length - shownAffixes.length}` });
      fx += 34;
    }
    const pickAffix = { x: fx, y, w: 110, h: CHIP_H };
    fields.push({ type: "chip", ...pickAffix, text: tr("+ Pick affix"), selected: ui.picker === "affix", color: "#38bdf8" });
    btn(hit, pickAffix, { kind: "lfpick-open", pick: "affix" });
    y += 40;

    // Style
    label(tr("Text colour"), y);
    swatchRow(y, "lftextcolor", s.textColor, tr("auto"));
    y += 30;
    label(tr("Plate colour"), y);
    swatchRow(y, "lfbgcolor", s.bgColor, tr("none"));
    y += 30;
    label(tr("Font size"), y);
    let sx = cx;
    for (const [d, text] of [[-1, "−"], [1, "+"]]) {
      const rect = { x: sx + (d > 0 ? 80 : 0), y, w: 28, h: CHIP_H };
      fields.push({ type: "chip", ...rect, text, selected: false, color: "#94a3b8" });
      btn(hit, rect, { kind: "lffont", delta: d });
    }
    fields.push({ type: "value", x: sx + 30, y, w: 48, h: CHIP_H, text: s.fontSize ? `${s.fontSize}px` : tr("auto") });
    const beamRect = { x: cx + 130, y, w: 110, h: CHIP_H };
    fields.push({ type: "chip", ...beamRect, text: s.beam ? tr("Beam: on") : tr("Beam: off"), selected: !!s.beam, color: "#facc15" });
    btn(hit, beamRect, { kind: "lfbeam" });
    y += 30;
    label(tr("Beam colour"), y);
    swatchRow(y, "lfbeamcolor", s.beamColor, tr("auto"));
    y += 34;

    // Preview
    const prevRect = { x: ex, y, w: ew, h: Math.max(60, bodyY + bodyH - y) };
    fields.push({ type: "preview", ...prevRect, rule: selected });

    // The picker covers everything below the name/action row.
    if (ui.picker === "type" || ui.picker === "affix") {
      const top = bodyY + 40;
      const area = { x: ex, y: top, w: ew, h: bodyY + bodyH - top };
      const entries = pickerEntries(ui.picker, { types, affixes, rule: selected, query: ui.query });
      const list = { x: area.x + 8, y: area.y + 44, w: area.w - 16, h: area.h - 44 - 40 };
      const cols = 2;
      const colW = Math.floor(list.w / cols) - 4;
      const rowsCount = Math.ceil(entries.length / cols);
      const pTotal = rowsCount * PICK_ROW_H;
      const pMax = Math.max(0, pTotal - list.h);
      const pScroll = Math.max(0, Math.min(pMax, Number(ui.pickScroll) || 0));
      const chosen = ui.picker === "type" ? c.typeIds : c.affixIds;
      const items = [];
      entries.forEach((e, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const rect = { x: list.x + col * (colW + 8), y: list.y + row * PICK_ROW_H - pScroll, w: colW, h: PICK_ROW_H - 2 };
        if (rect.y + rect.h < list.y || rect.y > list.y + list.h) return;
        items.push({ ...rect, text: e.label, selected: chosen.includes(e.id), id: e.id });
        const cy = Math.max(rect.y, list.y);
        const ch = Math.min(rect.y + rect.h, list.y + list.h) - cy;
        if (ch > 0) hit.push({ ...rect, y: cy, h: ch, kind: "lfpick-item", pick: ui.picker, id: e.id });
      });
      const search = { x: area.x + 8, y: area.y + 8, w: 320, h: 28 };
      btn(hit, search, { kind: "lfpick-search" });
      const done = { x: area.x + area.w - 108, y: area.y + 8, w: 100, h: 28 };
      btn(hit, done, { kind: "lfpick-done" });
      picker = { area, search, done, items, list, title: ui.picker === "type" ? tr("Pick base items") : tr("Pick affixes"), query: ui.query || "", focused: ui.focus === "search", count: entries.length, pMax, pScroll, pTotal };
    }
  }

  return {
    panel, hitAreas: hit, preset, bar, prev, next, presetName, presetButtons, autoloot,
    listHeader, listArea, ruleRows, addBtn, totalH, maxScroll, scrollY, editor, fields, picker, selected,
    empty: rules.length === 0, title: tr("Loot Filter"),
  };
}

// ---- drawing ---------------------------------------------------------------------------------

function roundRect(ctx, x, y, w, h, r = 0) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function fit(ctx, text, maxW) {
  const s0 = String(text ?? "");
  if (ctx.measureText(s0).width <= maxW) return s0;
  let s = s0;
  while (s.length > 0 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

function chip(ctx, f) {
  roundRect(ctx, f.x, f.y, f.w, f.h, 6);
  ctx.fillStyle = f.selected ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)";
  ctx.fill();
  ctx.strokeStyle = f.selected ? (f.color || "#facc15") : "#2e2e3e";
  ctx.lineWidth = f.selected ? 1.5 : 1;
  ctx.stroke();
  ctx.fillStyle = f.selected ? (f.color || "#fde047") : "#cbd5e1";
  ctx.font = "11px monospace";
  const t = fit(ctx, f.text, f.w - 8);
  ctx.fillText(t, f.x + (f.w - ctx.measureText(t).width) / 2, f.y + (f.h - 11) / 2 + 1);
}

function swatch(ctx, f) {
  roundRect(ctx, f.x, f.y, f.w, f.h, 4);
  if (f.color) {
    ctx.fillStyle = f.color;
    ctx.fill();
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fill();
    ctx.fillStyle = "#94a3b8";
    ctx.font = "9px monospace";
    const t = fit(ctx, f.label || "", f.w);
    ctx.fillText(t, f.x + (f.w - ctx.measureText(t).width) / 2, f.y + 7);
  }
  ctx.strokeStyle = f.selected ? "#ffffff" : "#2e2e3e";
  ctx.lineWidth = f.selected ? 2 : 1;
  roundRect(ctx, f.x, f.y, f.w, f.h, 4);
  ctx.stroke();
}

function textBox(ctx, f, placeholder) {
  roundRect(ctx, f.x, f.y, f.w, f.h, 6);
  ctx.fillStyle = f.editing ? "rgba(56,189,248,0.12)" : "rgba(255,255,255,0.05)";
  ctx.fill();
  ctx.strokeStyle = f.editing ? "#38bdf8" : "#2e2e3e";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "12px monospace";
  const shown = (f.text || placeholder || "") + (f.editing ? "|" : "");
  ctx.fillText(fit(ctx, shown, f.w - 12), f.x + 8, f.y + (f.h - 12) / 2 + 1);
}

function drawPreview(ctx, f) {
  roundRect(ctx, f.x, f.y, f.w, f.h, 8);
  ctx.fillStyle = "#0f3460";
  ctx.fill();
  ctx.strokeStyle = "#2e2e3e";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#94a3b8";
  ctx.font = "10px monospace";
  ctx.fillText(tr("Preview"), f.x + 8, f.y + 6);
  const rule = f.rule;
  const style = rule.style || {};
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h - 14;
  ctx.save();
  ctx.beginPath();
  ctx.rect(f.x + 1, f.y + 1, f.w - 2, f.h - 2);
  ctx.clip();
  if (rule.action === "hide") {
    ctx.fillStyle = "#64748b";
    ctx.font = "12px monospace";
    const msg = tr("Hidden: these items are not drawn (hold the show-all key to see them)");
    ctx.fillText(fit(ctx, msg, f.w - 24), f.x + 12, f.y + f.h / 2 - 4);
    ctx.restore();
    return;
  }
  const accent = style.beamColor || style.textColor || "#ffffff";
  if (style.beam && /^#[0-9a-f]{6}$/i.test(accent)) {
    const g = ctx.createLinearGradient(cx, cy, cx, f.y + 4);
    g.addColorStop(0, accent + "dd");
    g.addColorStop(1, accent + "00");
    ctx.fillStyle = g;
    ctx.fillRect(cx - 2, f.y + 4, 4, cy - f.y - 4);
  }
  ctx.fillStyle = "#e3c27e";
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 9); ctx.lineTo(cx + 9, cy); ctx.lineTo(cx, cy + 9); ctx.lineTo(cx - 9, cy); ctx.closePath();
  ctx.fill(); ctx.stroke();
  const size = style.fontSize || DEFAULT_FONT - 1;
  ctx.font = `${size}px sans-serif`;
  const label = tr("Sample item");
  const w = ctx.measureText(label).width;
  const ly = cy - 18;
  if (style.bgColor) {
    ctx.fillStyle = style.bgColor;
    ctx.fillRect(cx - w / 2 - 4, ly - size - 2 + 2, w + 8, size + 4);
  }
  ctx.fillStyle = style.textColor || "#ffffff";
  ctx.fillText(label, cx - w / 2, ly);
  ctx.restore();
}

export function drawLootFilterPanel(ctx, L) {
  if (!L) return;
  const { panel } = L;
  ctx.save();
  ctx.textBaseline = "top";

  roundRect(ctx, panel.x, panel.y, panel.w, panel.h, 14);
  ctx.fillStyle = "rgba(15, 15, 26, 0.97)";
  ctx.fill();
  ctx.strokeStyle = "#2e2e3e";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  roundRect(ctx, panel.x, panel.y, panel.w, TITLE_H, [14, 14, 0, 0]);
  ctx.fillStyle = "rgba(22, 22, 38, 0.98)";
  ctx.fill();
  ctx.fillStyle = "#fde047";
  ctx.font = "bold 14px monospace";
  ctx.fillText(`🎒 ${L.title}`, panel.x + 16, panel.y + 11);
  ctx.fillStyle = "#94a3b8";
  ctx.fillText("✕", panel.x + panel.w - 26, panel.y + 13);

  // Preset bar
  for (const b of [L.prev, L.next]) chip(ctx, { ...b, text: b.label, selected: false, color: "#94a3b8" });
  textBox(ctx, { ...L.presetName }, tr("(unnamed)"));
  for (const b of L.presetButtons) chip(ctx, { ...b, text: b.label, selected: false, color: "#94a3b8" });
  chip(ctx, { ...L.autoloot, text: `${L.autoloot.on ? "☑" : "☐"} ${L.autoloot.label}`, selected: L.autoloot.on, color: "#4ade80" });

  // Rule list
  ctx.fillStyle = "#94a3b8";
  ctx.font = "11px monospace";
  ctx.fillText(fit(ctx, L.listHeader.text, L.listHeader.w), L.listHeader.x, L.listHeader.y + 3);
  chip(ctx, { ...L.addBtn, text: L.addBtn.label, selected: false, color: "#4ade80" });

  ctx.save();
  ctx.beginPath();
  ctx.rect(L.listArea.x, L.listArea.y, L.listArea.w, L.listArea.h);
  ctx.clip();
  for (const row of L.ruleRows) {
    const r = row.rule;
    roundRect(ctx, row.x, row.y, row.w, row.h, 8);
    ctx.fillStyle = row.selected ? "rgba(250, 204, 21, 0.14)" : "rgba(255,255,255,0.04)";
    ctx.fill();
    ctx.strokeStyle = row.selected ? "#facc15" : "#2e2e3e";
    ctx.lineWidth = 1;
    ctx.stroke();
    // enable checkbox
    roundRect(ctx, row.toggle.x, row.toggle.y, row.toggle.w, row.toggle.h, 4);
    ctx.strokeStyle = "#94a3b8";
    ctx.stroke();
    if (r.enabled) {
      ctx.fillStyle = "#4ade80";
      ctx.font = "bold 13px monospace";
      ctx.fillText("✓", row.toggle.x + 3, row.toggle.y + 2);
    }
    ctx.globalAlpha = r.enabled ? 1 : 0.45;
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "12px monospace";
    ctx.fillText(fit(ctx, r.name, row.w - 30 - 70 - 64), row.x + 30, row.y + 6);
    ctx.fillStyle = ACTION_COLORS[r.action] || "#94a3b8";
    ctx.font = "10px monospace";
    ctx.fillText(tr(ACTION_LABELS[r.action] || r.action), row.x + 30, row.y + 21);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "bold 12px monospace";
    ctx.fillText("▲", row.up.x + 4, row.up.y + 4);
    ctx.fillText("▼", row.down.x + 4, row.down.y + 4);
    ctx.fillStyle = "#f87171";
    ctx.fillText("✕", row.del.x + 5, row.del.y + 4);
  }
  if (L.empty) {
    ctx.fillStyle = "#64748b";
    ctx.font = "11px monospace";
    ctx.fillText(fit(ctx, tr("No rules yet: everything is shown."), L.listArea.w - 8), L.listArea.x + 6, L.listArea.y + 8);
  }
  ctx.restore();
  if (L.maxScroll > 0) {
    const thumbH = Math.max(24, L.listArea.h * (L.listArea.h / L.totalH));
    const thumbY = L.listArea.y + (L.listArea.h - thumbH) * (L.scrollY / L.maxScroll);
    roundRect(ctx, L.listArea.x + L.listArea.w - 5, thumbY, 4, thumbH, 2);
    ctx.fillStyle = "rgba(148, 163, 184, 0.5)";
    ctx.fill();
  }

  // Editor
  if (!L.selected) {
    ctx.fillStyle = "#64748b";
    ctx.font = "13px monospace";
    ctx.fillText(tr("Select a rule on the left, or add a new one."), L.editor.x + 8, L.editor.y + 8);
  } else {
    for (const f of L.fields) {
      if (f.type === "label") { ctx.fillStyle = "#94a3b8"; ctx.font = "11px monospace"; ctx.fillText(f.text, f.x, f.y); }
      else if (f.type === "hint") { ctx.fillStyle = "#64748b"; ctx.font = "10px monospace"; ctx.fillText(f.text, f.x, f.y); }
      else if (f.type === "chip") chip(ctx, f);
      else if (f.type === "swatch") swatch(ctx, f);
      else if (f.type === "name") textBox(ctx, f, tr("(unnamed)"));
      else if (f.type === "value") {
        ctx.fillStyle = "#e2e8f0"; ctx.font = "12px monospace";
        ctx.fillText(f.text, f.x + (f.w - ctx.measureText(f.text).width) / 2, f.y + (f.h - 12) / 2 + 1);
      } else if (f.type === "preview") drawPreview(ctx, f);
    }
    const p = L.picker;
    if (p) {
      roundRect(ctx, p.area.x, p.area.y, p.area.w, p.area.h, 10);
      ctx.fillStyle = "rgba(12, 12, 22, 0.985)";
      ctx.fill();
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1;
      ctx.stroke();
      textBox(ctx, { ...p.search, text: p.query, editing: p.focused }, tr("type to search…"));
      chip(ctx, { ...p.done, text: tr("Done"), selected: true, color: "#4ade80" });
      ctx.fillStyle = "#94a3b8";
      ctx.font = "11px monospace";
      ctx.fillText(`${p.title} · ${p.count}`, p.search.x + p.search.w + 12, p.search.y + 9);
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.list.x, p.list.y, p.list.w, p.list.h);
      ctx.clip();
      for (const it of p.items) {
        roundRect(ctx, it.x, it.y, it.w, it.h, 5);
        ctx.fillStyle = it.selected ? "rgba(74,222,128,0.16)" : "rgba(255,255,255,0.04)";
        ctx.fill();
        ctx.strokeStyle = it.selected ? "#4ade80" : "#2e2e3e";
        ctx.stroke();
        ctx.fillStyle = it.selected ? "#bbf7d0" : "#cbd5e1";
        ctx.font = "11px monospace";
        ctx.fillText(fit(ctx, `${it.selected ? "✓ " : ""}${it.text}`, it.w - 10), it.x + 6, it.y + 6);
      }
      ctx.restore();
      if (p.pMax > 0) {
        const thumbH = Math.max(24, p.list.h * (p.list.h / p.pTotal));
        const thumbY = p.list.y + (p.list.h - thumbH) * (p.pScroll / p.pMax);
        roundRect(ctx, p.list.x + p.list.w - 4, thumbY, 4, thumbH, 2);
        ctx.fillStyle = "rgba(148, 163, 184, 0.5)";
        ctx.fill();
      }
    }
  }
  ctx.restore();
}
